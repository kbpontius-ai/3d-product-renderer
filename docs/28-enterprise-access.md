# Enterprise access and transactional email

How people get accounts, and how the application talks to them when they are not looking at it.

Four features, in dependency order: a mail transport (`F-PLAT-09`), a render-ready email
(`F-REND-14`), bulk invitations (`F-AUTH-13`), and self-service access requests (`F-AUTH-12`).
Rows for all four are in [01-features.md](01-features.md).

## The state this starts from

**The application cannot send email.** `Mailer` is an interface with two implementations and
neither delivers anything:

| Implementation | Where | What it does |
|---|---|---|
| `devMailer` | `apps/web/lib/server/mailer.ts` | Keeps the last twenty messages in memory. Throws unless `DEV_TOOLING=true`. |
| `logMailer` | `packages/notifications/src/render.ts` | `log.info('mail not sent (no provider configured)')`. |

`AuthService.invite()` and the password reset both call `mailer.send(...)` already. So in a
deployment today, **an invitation is a log line and the invited person is never told**. That is not
a gap in the features below; it is a live defect in `F-AUTH-01`, and `F-PLAT-09` is what fixes it.

There is also no template renderer. `send({ to, template: 'invite', vars })` passes a template
*name* and a bag of variables, and nothing anywhere turns that pair into a subject, an HTML body
and a text body.

What is already built and does not need rebuilding:

- `AuthService.invite()` — token hashing, TTL, audit row, one live invitation per address per org
  (a partial unique index enforces it), revoke and resend.
- `notifyRenderFinished()` — writes the bell row, reads `users.notify_email`, and already calls
  `mailer.send({ template: 'render-ready', … })`. It deliberately swallows mailer failures so a mail
  outage cannot fail a render that already succeeded.
- PNG decode, downscale and encode — `@pr/artwork/png`, already used by the render worker to make
  the web-sized variant. **The email thumbnail needs no new image dependency.**
- Pre-tenant database access — `0002_system_context.sql` invented `app_is_system()` for exactly the
  "read a table before any organisation is known" problem that access requests have.
- The staff console — organization-scoped People under `/admin/orgs/[id]/people`; `/admin` retains email lookup and `/admin/users` redirects there. The Tenants group contains Organizations.

## Two constraints that shape the design

### A render email cannot link its own thumbnail

Asset URLs are signed per viewer with a short TTL (`assetUrl(key, viewerId)`, `F-PLAT-04`). An
`<img src>` pointing at one would be dead by the time anybody opened the mail, and making render
outputs publicly addressable to avoid that would undo the feature that made them private.

So the preview is a **CID attachment**, generated at send time from the existing web-sized output
and discarded. This suits the requirement — the thumbnail is never stored — but it means the
`Mailer` contract grows an attachments field, and that contract is shared with auth.

### "Request access" is an enumeration oracle if built naively

`F-AUTH-04` specifies enumeration-safe sign-in errors: the sign-in form will not tell you whether
an address has an account. A request-access form that answers "you already have an account" hands
back exactly what the sign-in form refuses to. The endpoint must answer identically for every
address, whether it is unknown, already a member, or already has a pending request.

## `F-PLAT-09` — Transactional email delivery

A `@pr/mail` package holding three things:

1. **A transport.** One `Mailer` implementation over an HTTPS provider API — Resend, posting to
   `https://api.resend.com/emails`. Not SMTP: outbound SMTP is blocked by default on most cloud
   hosts, and a hung SMTP connection is a worse failure than a failed HTTP request. Not the vendor
   SDK either: sending is one POST with a bearer token, so `fetch` does it with no dependency in the
   tree of both the web app and the render worker. The provider lives in one file behind the
   existing interface, so changing it later is a day rather than a migration.
2. **A template registry.** `{ template, vars } → { subject, html, text }`. Templates needed before
   anything else ships: `invite`, `password-reset`, `render-ready`, `render-failed`,
   `access-requested`, `access-approved`, `access-denied`.
3. **Attachments on the contract.** `send()` grows an optional `attachments: [{ cid, filename,
   contentType, bytes }]`, which `F-REND-14` needs and nothing else uses yet.

`devMailer` stays exactly as it is and stays wired into the e2e suite, so the tests never send real
mail and `DEV_TOOLING` keeps meaning what it means.

Keeping test runs off the provider takes two layers, because the first attempt at one was not
enough. The processes `scripts/e2e.sh` starts inherit the shell that started it, and a configured
key outranks `DEV_TOOLING`, so with a real key exported the suite's server and render worker sent
every `@example.com` invitation and reset to Resend — bounces against a domain with no reputation to
spare. So every real transport refuses reserved recipient domains (RFC 2606 and 6761:
`example.com/.net/.org`, `.test`, `.example`, `.invalid`, `.localhost`), which covers any process
that gets a key however it got it; and `e2e.sh` unsets the mail variables for everything it starts,
which keeps the suite on the development mailbox it reads messages back out of.

Operationally this also needs, and the deployment doc should say so: a sending subdomain, SPF, DKIM
and DMARC records, and a bounce/complaint webhook maintaining a suppression list. Sending
authenticated mail from the apex domain is how one bad month poisons every address the company
owns.

## `F-REND-14` — Render-ready email with a preview

Extends `notifyRenderFinished()` rather than replacing it.

**Content.** Design name, product and variant (the part the artwork was applied to), finished
timestamp, duration, output dimensions and format, and a link to the render in the gallery. All of
it is one join away: `render_jobs → design_versions → designs → product_variants → products`.

**Thumbnail.** Read the output's `web_storage_key` (falling back to `storage_key`), decode,
downscale to roughly 320px on the long edge with the existing helpers, attach by CID, discard.
Nothing new is written to object storage.

**When it sends.** On every completion, succeeded or failed — `EMAIL_AFTER_SECONDS = 90` goes away.
Cancellations still send nothing, on the existing reasoning that a cancellation was the person's own
decision and they do not need telling twice.

That change has a consequence worth stating plainly: somebody iterating on a design now gets one
email per render, and `users.notify_email` stops being a nicety and becomes the pressure valve. It
is a column with no user interface. **This feature includes surfacing it on the account page**, or
the only way to stop the mail is a database write.

## `F-AUTH-13` — Bulk invitation import

Staff paste or upload CSV: `email,role` with one organisation chosen for the batch, or
`email,role,org` per row.

The flow is **parse → validate → dry-run preview → confirm → send**. The preview is the point: every
row shows its outcome before anything is sent — new, already a member, live invitation exists,
malformed address, unknown org. Only then does the operator commit.

Re-running the same file is safe. The partial unique index on `invitations` already guarantees one
live invitation per address per org, so a repeat is reported rather than duplicated. A row that
fails does not abort the batch; the per-row report is the deliverable.

`AUTH_LIMITS` currently bounds invitation *acceptance*, not creation, because until now invitations
arrived one at a time from a human in a form. A batch of two hundred wants a deliberate staff-side
limit and a maximum batch size, both configurable for the same reason `AUTH_INVITE_ACCEPT_LIMIT` is.

## `F-AUTH-12` — Request access from the sign-in page

**Schema.** An `access_requests` table with no `org_id` — the requester has no tenant yet, and a
nullable tenant column on a table under `FORCE ROW LEVEL SECURITY` is a policy waiting to be got
wrong. Columns: id, email, optional note, status (`pending`/`approved`/`denied`), the staff user who
decided, timestamps. Insert is reachable only in system context; review only under
`app_is_staff()`. This follows `0002_system_context.sql` rather than inventing a second pattern.

**Public endpoint.** POST from the sign-in page, rate-limited per IP alongside the existing
`AUTH_LIMITS` entries, returning the same response for every address (see the enumeration note
above). Repeated requests for the same address collapse onto the pending row rather than stacking.

**Staff queue.** `/admin/access`, under Tenants in the section sidebar. Approving is a form that
picks the organisation and role, and then calls the existing `invite()` — so an approved requester
goes through exactly the same invitation flow as anyone invited directly. One code path, not a
parallel one. Denying records an optional note. Both write audit rows.

**Notifications.** The administration team is told a request arrived; the requester is told the
outcome. Whether the team notification is email, the in-app bell, or both is worth deciding when
the queue exists and somebody has watched it for a week.

## Order of work

1. **`F-PLAT-09`** — on its own, and first. It is independently valuable: it repairs invitation and
   reset mail, which are broken in production today.
2. **`F-REND-14`** — smallest of the three features, and the most visible.
3. **`F-AUTH-13`** — no new public surface, so no new attack surface.
4. **`F-AUTH-12`** — largest, and the only one adding an unauthenticated endpoint. Worth a security
   pass against [22-pentest-brief.md](22-pentest-brief.md) before it ships.

## Open questions

- ~~**Which provider.**~~ Resend, chosen for the free tier that covers development and a pilot and
  the gentlest paid step of the options compared. It is reached over `fetch` rather than its SDK, so
  `F-PLAT-09` added no dependency at all and changing provider is editing `packages/mail/src/resend.ts`.
- **Who hears about a new access request**, and through which channel.
- **Whether cancelled renders should email.** Currently they do not.
