# 38 — First work after the initial release

**Start here.** The initial release (`2026.11.0`) shipped without the two pieces of work below, by
decision. They are the first things to implement, in this order, before any other feature work.
Each step says what to do, where, and what counts as done. The requirements they come from are R-02
to R-06 in [36-self-host-readiness.md](36-self-host-readiness.md); the feature rows are `F-SHIP-11`
to `F-SHIP-13` in [01-features.md](01-features.md).

The working agreements still apply: plan each change, get it approved, then build it on a branch
with its own pull request. Step 2 needs a server that nobody has used yet, so it has to be arranged
with the maintainer before it starts.

| Order | ID | What | Kind |
|---|---|---|---|
| 1 | `F-SHIP-11` | A production setup command | code |
| 1 | `F-SHIP-12` | Email in the Compose deployment: verify it, and make bad settings fail clearly | code + check |
| 2 | `F-SHIP-13` | A full run-through on a clean Ubuntu 24.04 server | check |

---

## Step 1 — Production setup and email (`F-SHIP-11`, `F-SHIP-12`)

### Where things stand at the release

- The only way to create the first account is `scripts/seed-dev.ts`. It always creates an
  organisation called **Demo Organisation** with the slug `demo`, makes the given email staff, and
  prints an invitation link. The release's [QUICKSTART](../QUICKSTART.md) runs it inside the web
  container as `node --import tsx scripts/seed-dev.ts`, the same way the `migrate` service runs
  migrations. That command has never been run against a built container.
- There is no way to rename an organisation, so every installation's first organisation is
  "Demo Organisation" until this step is done.
- Outside development the admin console never shows invitation links; they are only emailed.
  Compose passes `RESEND_API_KEY`, `MAIL_FROM` and `MAIL_REPLY_TO` to every service as of the
  release, but no email has been sent from a Compose deployment yet.
- A Resend key without `MAIL_FROM` logs one warning and then sends nothing
  (`packages/mail/src/from-env.ts`).
- The CAD worker does not force `CAD_IMPORTER=occt` in `deploy/compose.yaml`. R-04 asks for it, so
  that a missing kernel stops CAD processing rather than falling back to stand-in geometry.

### 1.1 Read first

- `scripts/seed-dev.ts`, `scripts/grant-staff.ts`
- `packages/admin/src/orgs.ts` (`createOrganization`: slug normalising, conflict error, audit)
- `packages/auth/src/service.ts` (`createInvitation`), `packages/admin` (`setStaff`)
- `deploy/web/Dockerfile` (runtime stage: no pnpm, no corepack, working directory `apps/web`)
- `deploy/compose.yaml` (`migrate`, the pattern to copy for running a script)
- R-02 in doc 36

### 1.2 Plan it and get it approved

The plan has to settle these, because R-02 leaves them open:

1. **Command name and syntax.** For example
   `node --import tsx scripts/setup.ts --org-name "Acme Products" --org-slug acme --admin you@acme.com`.
2. **Extend, don't duplicate.** R-02 says not to create a second way to make accounts. Either give
   `seed-dev.ts` the new flags and keep its current defaults for development, or move the shared
   part into one function that both scripts call. Say which.
3. **What "safe to repeat" means**, case by case (1.4 below).
4. **Where start-up validation lives** (1.6 below): the web app, the workers, or a shared check
   that all three call.

### 1.3 Build the setup command

- It takes the organisation name, slug and administrator email. It never invents a name.
- It creates the organisation through `createOrganization`, so slug rules and the audit record are
  the same as the admin console's.
- It creates the organisation's quota row, as `seed-dev.ts` does today.
- It invites the administrator as owner and makes them staff, as `seed-dev.ts` does.
- It prints the invitation link with `console.log` and nothing else. The structured logger copies
  warnings and errors into the `service_events` table, so the link must never pass through it.
  `docker compose exec` output goes to the operator's terminal, not to the service logs.
- It must work in the built web image as it is: run from `/app`, with `node --import tsx`, and
  without pnpm or network access. Add the script to the `RUN test -f …` assertion in
  `deploy/web/Dockerfile`, so a build that leaves it out fails.

### 1.4 Make it safe to repeat

Each case gets its own message, and none of them changes existing data:

| Situation | Behaviour |
|---|---|
| Nothing exists yet | Create the organisation, invite the administrator, print the link. |
| Same slug, same name, administrator not yet signed in | Say so. Offer a fresh link only with an explicit flag, because resending revokes the earlier one. |
| Same slug, same name, administrator already active | Say the installation is set up and stop. No new invitation, no password change. |
| Slug exists with a different name | Refuse and name both, so the operator can choose. |
| The email belongs to a user in another organisation | Refuse. Never move or promote an existing account implicitly. |

### 1.5 Email

1. Keep the Compose wiring added for the release (the shared environment block in
   `deploy/compose.yaml`).
2. Make partial settings fail clearly. A key without `MAIL_FROM`, or `MAIL_FROM` without a key,
   should stop the web app and the render worker at start-up in production, with a message naming
   the missing setting. Today it is one warning.
3. "No email at all" stays allowed and must be a clear choice: empty `RESEND_API_KEY` and empty
   `MAIL_FROM`. Document what an operator loses that way: other people can't be invited, and
   passwords can't be reset.
4. Check that invitation, password-reset and render-ready emails all build their links from
   `APP_URL`. The real delivery check is in step 2.

### 1.6 Check settings before accepting work

At start-up in production, refuse to start with a clear message when:

- `APP_URL` is not `https`.
- `APP_URL`'s host differs from `APP_DOMAIN`. Compose can pass `APP_DOMAIN` to the app for this.
- The email settings are half set (1.5).

Never print a secret's value in these messages; name the setting instead. Compose already refuses
to start without `APP_URL`, `ASSET_URL_SECRET` and the database password.

### 1.7 CAD importer

Add `CAD_IMPORTER: occt` beside `CAD_SANDBOX: require` in the `worker-cad` service, and check that
the worker refuses to start when OCCT is missing.

### 1.8 Empty catalog

R-02 asks that an empty catalog guide staff to product setup (`/admin/packs`, `/admin/cad`) and
tell members to ask their administrator. Check what the catalog shows with no products today, and
add the guidance if it is missing.

### 1.9 Tests

- Integration tests for every row of the table in 1.4, against the isolated test database.
- A test that the invitation token is not written to `service_events`.
- Unit tests for the start-up checks in 1.5 and 1.6.
- The full local set: `pnpm test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm check:env`, `pnpm e2e`.
- CI's `images` job builds the web image, so the Dockerfile assertion from 1.3 is checked there.

### 1.10 Update the documents

Replace the interim command in [QUICKSTART.md](../QUICKSTART.md),
[27-deployment.md](27-deployment.md) and the README. Remove the "Demo Organisation" and email entries
from [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md). Tick `F-SHIP-11` and `F-SHIP-12` only after
step 2 has seen them work on a real server.

### Done when

A fresh install contains only the organisation and administrator the operator named. Running setup
again changes nothing and says why. Bad settings stop the stack with a message that says what to
fix. The interim command is gone from every document.

---

## Step 2 — A full run-through on a clean server (`F-SHIP-13`)

Nobody has yet installed this product from its documents on a machine that has never seen it. This
step does that, follows the documents exactly, and records what happens. **Any place where the
documents had to be departed from is a bug in the documents.** Fix it in a pull request and run the
step again.

### 2.1 What it needs

- A fresh **Ubuntu 24.04 LTS x86_64** server: 4 GB RAM and 2 vCPU for the core stack, 8 GB with the
  `cad` profile. A cloud VM is fine. Agree with the maintainer which one before starting.
- A DNS name pointing at it, and ports 80 and 443 open.
- A Resend account with a verified sending domain.
- Two mailboxes you can read, for two organisations.
- Step 1 merged, unless the maintainer agrees to run this against the release as it is.

Record the commit SHA (or tag), the server size, and the Docker and Compose versions at the start.

### 2.2 Install from the quickstart

1. Follow [QUICKSTART.md](../QUICKSTART.md) from top to bottom, exactly as written, from the
   directory it names for each command. Time each section.
2. Check: `migrate` exited 0, `/api/health` returns `{"status":"ok"}`, `worker-render` is running,
   and a browser sign-in works.
3. Run the setup command a second time. Confirm with SQL that there is still one organisation and
   one user:

   ```bash
   docker compose exec -T postgres psql -U postgres -d product_renderer -tAc \
     "select (select count(*) from organizations), (select count(*) from users)"
   ```

4. Confirm the application role cannot get around row-level security. Both values must be `f`:

   ```bash
   docker compose exec -T postgres psql -U postgres -d product_renderer -tAc \
     "select rolsuper, rolbypassrls from pg_roles where rolname = 'product_renderer'"
   ```

### 2.3 Email

1. The administrator's invitation arrives by email. Accept it from the email, not from the
   terminal output.
2. Ask for a password reset, follow the emailed link, and sign in with the new password.
3. Submit a render and check that the render-ready email arrives and its link opens the render.
   Only renders that take longer than 90 seconds are emailed (`EMAIL_AFTER_SECONDS`), which a CPU
   render on this server size will.
4. Set only `RESEND_API_KEY` (no `MAIL_FROM`) and check that the stack refuses to start with a
   clear message. Put the settings back.

### 2.4 The whole product workflow

1. On your own machine, zip a sample pack from the checkout:
   `cd fixtures/packs && zip -r cap-basic.zip cap-basic`.
2. Upload it at `/admin/packs`, read the dry-run, import it, confirm orientation and zones, and
   publish it.
3. Generate the catalog preview for it (Admin → Packs → Catalog previews).
4. As an ordinary user, start a new design from the catalog, upload
   `fixtures/artwork/samples/wordmark.svg`, place it, and let it autosave. Reload the page and check
   the design comes back as it was.
5. Submit a render. Download it and look at it: the body and relief finishes are distinct, the
   product is the right way up, and the lighting matches the viewer.
6. Upload `fixtures/artwork/samples/hostile.svg` and check it is refused with a readable message.

### 2.5 Two organisations

1. In `/admin`, create a second organisation and invite its owner (second mailbox). Invite a member
   into the first organisation.
2. As organisation B's owner, open organisation A's design, artwork, render download and asset URLs
   (copy them from A's session). Every one must be refused (404).
3. As A's member, open `/org` and `/admin` and their API routes. All must be refused.
4. Suspend organisation B in `/admin`. B's open session must stop working on its next request.
5. Check the audit trail in `/admin` shows the staff actions just taken.

### 2.6 Restarts and interruptions

1. While a render is running, `docker compose kill worker-render`, then
   `docker compose up -d worker-render`. The job must finish after its lease runs out, without
   being submitted again.
2. `docker compose restart`. Everything comes back, and designs, artwork and renders are all still
   there.
3. Note how much space the `storage` and `pgdata` volumes use after these renders
   (`docker system df -v`).

### 2.7 Backup and restore

`scripts/backup.sh` and `restore.sh` are written for the source install (they need `PG_BIN`,
`STORAGE_ROOT` and a reachable database), not for Compose. For Compose, the runbook says to stop the
stack and copy both volumes together. This step turns that into a tested procedure:

1. Write the exact commands: stop the stack, archive `pgdata` and `storage` with a throwaway
   container, and start it again. Time the outage.
2. Restore onto a second, empty Compose project or server.
3. On the restored copy, check: sign-in works, row counts match the original, stored file digests
   match, a design opens, and one render completes.
4. Put the tested procedure in [27-deployment.md](27-deployment.md) section 5, with the measured
   time.

### 2.8 Migration `0013`

Read `packages/db/migrations/0013_pp_material_cleanup.sql`. It rewrites material references in saved
designs and packs and deletes other materials. A fresh install runs it on empty tables, so it does
nothing there. Write down in the release notes what it does to an installation that already had
data. Do not edit it, because it has already been applied.

### 2.9 CAD profile (optional, uncertified)

Only if the maintainer wants it covered: `docker compose --profile cad up -d --build`, check the CAD
worker starts with the sandbox, and import `fixtures/cad/closure-38.step` at `/admin/cad`. This is
the first build of the CAD image (`F-HARD-07`). Record what happens; it does not certify the profile.

### 2.10 Record it

Add a row to the evidence record in doc 36 section 8: commit or tag, server, date, each check above
with its result, the times measured, problems found, and the pull requests that fixed them. Tick
`F-SHIP-13`, and `F-SHIP-11` and `F-SHIP-12` if step 1 was covered, only once every check above
passed on a single run after the last document fix.

### Done when

Someone who has not worked on the code installs the product from the quickstart on a clean server,
signs in, invites a second organisation, renders a design, and restores a backup, without changing
any source and without help that the documents don't contain.
