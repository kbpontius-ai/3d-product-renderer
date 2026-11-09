# 36 — Self-hosted application readiness

Status: **Draft for review — implementation is not authorized by this document.**
Feature: `F-GEN-08`.

## 1. Outcome and scope

A third party can deploy its own copy of the application, create its own organizations and
accounts, import its own products and artwork, and operate and upgrade the installation without
editing application source or relying on the original maintainer's machine, accounts or services.
Each installation owns its database, persistent assets, credentials and domain. It has no automatic
connection to the original installation and no shared customer data.

Confirmed scope: the complete self-hosted application. SDKs, package publication, an embeddable
widget and a public integration API are deferred. Keep existing package boundaries; do not build
new abstractions for those possible future uses.

Initial support target: the existing single-server Docker Compose deployment on Ubuntu 24.04 LTS,
x86_64, with Docker Engine and the Compose plugin: PostgreSQL, Caddy HTTPS, local shared storage,
web app and CPU render worker. CAD remains an optional profile. This extends the existing deployment model, rather than introducing another.
Publish the exact tested OS, CPU architecture, container engine and toolchain versions with the
release. Do not imply support for untested hosts or hardware from development-machine success.

## 2. Users and trust boundaries

| Actor | Responsibility and access |
| --- | --- |
| Installation operator | Owns the host, database, storage, backups, domain and deployment secrets; can bootstrap and recover administrators. |
| Staff administrator | Operates the installation across organizations; manages products, CAD ingestion, people and quotas using existing staff controls. |
| Organization owner | Manages people and product access within the permissions already provided by the application. |
| Member | Works with permitted products, organization artwork, designs and renders. |

Staff access is intentionally cross-organization. An organization owner is not automatically staff.
Customer CAD goes through a staff administrator in this release. Do not grant staff privileges to
ordinary members to bypass that boundary. Organization-controlled CAD submission is a separate
permissions and security proposal if requested later.

Hosting multiple organizations does not hide their data from the installation operator. Document
this trust model and prove isolation between ordinary organization accounts. Product packs may be
shared or access-restricted according to the existing catalog policy; test both cases explicitly.

## 3. Current baseline and gaps

These are findings from code and documentation review, not a fresh deployment certification.

| Area | Existing foundation | Readiness gap |
| --- | --- | --- |
| Deployment | Compose services, environment template, TLS, migration service, health endpoint | Validate the complete release on a clean Linux host, including real worker jobs. |
| Setup | `scripts/seed-dev.ts`, organization and invitation services | Bootstrap hardcodes `Demo Organisation` / `demo`; production setup must accept installation-specific inputs and be safe to repeat. |
| Identity | Invitations, sessions, staff/owner/member policies, organization administration | Document actual role capabilities; distinguish planned MFA/SSO from implemented controls. |
| Isolation | Tenant transactions, RLS, authorized asset access | Repeat negative tests with an ordinary database role, signed asset URLs and background jobs. |
| Email | Environment-driven Resend transport | Compose does not pass the documented email variables to the application services. |
| Storage | Local adapter, backup/restore scripts and drill | Prove consistent database-plus-assets recovery; document growth, retention and deletion limitations. |
| CAD | OCCT integration, importer validation, Linux sandbox controls | Production must force the real importer; parser filesystem confinement and CAD image verification remain backlog items (`F-HARD-03`, `F-HARD-07`). |
| Materials | Approved Matte and Glossy palette | Preserve current behavior; audit historical cleanup migrations and protect future installation-specific data. |
| Distribution | Shared source repository and workspace packages | Reuse terms, distributable assets, release artifacts and maintenance policy need decisions. |
| Documentation | Setup, deployment, security and feature documents | Several documents mix intended and built behavior; deployment guidance still assumes automatic CI. |

## 4. Required readiness work

All requirements below are unverified until their acceptance evidence is recorded. Existing feature
IDs remain authoritative; this document defines the distribution acceptance for `F-GEN-08`.

### R-01 — Shareable source and permitted assets

- Decide private collaboration versus public distribution and establish explicit reuse terms before
  inviting third-party adoption. Public visibility is not itself a reuse license.
- Review source, tracked assets and reachable Git history for secrets, private data, customer
  artwork, supplier CAD and redistribution restrictions. Record findings without exposing values.
- Inventory runtime dependencies, fonts and bundled assets; include required notices with the
  distributed source/images. Review CAD and renderer dependencies as well as JavaScript packages.
- Ship only permitted synthetic examples. Never copy the running installation's database, object
  store, environment files, logs, accounts or generated customer outputs into a release.
- If anything sensitive is found, stop for a remediation decision. Rotate exposed credentials;
  real-data deletion needs separate approval.
- Committed documentation does not refer to development tooling, branches or sessions.
- The application ships no product content. A fresh installation's catalog, CAD imports and packs
  are empty; operators add their own through the existing upload paths (`/admin/cad`,
  `/admin/packs`, `pnpm import:pack`) into the configured storage. No new content directories are
  added. Generated working output and CAD sources (`output/`, `*.blend`, `*.step`) are ignored.
- A minimal synthetic test fixture set stays tracked, generated from code and used only by tests.
  It is never copied into an image and never imported into an installation by default; the local
  setup script imports sample packs only when explicitly asked to.

Acceptance: a reviewed file/asset inventory, documented reuse decision and a clean release-content
scan. This spec does not certify licensing compliance or authorize making the repository public.

### R-02 — Production bootstrap and configuration

- Extend the existing setup path into a production-safe command using organization name, slug and
  administrator email. Preserve the development setup use case; avoid a second account-creation
  implementation. Final command syntax is part of the implementation plan.
- Re-running setup must not duplicate organizations, reset credentials, promote unrelated users,
  change existing data or overwrite secrets. Conflicts must explain the resolution; no implicit
  takeover of an existing account or organization.
- Bootstrap must work from the actual built container, including its working directory, copied
  scripts and installed executable paths; do not assume the developer shell or a cached package
  manager is available. Report the one-time invitation securely, outside ordinary service logs.
- Require explicit production URL and shared signing secret. Validate required values and enabled
  feature configuration before accepting traffic/jobs; never print secrets in diagnostics.
- Keep sample packs optional. An empty catalog must guide staff to product setup and members to
  their administrator without depending on demo data.
- Wire the existing email settings through Compose for every service that sends mail. Validate
  invitations, resets and render notifications against the configured sender and application URL.
  Partial mail configuration must give an actionable error. A deliberately mail-disabled mode
  must be explicit in operator instructions, including manual invitation and recovery limitations.
- Separate operator configuration from application data. Keep deployer-specific credentials,
  domain, organization identity and sender settings out of tracked source.

Acceptance: a fresh instance contains only the intended organization and accounts; repeat setup
leaves them intact. Configuration failures are understandable. A recipient can accept a real
invitation, reset a password and receive a render-ready notification in the mail-enabled release.

### R-03 — Authorization and confidential data

- Verify the documented role matrix against actual routes and services, including owner/member
  restrictions on staff tools, original SVG downloads, CAD sources, restricted products and jobs.
- Run tenant isolation tests as a non-superuser without `BYPASSRLS`; explicitly assert those role
  properties. Test reused pooled connections, direct IDs, asset URLs and revoked/suspended access.
- Demonstrate that organization A cannot read, mutate, render or download private resources from
  B. A's job must not resolve B's private inputs. Intentional staff access must remain attributable.
- Disable development tooling in the supported production configuration. Review production
  authentication, session handling, upload limits and rate controls against what is actually built.
- Record security gaps and deployment consequences. Planned MFA, SSO, scanning or sandboxing
  must not be presented as implemented. MFA/SSO implementation is not implied by this spec;
  unresolved findings require an explicit release decision.

Acceptance: automated negative tests plus a live two-organization walkthrough, and a reviewed
security findings list with no unresolved release-blocking leakage or privilege escalation.

### R-04 — Complete application and optional CAD support

- Verify an actual imported Product Pack through publication, artwork preparation, placement,
  autosave/reopen, viewer thumbnail capture and a queued Blender render. Inspect actual frames,
  including separate body/relief finishes, orientation and current-viewer lighting.
- Preserve supported SVG preparation behavior and the separate, explicitly applied Repair paths
  mode. Unsupported inputs return understandable errors and re-export guidance.
- Publish exact supported CAD/SVG formats, complexity/size limits, import states and operator
  troubleshooting. Do not promise STEP export or manufacturing suitability of visualization meshes.
- CAD-enabled production must use `CAD_IMPORTER=occt` and `CAD_SANDBOX=require`; missing kernel
  or isolation must prevent CAD processing rather than fall back to stand-in geometry.
- Build and boot the CAD image under the advertised Compose profile. Verify non-root access to
  shared output storage and writable scratch with cleanup after success/failure and restart.
- Resolve the parser's access to unrelated tenant assets/application files before certifying the
  CAD-enabled profile. Test filesystem/network confinement and resource ceilings on the target
  host, not only a subprocess wrapper. Choose the specific confinement fix in a separate reviewed
  implementation plan; do not weaken the sandbox to obtain a passing startup.
- Never silently heal source CAD or generated geometry. Validation should identify the failing
  stage and preserve the original so users can correct it in suitable CAD software.

Acceptance: a real synthetic STEP import produces the expected geometry and dimensions, proceeds
through zone/orientation setup, publication and rendering, and representative invalid/unsupported
files fail clearly. Core application readiness can be recorded with CAD disabled, but the release
must not claim CAD support until the additional checks pass. Shipping that reduced scope needs
maintainer agreement because third-party CAD is part of the intended workflow.

### R-05 — Safe upgrades and product defaults

- Publish a versioned release from a reviewed, committed revision; record image/build identifiers,
  toolchain versions, database migration level and supported upgrade source versions. Do not make
  production deployment depend on whatever is currently at the tip of `main`.
- Keep web and both workers on compatible revisions. Define draining/stopping active work,
  migration order, restart and verification steps so old processes do not consume incompatible jobs.
- Preserve the approved Matte/Glossy palette and all existing CSS themes. The product name and logo
  ship as they are; making them installation settings in Admin is backlogged as `F-GEN-13`, and an
  uploaded logo must pass the existing SVG sanitizer. Full white-label theming (`F-GEN-06`) and
  arbitrary material-library expansion are deferred.
- Audit migration `0013_pp_material_cleanup.sql`: it intentionally rewrites material references in
  saved versions and packs and deletes other materials. Document that historical behavior and test
  the supported upgrade paths. Do not silently edit already-applied migrations or undo this cleanup.
- Future upgrades must not repeat installation-specific content cleanup or replace customers'
  custom records with sample/default data. Any intentional destructive conversion requires a
  reviewed migration, release note and recovery plan.
- Migrations are forward-only in the existing system. Recovery may require restoring the matching
  previous application release, database and assets together; do not promise an image-only rollback.

Acceptance: upgrade a populated prior supported release, then reopen designs and inspect assets
and renders; verify expected preservation and explicitly documented conversions. Repeat deployment
without new changes. Exercise recovery into an isolated target rather than the live installation.

### R-06 — Operations and data lifecycle

- Prove backups cover database and object storage consistently; document how writes/workers are
  quiesced or snapshots coordinated. Keep copies outside the application host and protect them.
- Restore into an empty target; verify authentication, row counts, file digests, designs and one
  render. Document backup frequency, retention and the recovery time actually measured.
- Document logs, request/job identifiers, worker liveness, queue failures, storage growth, disk-full
  behavior and recovery actions. An HTTP health response alone does not certify working workers.
  Do not describe Docker's unhealthy status as an automatic restart mechanism.
- Set and verify practical render/CAD concurrency and resource limits on the tested hardware.
  Publish measured sample costs/times rather than a universal performance promise.
- State source-CAD/original-SVG retention, backup retention and deletion/export limitations. Existing
  org export/hard-delete and CAD-source lifecycle gaps (`F-PLAT-06`, `F-HARD-04`) remain explicit.
  A manual procedure is acceptable only if tested and limited to what it can reliably delete/export;
  do not promise complete organization erasure from active storage or backups without evidence.

Acceptance: recorded restart, worker interruption, backup and restore drills, actionable operational
instructions and an accurate data-lifecycle statement. Retention-policy values remain operator
choices rather than hardcoded assumptions introduced by this spec.

### R-07 — Documentation and release validation

- Provide one primary quickstart from obtaining a tagged release to first sign-in, own-product
  setup and first render. State prerequisites, DNS/TLS setup, supported hardware, expected downtime,
  persistent volumes and recurring costs. Test every command from its documented directory.
- Reconcile README, deployment, security, architecture, conventions, testing and feature inventory
  against the running release. Label proposals/historical rationale rather than implying support.
- CI runs on every pull request, using the `pull_request` trigger (never `pull_request_target`) so
  fork code gets no repository secrets. It includes secret scanning with Gitleaks and TruffleHog
  (`F-HARD-09`); GitHub secret scanning with push protection is enabled on the public repository.
  Local checks are still required before a change is offered. Publishing repositories, images or
  tags is a separate action.
- Run required local unit/integration, type, lint and env checks; production builds; relevant browser
  workflows; preview-frame inspection and preview/Cycles parity; and actual Compose builds/boots.
  Include the optional CAD profile when claiming CAD support. Resolve failures before readiness;
  skips and unavailable checks are not passing evidence.
- Publish the security-reporting route ([SECURITY.md](../SECURITY.md)), the release policy in
  section 7 and a known-limitations page.

Acceptance: an operator unfamiliar with the code completes the documented workflow on a clean
host without source changes or undocumented help. Record problems and rerun corrected steps.

### R-08 — Public repository

The public repository starts from one reviewed snapshot of the source. Its settings are `F-GEN-14`.

Acceptance: both secret scanners report clean on the published source, and push protection is on.

## 5. Execution sequence and review points

| Stage | Work and deliverable | Exit condition |
| --- | --- | --- |
| 1 — Inventory | Release-content/licensing review, dependency/asset inventory, current test baseline, supported deployment decisions | Maintainer reviews sharing terms, platform and findings. |
| 2 — Installation | Reviewed bootstrap/configuration/email changes and production quickstart | Empty and repeat-install checks pass using built containers and real email. |
| 3 — Boundaries | Authorization/isolation checks and reviewed CAD confinement work | Two-org tests pass; CAD profile passes its additional gate or remains explicitly uncertified. |
| 4 — Operations | Upgrade, backup/restore, liveness/resource checks and accurate runbooks | Populated upgrade and recovery drills pass; data consequences are documented. |
| 5 — Rehearsal | Full local release checks and independent clean-host walkthrough | Evidence and spec-to-implementation review complete; maintainer decides release. |

Each implementation stage gets a concrete file-level plan and approval before code changes.
Reuse existing services/interfaces. Separate bootstrap, deployment wiring, CAD security and unrelated
bug fixes into reviewable concerns. Investigate existing test failures before using the suite as a
release gate; do not silently waive them or fold unrelated fixes into this planning change.

Likely implementation touchpoints: `scripts/seed-dev.ts` and setup scripts, `deploy/compose.yaml`,
environment templates, existing auth/admin services, CAD sandbox/container code, migrations and
upgrade fixtures, deployment/test scripts, and the affected runbooks. These are a planning map,
not authorization to edit all of them.

## 6. Failure scenarios to exercise

| Scenario | Required outcome |
| --- | --- |
| Bad URL, DNS/TLS failure, missing secret, partial email settings | Name the failed prerequisite/configuration without disclosing credentials; no misleading successful setup. |
| Bootstrap rerun, existing email/slug, interrupted setup | Preserve existing data; safe retry or explicit conflict and recovery guidance. |
| No products, missing CAD worker or unavailable renderer | Clear next action for the permitted actor; no stand-in geometry presented as an import. |
| Wrong database privileges or cross-org ID/asset access | Deployment/test gate rejects unsafe privileges; requests cannot access another organization's private data. |
| Host lacks CAD confinement or parser can read another tenant's assets | CAD support gate fails; never enable unconfined production parsing. |
| Unsupported SVG/CAD, incorrect units, excessive complexity | Understandable refusal or explicit dimension review; original retained according to policy; no silent repair. |
| Worker stops mid-job, disk fills, resource limit exceeded | Bounded failure/retry behavior, useful diagnostics and no half-published product/render. |
| Upgrade fails with live/queued jobs or migration partially progresses | Stop rollout; use documented compatible recovery; retain original data and evidence. |
| Backup lacks assets or contains mismatched data | Restore drill detects the mismatch; do not report the backup as usable. |
| Operator requests complete org erasure | Explain current coverage and backup consequences; no claim of complete erasure without a verified workflow. |

## 7. Deferred work and decisions

Deferred: SDKs/npm publishing, headless API/API keys, embedding, managed multi-customer hosting,
Kubernetes, object storage, distributed/GPU rendering, rolling deployment, self-service signup,
owner/member CAD ingestion, full white-label theming and additional material presets. Each adds a
separate product or operations contract and is unnecessary to validate the first self-hosted release.
Existing accessibility and closure-liner backlog decisions remain unchanged.

Decided: public distribution as source (R-08); no shipped product
content; CSS themes kept, with the product name and logo as a backlogged Admin setting (`F-GEN-13`);
CI on every pull request with secret scanning (`F-HARD-09`); a minimal synthetic test fixture set
stays tracked; public repository settings are tracked as `F-GEN-14`.

Decided:

- **License:** MIT, copyright `kbpontius`. The code is solely the maintainer's.
- **Distribution:** source only. Operators build the images from the Dockerfiles; no images are
  published.
- **Supported host:** Ubuntu 24.04 LTS on x86_64, with Docker Engine and the Compose plugin.
- **Releases:** CalVer as `YYYY.MM.PATCH`, for example `2026.11.0`, published as a Git tag and a
  GitHub Release. No schedule. The version doesn't signal upgrade risk, so release notes state any
  operator action, such as a new setting or a migration.
- **Support:** none offered. Issues are open, but replies aren't promised.
- **Security reports:** welcome through GitHub private reporting, with no commitment to respond or
  fix. Operators own their installation's security and patching.
- **Email:** Resend only, with each operator's own account and verified domain. Running without
  email stays a documented mode with manual invitations and recovery (R-02).
- **Retention and backups:** operator choices (R-06).

Security findings were reviewed for the release (section 8). Decided: the first
release ships with the `cad` profile marked uncertified and without staff two-factor, and the
review's fixes and missing tests go to the backlog rather than into the release.

Also decided: the release ships without the production setup command
and without a clean-server run-through. Both are the first work after it, with detailed steps in
[38-first-work-after-release.md](38-first-work-after-release.md) (`F-SHIP-11` to `F-SHIP-13`). The
Compose email wiring was pulled into the release, because without it a Compose install could invite
nobody past its first account. For R-07, the release adds [QUICKSTART.md](../QUICKSTART.md),
[KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md) and [RELEASE-NOTES.md](../RELEASE-NOTES.md), and
reconciles the README, 05, 06 and 27 with what is built.

The selected scope is approved; this draft's implementation details and release decisions await review.

## 8. Evidence record

| Check | Status |
| --- | --- |
| Read-only review of merged deployment, setup, permissions, storage, material migration and docs | Completed; not a security audit. |
| Draft and feature/docs index consistency | Checked: all seven requirement sections, new index links and whitespace. A broader link check found a pre-existing `Placement.md` link in the feature inventory; unchanged here and queued for R-07 documentation reconciliation. |
| Fresh host/container deployment, real mail, isolation walkthrough, CAD profile, upgrades and restores | Not run for this specification. |
| Application tests/builds/parity checks | Not rerun for this documentation-only change; existing failures must be resolved during release preparation. |
| Release documents (R-07) | Written for the release: quickstart, known limitations, release notes, and the README, 05, 06 and 27 reconciled against the code. Commands were checked against the Dockerfiles and compose file, not run on a server: that is `F-SHIP-13`. `docker compose config` parses with the new email settings; nothing was built or booted. |
| Security findings review (`F-HARD-08`, R-03) | Done from code and tests; no live two-organization walkthrough. Findings below. |

### Security findings review

Done from code and tests. Not a penetration test, and not the live
two-organization walkthrough R-03 also asks for. CAD ingestion is reachable only by `staff`, the
installation's own administrators, and severities are rated with that in mind.

**Checklist re-run.** Every line of the v1 checklist in [05-security.md](05-security.md) still
names a file or test that exists and still asserts what the line claims. That includes the
same-organization colleague refused a signed asset URL, which `designs.spec.ts` proves with an
account in the same organization.

**Route matrix.** Every API route and page was traced to its guard:

- Every `/api/admin/*` handler and `/admin/*` page calls `requireStaff`, directly or through
  `getAdminOrganization`.
- Every `/api/org/*` handler and `/org/*` page calls `requireOwner`, which admits owners and staff.
- Every tenant route calls `requireTenant`, except `/api/catalog/products`, which calls
  `getPrincipal` and answers 401 without a session. Tenant data is read inside `withTenant`, under
  forced row-level security.
- Every mutating handler calls `assertSameOrigin`, except `/api/dev/invite`, which exists only
  while dev tooling is on.
- Unauthenticated routes: the auth flows, `/api/health`, `/api/dev/*` (404 unless dev tooling is
  on, and production needs a second explicit switch), `/design/demo` and `/api/fixtures/*`.
- Sessions are refused once revoked, once the user is not `active`, or after idle or absolute
  expiry. Suspending an organization revokes its sessions.
- Render jobs are built on the server from reads inside the tenant's own context, so a job cannot
  name another organization's artwork or design.

| # | Finding | Severity | Recommended release decision |
| --- | --- | --- | --- |
| S-1 | The CAD parser can read the storage volume, which holds every organization's assets, and the application tree (`F-HARD-03`). It has no network, no credentials and its own PID namespace. Exploiting this takes a crafted file that defeats OCCT, imported by an administrator, and the only way out is the generated mesh, which staff review before publishing. | Medium | **Decided:** the `cad` profile ships marked uncertified, with guidance to import only files from trusted suppliers. Fixing it stays `F-HARD-03`. |
| S-2 | The CAD worker image and its Compose profile have never been built or booted (`F-HARD-07`). CI builds only `web` and `worker-render`. | Medium | **Decided:** covered by shipping the profile uncertified. Stays `F-HARD-07`. |
| S-3 | Staff accounts sign in with a password only. Staff reach every organization, and staff alone can import CAD; TOTP (`F-AUTH-09`) is unbuilt. argon2id, the breach check, rate limits and lockout are in place. | Medium | **Decided:** ships without it, stated as a known limitation in the release notes. `F-AUTH-09` is the first feature after release. |
| S-4 | [05-security.md](05-security.md) describes unbuilt controls without marking them unbuilt: "MFA required" for staff, Turnstile CAPTCHA after repeated failures, and a single `can()` module "never inline in route handlers", when route guards are inline. R-03 forbids presenting planned controls as implemented. | Low | **Done** for the release (`F-HARD-10`): the document now opens with what is built against what is designed. |
| S-5 | Nothing asserts the application role cannot bypass row-level security. CI's `images` job checks `rolsuper` but not `rolbypassrls`, and no integration test checks the role it runs as. Deploy creates the role correctly today. | Low | **Decided:** backlogged as `F-HARD-11`. |
| S-6 | `/design/demo` and `/api/fixtures/*` are unauthenticated in production. The web image has no `fixtures/` directory, so they fail rather than serve anything; the fixtures are synthetic and public anyway. | Low | **Decided:** backlogged as `F-HARD-12`. `preview:probe` and e2e use the demo, so the dev path has to keep working. |
| S-7 | Render specs carry a placeholder artwork digest (`'0' * 64`), so the worker cannot detect a changed artwork file. Storage is a local disk shared only with the application. | Info | Backlogged as `F-HARD-15`. Revisit with object storage. |
| S-8 | Source CAD has no deletion path and no separate retention (`F-HARD-04`). Dependencies are not hash-pinned and there is no SBOM (`F-HARD-05`). Worker classes are not routed (`F-HARD-06`). | Info | Document as known limitations. |

**Tests R-03 asks for that do not exist yet.** Backlogged by decision: T-1 and T-2 as
`F-HARD-13`, T-3 as `F-HARD-14`, T-4 with S-5 as `F-HARD-11`.

- **T-1:** an owner, a member and a signed-out request each get 404 from every `/api/admin/*`
  route, enumerated from the route tree. Today `admin.spec.ts` checks only `/admin` and
  `/api/admin/orgs` as a non-staff user.
- **T-2:** a member gets 404 from every `/api/org/*` route, enumerated the same way. Today
  `org.spec.ts` checks invitations only.
- **T-3:** a pooled connection carries no tenant context once its transaction ends. `withTenant`
  relies on `set_config(..., true)` and nothing checks it.
- **T-4:** the role the suite connects as has `rolsuper` and `rolbypassrls` false, so the isolation
  tests cannot pass vacuously. This is the test half of S-5.

Already covered, and checked: suspended users and organizations (`org.integration.test.ts`,
`admin.integration.test.ts`); cross-tenant artwork, design, render and archive access (the
`*.integration.test.ts` suites in `artworks`, `designs` and `render-jobs`); attributable staff
actions (`recordAudit` assertions in `admin` and `render-jobs`).

**Decision.** The initial release ships with the `cad` profile marked uncertified
and without staff two-factor. S-4 through S-7 and T-1 through T-4 are not fixed for it; they are
backlogged as `F-HARD-10` to `F-HARD-15` in [01-features.md](01-features.md); `F-HARD-10` (S-4)
was then done for the release after all. [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md) states the
rest, including that staff sign in with a password only (`F-AUTH-09`, the first feature after
release), that the `cad` profile is uncertified (S-1, S-2), and S-8. [22-pentest-brief.md](22-pentest-brief.md) still has
to add CAD ingestion to its scope, which is the rest of `F-HARD-08`.

Track implementation evidence against R-01 through R-08 with release SHA, environment, commands,
results, limitations and reviewer. Do not mark `F-GEN-08` complete on documentation alone.
