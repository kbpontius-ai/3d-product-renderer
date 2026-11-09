# 27 — Deploying to one server

How this product gets onto a DigitalOcean droplet and stays there. Companion to
[06-conventions.md](06-conventions.md) (how changes reach `main`) and
[05-security.md](05-security.md) (why there is no self-service sign-up).

Everything here is in [`deploy/`](../deploy). The step-by-step install is
[QUICKSTART.md](../QUICKSTART.md), and what this release does not do is in
[KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md). The short version:

```bash
git clone https://github.com/kbpontius-ai/3d-product-renderer.git && cd 3d-product-renderer
git checkout <release tag> && cd deploy
cp .env.production.example .env && $EDITOR .env
docker compose up -d --build
```

## 0. What this is, and what it is not

**One machine.** Not a starting point that scales by adding replicas — a ceiling, and worth
understanding before you build on it.

`packages/storage` has a local-filesystem adapter and nothing else. Pack meshes, uploaded artwork
and finished renders all live on a disk, so the web app and the render worker must share one. That
is the `storage` volume mounted into both. It means:

- one web container and one render worker, not N of each;
- no load balancer in front of two droplets;
- the disk is the thing that must not be lost, and the thing to back up.

Removing that ceiling is one adapter behind an interface nothing else has to know about
(`F-SHIP-08`). Until then, this is a pilot deployment, and an honest one.

**Blender is version-locked, and the render image is a different distribution because of it.**
`docs/16` pins the preview's tone mapping to Blender's AgX view transform as a matched pair, and the
parity suite measures SSIM against renders from whatever build CI used — Ubuntu 24.04's 4.0.2. So
`deploy/worker-render/Dockerfile` builds on Ubuntu rather than the Node image's Debian, which ships
the 3.x series and predates AgX entirely. A bookworm runtime would have built, started, claimed jobs
and rendered happily against a colour pipeline no budget was calibrated on. The distribution build
rather than the blender.org tarball, for the same reason: the official builds carry
OpenImageDenoise, Ubuntu's do not, the worker switches the denoiser on whenever it finds one, and
that would diverge from the baseline too. The image asserts the series at build time; moving it is a
parity-suite event, not a package upgrade.

**No GPU.** A droplet has none, so Cycles renders on CPU: minutes per render, not seconds
(`F-SHIP-09`). The editor, the preview and the 2D face view are unaffected — they run in the
browser. It is the final photorealistic render that is slow.

## 1. The droplet

| | |
|---|---|
| Image | Ubuntu 24.04 with Docker, or plain Ubuntu plus Docker Engine |
| Size | **4 GB / 2 vCPU minimum.** Blender is the reason: a Cycles render on two cores will use most of the box while it runs |
| With the CAD profile | **8 GB.** OCCT meshing is memory-hungry and the parser gets hard ceilings, not a fair share |
| Volume | Attach one and mount it if you expect more than a few hundred renders; the `storage` volume grows and nothing prunes it |
| Firewall | 80 and 443 only. PostgreSQL is not published — it is reachable on the compose network and nowhere else |

DNS has to resolve **before** the first `docker compose up`. Caddy asks Let's Encrypt for a
certificate on start-up, and Let's Encrypt checks the name reaches this machine; if it does not, the
first boot fails on something that has nothing to do with the application.

## 2. Settings

`cp .env.production.example .env` and fill in five values. Four of them are secrets:

```bash
openssl rand -base64 24   # POSTGRES_SUPERUSER_PASSWORD, POSTGRES_APP_PASSWORD
openssl rand -hex 32      # ASSET_URL_SECRET
```

Three are worth understanding rather than pasting.

**`ASSET_URL_SECRET`** signs asset URLs. Left unset, every process invents its own at start-up, so
a URL signed by the web app is rejected by anything else and images 404 with nothing in the log
that says why. Set it, and set it once.

**`APP_URL`** must match `APP_DOMAIN` and must be `https`. It is the origin invitation and
password-reset links are built from — get it wrong and the links point somewhere that cannot sign
anyone in.

**Two PostgreSQL passwords, not one.** The superuser bootstraps the cluster; the application
connects as an ordinary role called `product_renderer`, created by
[`deploy/postgres/10-app-role.sh`](../deploy/postgres/10-app-role.sh) on first boot. This is not
ceremony. `force row level security` forces policies on the table *owner* and does not touch a
superuser — an application connected as one gets a database that has quietly stopped enforcing
tenancy, while the tenancy tests still pass. Do not collapse the two roles.

## 3. First boot

```bash
docker compose up -d --build          # add --profile cad for STEP ingestion
docker compose logs -f migrate        # runs once, before the web app starts
curl https://your-domain/api/health   # {"status":"ok"}
```

`/api/health` reports the database and the object store, not just the port. A 503 with
`{"failed":["storage"]}` means the process is up and cannot serve a mesh — which is why compose
restarts on it.

### An account to sign in with

There is no self-service sign-up, by design ([05-security.md](05-security.md)). The first account is
made from the server:

```bash
docker compose exec -w /app web node --import tsx scripts/seed-dev.ts you@example.com
```

Not `pnpm seed:dev`: the web image has no pnpm, for the reason the `migrate` service gives in
`compose.yaml`. The script is the development one, so the organisation it creates is always named
"Demo Organisation" and can't be renamed yet; a production setup command is the first work after the
release (`F-SHIP-11`, [38](38-first-work-after-release.md)).

That creates an organisation, makes the account **staff**, and prints an invitation link built from
`APP_URL` — which is the second reason that variable has to be right. Everyone after the first
account is invited from `/admin`, and outside development the console never shows the link; it is
only emailed. Without `RESEND_API_KEY` and `MAIL_FROM`, nobody else can be invited and nobody can
reset a password. Open the link, set a password,
and you are in. Staff is what gets you `/admin`: pack upload, zone authoring, the render queue,
materials.

Pass `--member` for an ordinary account instead. Later promotions happen in the admin console, where
they are attributed; `scripts/grant-staff.ts <email>`, run the same way, exists for the case where
you have locked yourself out of it.

### Products

A fresh deployment has an empty catalog: the images ship no products. Products enter as **Product
Packs**, and CAD ingestion is not the only way in — it is one way to author a draft. Upload a `.zip`
of `manifest.json` and its assets at `/admin/packs`, which dry-runs it before importing, or a STEP
file at `/admin/cad`. Zones are authored in the browser afterwards at `/admin/packs/<id>/zones`,
against the real mesh with a test pattern.

## 4. Upgrades

```bash
git fetch --tags && git checkout <new release tag> && docker compose up -d --build
```

Read the release's entry in [RELEASE-NOTES.md](../RELEASE-NOTES.md) first; it lists any action the
upgrade needs. `migrate` runs to completion before `web` starts, every time, so a schema change lands before
anything reads the new shape. Migrations are forward-only; roll back by restoring a backup, not by
reversing one.

Expect a few seconds of downtime — one web container, no rolling deploy. That is the single-node
trade again.

The per-deployment checklist — what to check before, the four verifications after, and the table of
settings that fail silently — is in the [README](../README.md#every-deployment), deliberately, so it
is in front of whoever is deploying rather than three levels down. The short version: CI green on
the commit (the `images` job builds and boots this exact compose file), then `migrate` exited 0,
`/api/health` 200, `worker-render` running, and a real sign-in in a browser.

## 5. Backups

`scripts/backup.sh` and `scripts/restore.sh` exist and `scripts/backup-drill.ts` proves a backup
restores. **Two things must be backed up together and neither is enough alone:**

| | Holds | Lost means |
|---|---|---|
| `pgdata` volume | accounts, catalog, designs, the queue | everything, including who may sign in |
| `storage` volume | pack meshes, uploaded artwork, finished renders | a catalog describing assets nobody can fetch |

A database backup taken at a different moment from the object store will restore to a catalog that
references files that are not there. Snapshot the droplet, or stop the stack briefly and copy both.

The scripts above are written for running from source: they need `PG_BIN`, `STORAGE_ROOT` and a
database they can reach, and the Compose stack publishes none of those. For Compose, stopping the
stack and copying both volumes is the procedure, and it **has not been tested yet**. Writing it out
as exact commands and timing a restore onto an empty server is step 2 of
[38](38-first-work-after-release.md).

## 6. When it is broken

| Symptom | Where to look |
|---|---|
| Sign-in bounces straight back to `/signin` | Almost always TLS. The session cookie is `__Host-` prefixed, so it requires `Secure`; over plain http the browser discards it silently. Check Caddy got a certificate |
| Images and meshes 404, page renders | `ASSET_URL_SECRET` unset or different between processes |
| Renders queue and never finish | `docker compose logs worker-render`. If it is `numpy`, the image is wrong — Blender's glTF importer needs it and fails at mesh import, not at start-up |
| `/api/health` 503 with `failed: ["database"]` | The app role, usually. `docker compose logs postgres` and check `10-app-role.sh` ran — it only runs on an *empty* data directory |
| CAD worker refuses to start | Intended, if the sandbox is unavailable. The `cad` profile ships **uncertified**: the parser can still read the storage volume (`F-HARD-03`), so import only files from suppliers you trust. `CAD_SANDBOX=require` is set in `compose.yaml` so it will not parse a stranger's file unconfined. See [deploy/cad-worker/README.md](../deploy/cad-worker/README.md) |

## 7. What is not here

Stated rather than discovered:

- **No S3 adapter** (`F-SHIP-08`) — the single-node ceiling above.
- **No GPU rendering** (`F-SHIP-09`).
- **No rolling deploys.** One container each; an upgrade is a short outage.
- **No log shipping.** Logs are JSON on stdout and go wherever Docker puts them. The observability
  work in `F-PLAT-02` emits traces; nothing here collects them. Warnings and errors are the
  exception: every process also writes them to the `service_events` table, so staff can read them on
  `/admin/status` without a shell on the droplet — two weeks' worth, not an archive.
- **No blue/green or canary.** `docker compose up -d --build` replaces containers in place.
- **The CAD image is not built in CI.** The `images` job builds the web and render images; the CAD
  worker is behind a profile and off by default, and pip-installing OCCT costs more CI minutes than
  an off-by-default worker is worth. It is the one image whose first build may still be on the
  droplet.

## Orientation rollout

Ship web and render workers from the same orientation-capable revision, then restart both before enabling new orientation/Detail renders. The CAD worker must also run the revision that seeds unconfirmed frames for newly drafted imports. No migration, service or dependency is added. Keep historical schemas, original studios and queued legacy inputs intact; this rollout does not backfill old products/designs. Validate a confirmed-frame image export in the running deployment before offering it as verified.
