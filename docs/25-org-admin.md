# 25 — Organisation administration

Scope for a self-service admin area an organisation's owner can use: who is in the organisation,
what each of them may do, and which products they may work on.

**Implementation status:** `/org` overview, People, member product access, Catalog and
Activity are built (`F-ORG-01..05`). Owner operations remain tenant-scoped and do not expose staff
permissions. Staff now work through organization header sections described in
[31-organization-workspace.md](31-organization-workspace.md). The remainder records the original
pre-implementation analysis and its rationale; findings below describe that historical baseline.

## The gap, precisely

Three findings from the code, and the whole plan follows from them.

**1. `/admin` is staff-only, and there is no other admin surface.**
`apps/web/app/admin/layout.tsx` answers `notFound()` to anyone whose role is not `staff` — the same
answer a stranger gets, so the console does not even admit to existing. An organisation's owner has
no page anywhere that lets them administer their own organisation.

**2. The policy layer already expects an owner-facing surface.**
`packages/auth/src/policy.ts` grants `owner` four actions today — `invite.create`, `invite.revoke`,
`member.remove`, `quota.read` — and nothing in the product exercises any of them through a UI. The
authorisation model is ahead of the interface, which is the good direction to be wrong in: this is
mostly building the surface for permissions that already exist and are already tested.

**3. Catalog access is per-organisation, and nothing is per-user.**
`pack_visibility` is `(pack_id, org_id)`. It is enforced in row-level security on `product_packs`,
not in a query someone remembered to filter — which is right, and which is also why "the products
*this user* may see" cannot be bolted on in the UI layer. It has to go into the policy or it is
decoration.

One piece of luck: `withTenant` already sets `app.user_id` on every transaction
(`packages/db/src/client.ts`), and **no SQL policy reads it yet**. The plumbing for per-user rules
exists and is unused, so this needs a function and a policy rather than a change to how every
request opens a transaction.

## What "CAD files" means here — the one decision to make first

The request says "manage the CAD files that are available for a given user". That reads two ways and
they are different projects. This document scopes **A** and treats **B** as a separate decision.

| | Reading | What it means | State |
|---|---|---|---|
| **A** | **Products in the catalog** | Which of the organisation's products a member may open and design on. The "CAD file" as the customer meets it: a closure, a carton, a bottle. | `pack_visibility` exists at org level; per-user does not |
| **B** | **Source STEP uploads** | The supplier's original file behind `cad_jobs.source_key`. | Deliberately unreachable: staff-only ingestion, and the asset route denies the `cad-source/` prefix **by name**. docs/23: "the customer's supplier's most valuable file and it never leaves the server." |

**Decided: A.** B is not an oversight to correct — it is a decision with a security rationale
behind it, and "let organisation members manage source CAD" is most of `F-ADM-12`
(customer-uploaded CAD, P2), which docs/23 flags as needing its own project and its own review
because it points the most dangerous parser in the system at a wider audience. If B is what is
wanted, it should be scoped against that section rather than folded in here.

## Shape

A new area at `/org`, for owners, beside the existing staff console rather than inside it.

**Not a role check inside `/admin`.** The staff console is cross-tenant by construction: its people
page lists every account in every organisation, its packs page publishes globally. Letting an owner
in behind a role check means every page under it has to be re-audited for "what does this look like
to someone who may only see one organisation", forever, including pages added later. A separate
route with its own layout guard has one rule — *your organisation, and only yours* — and the RLS
underneath it enforces the same rule a second time.

```
/org                     Overview: seats, quota use this period, recent activity
/org/people              Members: invite, resend, revoke, suspend, reinstate, change role
/org/people/[id]         One member: status, role, product access, recent designs
/org/catalog             Products the organisation has, and who may use each
/org/activity            The audit trail, filtered to this organisation
```

## Features

Proposed IDs, to be added to section M of [01-features.md](01-features.md) before any code.

| ID | Feature | Pri | What it is |
|---|---|---|---|
| `F-ORG-01` | Owner admin shell | P0 | `/org` layout, guarded to `owner` (and `staff` impersonating), tenant-scoped everywhere. |
| `F-ORG-02` | Member management | P0 | Invite, resend, revoke, suspend, reinstate, change role. Deliberately **no delete** — suspension covers locking someone out, and it is reversible. Deleting stays staff-only. |
| `F-ORG-03` | Per-user product access | P0 | Grant or withhold each of the organisation's products per member. Enforced in RLS, not in the UI. |
| `F-ORG-04` | Organisation overview | P1 | Seats used, renders this period against quota, storage. Read-only: quota *writes* stay staff-only, as `policy.ts` already says. |
| `F-ORG-05` | Organisation audit trail | P1 | The existing `audit_log`, filtered to this organisation and readable by its owner. |
| `F-ORG-06` | Access presets | P2 | Named bundles of products ("Closures", "Everything") so a 40-person organisation is not 40 checklists. |

## Per-user product access — the only new concept

Everything else on that list is a surface over machinery that exists. This is not.

### The rule

A member may use a product when their organisation may use it **and** they have not been excluded
from it. Deny-by-exception rather than grant-by-enumeration, for one reason: a new product added to
an organisation should reach the people who work there without an administrator having to re-grant
it to each of them one at a time. Silence means yes.

That single decision is worth arguing about before it is built, because the opposite choice —
grant-by-enumeration — is what a compliance-minded buyer will expect, and switching later is a
migration rather than a flag.

```sql
-- Only rows that take something away. An organisation with no rows behaves exactly as it does now.
create table user_pack_denials (
  user_id uuid not null references users (id) on delete cascade,
  pack_id uuid not null references product_packs (id) on delete cascade,
  denied_by uuid references users (id),
  denied_at timestamptz not null default now(),
  primary key (user_id, pack_id)
);
create index user_pack_denials_pack_idx on user_pack_denials (pack_id);
```

### Enforcement

In the policy, extending the one that already exists rather than adding a second one beside it:

```sql
create or replace function app_current_user() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- product_packs_visible, with one more clause:
--   ... and not exists (
--     select 1 from user_pack_denials d
--     where d.pack_id = product_packs.id and d.user_id = app_current_user()
--   )
```

Staff keep seeing everything. A transaction with no `app.user_id` — the render worker, the CAD
worker, anything running as `withSystem` — denies nothing, because a denial is a statement about a
person and those transactions have no person in them.

### What it does *not* do

Access controls what a member may **start**, not what already exists. Removing a product from a
member does not delete or hide designs already made on it, and does not stop a render already
queued. Any other choice destroys work as a side effect of an administrative click, and the tool for
"this person should not be here at all" is suspension, which is a different control and already
exists. The member page should say so plainly where it lists what a revocation will affect.

## Reuse

Most of this is assembly rather than invention:

| Need | Already there |
|---|---|
| Invite, resend, revoke | `packages/auth` invitations + `/api/admin/invitations` |
| Suspend and reinstate, with session revocation | `packages/admin/src/users.ts` `setUserStatus`, enforced again at sign-in by `packages/auth/src/service.ts` |
| Role change, remove, last-owner guard | `packages/admin/src/users.ts` — including `assertNotLastOwner` |
| Quota figures | `packages/admin/src/orgs.ts` |
| Audit writes and reads | `packages/admin/src/audit.ts` |
| Tenant isolation | `withTenant`, and RLS underneath it |

The genuinely new code is the `/org` routes, `user_pack_denials` and its policy clause, and an
`@pr/admin` module for reading and writing access.

## Security

This adds the first non-staff administrative surface in the product, so the questions are new even
though the mechanisms are not.

- **Privilege escalation.** An owner must not be able to make themselves or anyone else `staff`.
  `setStaff` already refuses for non-staff actors; the `/org` role control offers `owner` and
  `member` only, and the API rejects anything else rather than trusting the form.
- **The last owner.** `assertNotLastOwner` exists and must be on this path too — an owner
  demoting or removing themselves is now reachable in one click, which it was not before.
- **Cross-tenant reads.** Every `/org` query runs in `withTenant`. The test that matters is the one
  that asserts an owner of A gets nothing for a member of B — by id, directly, not through the UI.
- **Audit.** Every write is audited with the actor, as staff writes already are. An access change is
  exactly the kind of thing someone asks about six months later.
- **Enumeration.** `/org/people/[id]` for a member of another organisation answers 404, not 403.
- **Denial is not deletion.** Covered above, and worth a line in the security checklist too.

## Build order

1. `F-ORG-01` — the shell and its guard, with the cross-tenant tests written first.
2. `F-ORG-02` — member management, which is mostly wiring existing functions to a new surface.
3. `F-ORG-03` — the migration, the policy clause, and the RLS tests, before any UI for it.
4. `F-ORG-03` UI — per-member access on the member page and per-product on the catalog page.
5. `F-ORG-04`, `F-ORG-05` — overview and audit.
6. `F-ORG-06` — presets, once there is a real organisation big enough to want them.

Steps 1–4 are the request as stated. 5 and 6 are what makes it usable by somebody who is not the
person who built it.

## Decisions taken

**Deny by exception, not grant by enumeration.** A member may use everything their organisation
may, unless a row says otherwise. A product added to the organisation reaches everybody who works
there without anyone re-granting it forty times. Recorded because reversing it later is a migration
and not a flag.

**Members do not get `/org` at all.** Not read-only, not a members list. `/org` is `owner` and
`staff` only, and everyone else gets the same `notFound()` the staff console gives.

**No staff impersonation.** Support acting as an owner is a bigger feature than this needs, with its
own audit and consent questions. Staff already see everything through `/admin`.

**Suspension is the lock-out mechanism, and it already exists.** See below.

**"CAD files" means catalog products.** What a member picks from `/catalog` to start a design on —
the closure, the carton — not the supplier's STEP file behind it. Source CAD stays staff-only and
denied by prefix, as `F-ADM-12` and docs/23 intend.

**Owners cannot delete members.** Only suspend and reinstate. Suspension already locks the account
out of both doors and leaves every design intact, so it covers the need without putting an
irreversible action behind a single click in a surface that has never existed before. `deleteUser`
stays staff-only, and the question of whether deletion should also destroy the person's designs
stays open — unanswered, and now unblocking.

## Two mechanisms that are easy to confuse

They answer different questions and this document needs both:

| | Suspend a member | Withhold a product |
|---|---|---|
| Question it answers | May this person use the product at all? | Which products may this person work on? |
| Effect | Cannot sign in. Live sessions are revoked immediately. | Signs in normally; that product is not in their catalog. |
| Their work | Untouched. Designs, artwork and renders all survive. | Untouched. Existing designs on that product still open. |
| Reversible | Yes — reactivate and everything is as it was. | Yes — delete the row. |
| State | **Built.** `users.status`, staff-only. | **New.** `F-ORG-03`. |

### Suspension is already built, and already correct

Nothing needs designing here — it needs a surface. `packages/admin/src/users.ts` `setUserStatus`
already:

- flips `users.status` between `active` and `suspended`, and
- **revokes every live session** in the same transaction, so suspension takes effect immediately
  rather than whenever a cookie happens to expire, and
- refuses to suspend the last active owner (`assertNotLastOwner`), and
- audits the change with the actor.

Sign-in enforces it independently: `packages/auth/src/service.ts` admits a credential only when
`user.status === 'active'` *and* the organisation is active, and resolves a session the same way. So
a suspended account is locked out at both doors, not just the one.

Reactivating restores access with everything intact. `F-ORG-02` exposes this to owners; it does not
reimplement it.

### What deletion does today, which may not be what you expect

`deleteUser` does **not** destroy the person's work. Every "who made this" column that points at a
person — designs, design versions, artworks, render and CAD jobs, packs, invitations — is
`on delete set null` (migration `0010`), so deleting the user row keeps the work and loses only the
attribution. Only the account itself goes. (It used to null a hand-kept list of columns first, and
the list had missed `design_versions`: deleting anybody who had ever saved a design failed with a
foreign-key error. A test now asserts that no reference to `users` can block a delete.)

That is a defensible default (an organisation paid for that work) but it is not the only reading of
"deleted", and it is worth confirming before `/org` puts a delete button in an owner's hands. If
deletion should also remove the person's designs, that is a separate feature with its own
confirmation flow — and a hard one to take back.

## What the build added to this plan

**Invitations run through the existing service, with the organisation taken from the session.**
`/api/admin/invitations` accepts an `orgId` in the body because staff genuinely invite into
organisations they are not in; an owner inviting into somebody else's is the whole attack, so
`/api/org/invitations` simply has no such parameter. Resend is inviting the same address again with
the role it was first invited with, which revokes the previous link — one live invitation per
address, always — and it refuses an address with nothing outstanding, so it can never quietly invite
somebody new. Revoke kills the link and removes the placeholder "invited" account, audited as
`invite.revoked`. Both appear on an invited person's row, on the staff organisation page and on the
owner's People page.

**The inviter never sees the link outside development.** Accepting an invitation is what proves the
invitee controls the mailbox (`F-AUTH-02`); an inviter who can read the link can accept for them. The
routes return it only when development tooling is on. The form says "Invitation emailed" only when
the mailer reports that it went, and otherwise "created, but no email was sent" and why — no
provider, a reserved test address, kept in the development mailbox, or refused by the provider.

**The access checkbox is optimistic.** Bound straight to its props it was a controlled input whose
value could only change after a round trip and a refresh, so it visibly snapped back and stayed
wrong for as long as the request took. `useOptimistic` moves it on click and reverts it by itself if
the server refuses, which needs no bookkeeping and cannot drift.

**`AUTH_INVITE_ACCEPT_LIMIT` is now an environment variable.** Accepting an invitation was capped at
ten per ten minutes per IP, and the e2e suite legitimately accepts about a dozen a run from one
machine — so adding this area's tests broke `designs.spec.ts` rather than themselves. The knob is not
a test fixture: ten is right for users arriving from their own connections and wrong for a
deployment behind a single corporate NAT, where a team onboarding together shares one address and
the eleventh person is told to come back later. The default is unchanged.

## Open questions

One, and it blocks nothing here.

**Should deleting a member also delete their designs?** Today `deleteUser` keeps the work and drops
the attribution — it nulls `created_by` and removes the account. Owners do not get a delete button
in `/org` at all, so this only matters to the staff console, and it can be answered whenever
somebody actually needs to delete somebody.

## What "remove a member" means without delete

Worth being explicit, because "remove" is the word people reach for and it is not on offer:

| The owner wants | They do this | Result |
|---|---|---|
| This person has left the company | Suspend | Cannot sign in, sessions killed, work preserved |
| They came back | Reinstate | Signs in again, everything as it was |
| They should not work on the bottle line | Withhold that product | Signs in, that product is gone from their catalog |
| Erase them entirely | Ask staff | `/admin` retains `deleteUser`, with its last-owner guard |
