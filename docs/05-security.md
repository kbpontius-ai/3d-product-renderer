# 05 — Security Design

Assume: invite-only B2B users, customer logos under NDA-ish expectations, supplier CAD that is
commercially sensitive, and a GPU render farm that costs real money per job. Those four facts
define the threat model.

**This document is the security design, and parts of it are not built.** The table below is what
the `2026.11.0` release actually does wherever the design goes further. Where the two disagree, the
table is right. The checklist at the end lists what is built and where each item is tested.

| Design says | Built in this release |
|---|---|
| Sessions in Redis + Postgres | PostgreSQL only. There is no Redis |
| CAPTCHA (Turnstile) after repeated failures | Not built. Rate limits and lockout only, kept in memory per process, so they reset on restart |
| 2FA, mandatory for staff | Not built. Staff sign in with a password only (`F-AUTH-09`, planned first after the release) |
| One policy module, `can(user, action, resource)` | Not built. Each route calls a guard itself: `requireStaff`, `requireOwner`, `requireTenant` or `getPrincipal` (`apps/web/lib/server/admin.ts`, `org.ts`, `auth.ts`) |
| CSRF double-submit token | Not built. `SameSite=Lax` cookies plus a strict `Origin` check (`assertSameOrigin`) on every state-changing request |
| HSTS with preload; COOP/CORP | HSTS without preload; COOP and CORP are not set |
| Separate origin for user content | Not built. Everything is served from the app's origin; originals download as attachments with `nosniff` and a sandbox CSP |
| Upload quarantine, a separate sanitiser sandbox, ClamAV, resvg | Not built. Sanitising and rasterising run as bounded TypeScript inside the web process (see "Current F-ART-12 boundary" below) |
| Workers with restricted egress and short-lived credentials | Not built. The render worker shares the Compose network and the storage volume with the web app |
| Private buckets, anti-scraping detection | Local disk only (no buckets); signed, short-lived, per-viewer asset URLs are built. No download-anomaly detection |
| Dependabot/Renovate, dependency audit, SBOM, SAST, ZAP | Not built. CI runs Gitleaks and TruffleHog on every pull request (`F-HARD-09`) |
| Secrets in a managed store | Secrets are in the operator's `deploy/.env`, which is never committed |
| Per-org retention, export and delete | Not built (`F-PLAT-06`, `F-HARD-04`) |
| Encryption at rest | The operator's disk; the app adds none |
| Pen test before the first external customers | Not done. The brief is [22-pentest-brief.md](22-pentest-brief.md) |
| CAD parser in a container with no network and nothing else | No network and no credentials, but it can still read the storage volume (`F-HARD-03`). The `cad` profile ships uncertified |

---

## Assets & threats

| Asset | Primary threats |
|---|---|
| Customer artwork (unreleased logos/packaging) | Cross-tenant leakage, public/guessable URLs, retention beyond need |
| Curated CAD models | Bulk scraping of catalog geometry, source STEP exfiltration |
| User accounts | Credential stuffing, invite-token theft, session hijack, enumeration |
| Render capacity | Cost-exhaustion abuse, queue starvation |
| Render workers | Malicious file input (SVG/font/image parsers), code execution via scene files |
| Design data | Tampering (IDOR), silent modification of approved designs |

---

## Authentication & account lifecycle

**Model:** invite-only. No self-serve signup, no public registration endpoint in v1.

1. **Invite** — staff/owner submits an email. Server generates a 256-bit random token, stores only
   `hash(token)` (SHA-256) with `org_id`, `role`, `expires_at` (7 days), `single_use`. The raw
   token exists only in the email link.
2. **Verification** — clicking the link proves mailbox control. Token is compared by hash,
   constant-time, and checked for expiry/consumption/org status.
3. **Password set** — minimum 12 characters, zxcvbn score ≥ 3, checked against a breached-password
   list (k-anonymity API or local bloom filter). Hashed with **argon2id** (tuned ≥ 64 MB memory,
   t=3, p=1; parameters versioned for future rehash-on-login).
4. **Consumption** — invite marked used atomically (single-use enforced in the DB, not in app logic),
   user activated, `email_verified_at` set, audit record written.

**Sessions:** opaque random session IDs stored server-side (Postgres; the design also had Redis), never JWTs holding
authorization claims. Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix, path `/`.
Idle timeout 14 days, absolute 30 days, rotation on privilege change. "Sign out everywhere"
deletes all sessions. Password reset revokes every session.

**Reset & resend:** identical token mechanics, 1-hour TTL, single-use, always returns the same
neutral response regardless of whether the address exists.

**Brute force & enumeration:** per-IP and per-account limits with exponential backoff; generic
failure messages; timing-equalized login path; CAPTCHA (Turnstile) after N failures (not built). Login,
invite-accept, reset-request, and upload endpoints all rate-limited independently.

**2FA (P1, not built):** TOTP with recovery codes; mandatory for `staff` accounts once built
(`F-AUTH-09`). **SSO (P2, not built):** OIDC/SAML.

---

## Authorization

- Every entity carries `org_id`. Every query is filtered by the session's org — enforced in a
  single data-access layer, plus **Postgres row-level security** as a second line so a missed
  filter fails closed.
- Roles: `staff` (internal, cross-org), `owner`, `member`. The design requires MFA for staff; it is
  not built yet (`F-AUTH-09`). The design also puts permission checks in one policy module
  (`can(user, action, resource)`); what is built is a guard called at the top of each route handler
  (`requireStaff`, `requireOwner`, `requireTenant`), with row-level security underneath.
- Object IDs are UUIDv7/ULID (non-sequential), but IDs are never treated as secrets — authorization
  is checked on every access (no IDOR-by-obscurity).
- Share links (P1) are capability tokens: hashed at rest, expiring, revocable, optionally
  password-protected, scoped to read-only rendering of one design.

---

## File upload security (the sharpest edge)

SVG is an XML/scripting format — treat every upload as hostile.

**Current F-ART-12 boundary:** the architectural controls below include planned isolation/scanning;
the built pipeline runs bounded pure TypeScript inline in the existing web service. Preparation
rejects active content, external dependencies, DTDs and unsupported appearance instead of showing
an altered original. The client never injects upload markup into its document: only regenerated
computed source is shown as an image, with numeric geometry overlays built by React. The server
validates a bounded recipe and recomputes output; client-supplied derived SVG is not authoritative.

Private `artwork-source/` originals/editable assets are denied by the generic asset endpoint,
even with a signed URL. Current-version original download uses session + tenant authorization,
`application/octet-stream`, attachment disposition, `nosniff`, sandbox CSP and `no-store`.
Selection controls cannot enable unsafe SVG features. Analysis saves no durable draft; successful
adoption alone retains source. RLS remains on the existing artwork tables, with additive all-or-none
source metadata. Preview has a separate per-account rate budget; save retains the upload budget.
See [29](29-artwork-preparation.md) for enforced complexity limits and unhappy paths.

**Pipeline controls**
1. **Pre-checks:** extension + declared MIME + magic-byte/content sniff; hard size cap (e.g. 5 MB);
   per-user upload rate limits.
2. **Quarantine:** upload goes to a quarantine prefix in a private bucket; nothing is served from
   it and nothing renders it until processed.
3. **Sanitize (server-side, authoritative):** parse with a hardened XML parser with **DTD/entity
   expansion disabled** (blocks XXE and billion-laughs). Remove `<script>`, `<foreignObject>`,
   event handler attributes (`on*`), `javascript:`/`data:` URLs in href/xlink, external
   references (remote images, fonts, stylesheets, `<use>` to external docs), embedded CSS with
   `@import`. Allow-list elements and attributes rather than deny-listing.
4. **Complexity limits:** max path count, node count, nesting depth, decompressed size; reject
   beyond limits to prevent CPU/memory exhaustion.
5. **Isolation:** sanitization, normalization, and rasterization run in a dedicated sandbox
   (separate container, non-root, read-only FS, seccomp, **no network egress**, CPU/RAM/time caps,
   one process per file). Rasterization uses **resvg** (memory-safe Rust) rather than a browser
   engine.
6. **Malware scan:** ClamAV on the raw upload for the file-store hygiene requirement.
7. **Output only:** downstream consumers receive derived, regenerated artifacts (PNG/EXR maps,
   contour data) plus a cleaned SVG — never the original bytes. The original is retained only for
   the user's re-download and is never fed to a renderer.
8. **Client preview** of raw SVG (if any) goes through DOMPurify **and** is rendered in a
   sandboxed context; the client sanitizer is defense-in-depth, never the boundary.

Same posture applies to P1 raster/AI/EPS/PDF conversion, which is riskier (Ghostscript history) —
keep it in its own sandbox with tighter limits and a separate blast radius.

---

## Render worker security

- The worker's only input is a **validated JSON job spec** (schema-checked, server-generated from
  a design snapshot). Users never supply Python, `.blend` files, shaders, or file paths.
- Blender runs with script auto-execution disabled; no user-controlled path is ever interpolated
  into a filesystem or shell argument. Asset references are resolved by ID through an allow-listed
  resolver.
- Workers run non-root in ephemeral containers with **egress restricted** to the object store and
  the job API; they hold narrowly-scoped, short-lived credentials (no bucket-wide write).
- Per-job wall-clock, memory, VRAM, and output-size caps; kill and quarantine on breach.
- Workers are stateless and recycled between jobs; scratch dirs wiped. Renderer/toolchain versions
  are pinned and recorded on every output.

---

## Asset protection (CAD IP)

- Source CAD (STEP/Parasolid) exists only in a private bucket reachable by the ingestion pipeline
  and render workers — never referenced by any client-facing endpoint.
- Clients receive decimated, compressed GLB LODs adequate for visual preview but not for tooling.
- All asset delivery via **short-lived signed URLs** (minutes), issued per authenticated user and
  logged; no public buckets, no permanent CDN URLs for product geometry.
- Anti-scraping: per-user download-rate anomaly detection on catalog assets; catalog geometry
  behind auth in every environment including staging.
- Acknowledge the limit honestly: anything rendered in a browser can be captured. Controls raise
  cost and create an audit trail; they don't make extraction impossible. Contractual terms carry
  the rest.

---

## Web application controls

- **CSP** with per-request nonces, `default-src 'self'`, no `unsafe-inline`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`; WASM allowed only from our origin.
- `Strict-Transport-Security` (preload), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera/mic/geo,
  COOP/CORP set; add COEP only where SharedArrayBuffer/WASM threads are actually needed.
- CSRF: SameSite cookies + double-submit token on state-changing requests; strict `Origin` check.
- User-generated content (renders, artwork downloads) served from a **separate origin/domain**
  with `Content-Disposition: attachment` where appropriate.
- Input validation with shared Zod schemas at every trust boundary; output encoding by default
  (React); no `dangerouslySetInnerHTML` for user content, ever.
- Dependency hygiene: lockfiles, Dependabot/Renovate, `npm audit`/Snyk gate in CI, SBOM per release.
- Secrets in a managed secret store (never in env files in the repo); rotation documented;
  pre-commit secret scanning + GitHub secret scanning enabled.

---

## Abuse, cost, and quotas

- Per-org and per-user quotas: renders/day, GPU-minutes/month, concurrent jobs, storage.
- Cost estimated **before** submit and enforced server-side (client estimates are advisory).
- Deduplicate identical job specs (hash) to avoid paying twice for the same image.
- Global circuit breaker: if spend velocity exceeds a threshold, queue new jobs and alert staff
  rather than auto-scaling into a large bill.
- Upload quotas and artwork-count limits per org.

---

## Privacy, retention, logging

- Data classification: artwork and designs = **customer confidential**; renders inherit that.
- Retention: configurable per org; default keep designs indefinitely, failed-job scratch 7 days,
  quarantine uploads 30 days. Deletion is a real delete of objects + DB rows (with versioned
  object-store cleanup), not a flag.
- Logs: structured, no PII beyond user ID and org ID; never log tokens, passwords, signed URLs, or
  artwork content. Log redaction tested.
- Warnings and errors are also stored in the database (`service_events`) for the staff status page.
  They are redacted by the logger before they are recorded, readable only by staff (row-level
  security), and pruned to 14 days / 20 000 rows. The same redaction rules therefore govern what
  reaches the database: a secret that would be `[redacted]` on stdout is `[redacted]` there too.
- **Audit log** (append-only) for auth events, invites/role changes, catalog publishing, asset
  downloads, share-link creation, and admin actions.
- Encryption: TLS 1.2+ everywhere, at-rest encryption on DB and buckets, per-org prefixes.
- GDPR-shaped basics: export and delete for a user/org on request; DPA-ready sub-processor list;
  email is the only PII we require.

---

## Secure SDLC

- Threat-model review whenever a new file format, a new external service, or a new trust boundary
  is introduced.
- Code review required; security-sensitive paths (auth, upload pipeline, signed URLs, worker spec
  handling) require a second reviewer.
- CI gates: SAST (CodeQL/Semgrep), dependency audit, secret scan, SVG fuzz corpus against the
  sanitizer, ZAP baseline against staging.
- Pen test before the first external customer cohort; re-test after v2 (bottles/boxes + sharing).
- Incident response: on-call rotation, documented severity levels, breach-notification path,
  session mass-revocation and token rotation runbooks, restore-from-backup drill each phase.

---

External testing is briefed separately in [22-pentest-brief.md](22-pentest-brief.md).

The CAD ingestion pipeline is built and is the most dangerous surface in the product: a large
native parser fed files from outside. Only staff can use it, and it is behind the optional `cad`
profile, which ships uncertified. Its threat model is in [23-cad-ingestion.md](23-cad-ingestion.md)
and its confinement in [deploy/cad-worker/README.md](../deploy/cad-worker/README.md). The parser has
no network and no credentials, and runs one process per job; it can still read the storage volume
(`F-HARD-03`). The checklist below predates it, and the later review of it is in
[36 section 8](36-self-host-readiness.md#security-findings-review).

## Security acceptance checklist (v1 exit)

Each line names where it is proven, because a checklist whose ticks are opinions is worth less than
no checklist at all.

- [x] No endpoint returns data outside the caller's org (verified by automated cross-tenant tests)
      — `apps/web/e2e/designs.spec.ts` opens a design, its artwork and its thumbnail as a second
      organisation and gets 404 for each; the asset route's ownership check is written as an
      allow-list of what is *shared*, so an unclassified prefix is refused rather than served.
- [x] RLS enabled and proven to block a deliberately un-filtered query
      — `packages/db/src/tenancy.integration.test.ts`, "refuses a deliberately unfiltered
      cross-tenant query". Every tenant table is `force row level security`, which binds the table
      owner too; that is why the backup scripts have to claim a staff context.
- [x] Invite/reset tokens: hashed, single-use, TTL-bounded, enumeration-safe (tested)
      — `packages/auth/src/tokens.ts` stores a SHA-256 hash and never the token;
      `auth.integration.test.ts` covers reuse, expiry and lockout recovery.
- [x] Password hashing argon2id with tuned parameters; breach check active
      — `packages/auth/src/password.ts` (`argon2id-v1`, versioned so hashes upgrade on next login);
      breach lookup is k-anonymous and switchable with `PASSWORD_BREACH_CHECK`.
- [x] SVG fuzz corpus passes with zero escapes; sandbox has no network egress (tested)
      — `packages/svg/src/fuzz.test.ts`: 39 hostile documents plus 600 deterministic mutations of
      them, each asserted inert on the *serialised* output — nothing executable, and nothing that
      names a remote resource, since a sanitiser that leaves a URL behind has arranged the egress
      it was supposed to prevent.
- [x] No source CAD reachable from any authenticated client route
      — packs may only declare assets the platform serves (glTF, web images), enforced in
      `checkPackInvariants` with an allow-list and tested against STEP, IGES, Parasolid, native CAD,
      archives and code. An allow-list rather than a deny-list, because the deny-list is wrong the
      day someone invents an extension. Separately, the `cad-source/` prefix the ingestion
      pipeline will write to is refused by the asset route by name — shut before it is built,
      so no later refactor can quietly make it servable.
- [x] All asset URLs signed and short-lived; no public buckets
      — `packages/auth/src/asset-urls.ts`; fifteen-minute expiry inside the signed material, bound
      to one viewer. The e2e case proves the three properties separately, including the one the
      tenancy check cannot: a colleague in the same organisation holding a live URL is refused.
      The local adapter serves through the app and has no bucket to make public.
- [x] CSP with nonces enforced (no `unsafe-inline`) in production
      — `apps/web/middleware.ts`. See the note below on `style-src-attr`, which is the one place
      inline is permitted and the reason is structural rather than convenience.
- [x] Rate limits active on auth, upload, and render endpoints
      — `packages/auth/src/rate-limit.ts` for sign-in and invitation acceptance,
      `apps/web/lib/server/limits.ts` for upload, render, thumbnail, pack and design writes.
- [x] Quotas + spend circuit breaker enforced server-side
      — `assertWithinQuota` in `packages/render-jobs/src/queue.ts`, holding a per-organisation
      advisory lock. Without that lock it did not hold: a burst of fifty concurrent submissions put
      thirteen jobs past a limit of ten, because every one of them read the count before any of them
      inserted. `saturation.integration.test.ts` is what found it and is what keeps it fixed.
- [x] Audit log covering auth, admin, and asset-access events
      — auth events in `packages/auth/src/service.ts`, admin and pack events via `recordAudit`, and
      `asset.downloaded` when a render original is fetched. Deliberately not every asset read: a
      gallery fetches a thumbnail per tile, and an audit log nobody can read is not an audit log.
- [x] Backup restore drill completed and documented
      — `pnpm backup:drill` restores into a scratch database and compares every table's row count
      and every stored file's digest against the live ones. Last run: 2922 rows and every file
      matched.

### Where inline is still allowed, and why

`style-src-attr 'unsafe-inline'`, and nothing else. React writes `style={{…}}` as a style
*attribute*, and attributes have no nonce mechanism — the choice is to permit inline style
attributes or to rewrite every dynamic style in the application into classes. `script-src` names a
nonce and `strict-dynamic` with no inline permitted at all, and `style-src` for stylesheets is
`'self'`. Splitting the two directives is what keeps the stylesheet rule strict; a single
`style-src 'unsafe-inline'` would have weakened both.

Three routes had to be moved off static rendering for this to be true rather than merely configured:
a nonce is a per-request value, and a page whose HTML is generated at build time carries script tags
no nonce ever reached. Under a policy naming a nonce those pages serve, paint, and then do nothing
when clicked — a failure that looks like success, which is why `auth.spec.ts` asserts every script
on a page carries the nonce the policy names, and then clicks something.

## Artwork viewer/editor (`F-ART-11`)

The gallery and expanded viewer display sanitised SVGs as `<img>` resources, never injected SVG
markup or an editable HTML document. SVG asset URLs remain signed for one viewer, session-protected
and tenant-checked. The edit API authorises through the current tenant, validates whole-artwork
parameters with Zod, loads the stored sanitised source itself and uses the existing ingestion
pipeline. Same-origin checks apply to upload/edit/rename/delete. Upload and edit share the existing
rate limit. Deleted and foreign artwork are unknown to metadata/edit callers. Shape versions remain
immutable; optimistic conflict checks prevent stale editors overwriting a newer shape.
