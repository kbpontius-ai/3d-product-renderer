# Quickstart

From a tagged release to your first render, on one server. The full runbook, including sizing,
upgrades, backups and troubleshooting, is [docs/27-deployment.md](docs/27-deployment.md). Read
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md) before you rely on this for anything.

> **Not yet tested end to end.** This release's install path has not been run from these
> instructions on a clean server. That run-through is the first work after the release
> ([docs/38](docs/38-first-work-after-release.md), step 2). The image build and boot are checked
> in CI; step 4 below and email delivery are not.

## What you need

| | |
|---|---|
| Server | **Ubuntu 24.04 LTS, x86_64.** 4 GB RAM and 2 vCPU minimum; 8 GB if you turn on CAD import |
| Software | Docker Engine with the Compose plugin ([Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/)) and Git |
| Domain | A DNS name whose A record points at the server **before** step 3, because the certificate is requested at first start |
| Firewall | Ports 80 and 443 open. Nothing else needs to be |
| Email | A [Resend](https://resend.com) account with a verified sending domain. Without it, only the first account can sign in (see step 4) |
| Downtime | A few seconds per upgrade. There is one web container and no rolling deploy |
| Costs | The server, the domain and Resend. Nothing else is called |

Data lives in two Docker volumes, `pgdata` (the database) and `storage` (meshes, artwork, renders).
Back up both, together.

## 1. Get the release

```bash
git clone https://github.com/kbpontius-ai/3d-product-renderer.git
cd 3d-product-renderer
git checkout 2026.11.0
```

Use a release tag, not `main`.

## 2. Configure

All the remaining commands run from `deploy/`.

```bash
cd deploy
cp .env.production.example .env
```

Generate the secrets:

```bash
openssl rand -base64 24   # run twice: POSTGRES_SUPERUSER_PASSWORD, POSTGRES_APP_PASSWORD
openssl rand -hex 32      # ASSET_URL_SECRET
```

Then edit `.env`:

| Setting | Value |
|---|---|
| `APP_DOMAIN` | Your domain, e.g. `renderer.example.com` |
| `APP_URL` | The same domain with `https://`. Invitation and reset links are built from it |
| `ACME_EMAIL` | Where Let's Encrypt sends certificate notices |
| `POSTGRES_SUPERUSER_PASSWORD`, `POSTGRES_APP_PASSWORD` | The two generated passwords. Keep them different |
| `ASSET_URL_SECRET` | The generated hex value |
| `RESEND_API_KEY`, `MAIL_FROM` | Your Resend key, and a sender on its verified domain. Set both or neither |

## 3. Start it

```bash
docker compose up -d --build
```

The first build takes several minutes. Then check four things:

```bash
docker compose ps -a migrate                  # exited (0)
curl -sS https://renderer.example.com/api/health   # {"status":"ok"}
docker compose ps worker-render               # running
```

The fourth is a browser sign-in, after step 4.

CAD import (STEP files at `/admin/cad`) is off by default and **uncertified** in this release.
Turn it on only if you import files from suppliers you trust:
`docker compose --profile cad up -d --build`.

## 4. Create the first account

There is no public sign-up. The first account is made from the server:

```bash
docker compose exec -w /app web node --import tsx scripts/seed-dev.ts you@example.com
```

This creates an organisation named **Demo Organisation** (it can't be renamed yet), makes you its
owner and a staff administrator, and prints an invitation link. Open the link, set a password, and
sign in. The link is printed only to your terminal.

Everyone after you is invited from the admin console (`/admin`), and their invitations are emailed.
Without email settings nobody else can be invited, and nobody can reset a password.

## 5. Add a product

A new installation has no products. Product Packs are the way in:

- **Upload a pack** at `/admin/packs`: a `.zip` of `manifest.json` and its meshes. To try it with
  the sample pack, run this on your own machine in the checkout:
  `cd fixtures/packs && zip -r cap-basic.zip cap-basic`. Upload the zip, review the dry run, import
  it, confirm its orientation and zones, and publish it.
- **Or import a STEP file** at `/admin/cad`, if you turned on the `cad` profile.

Then generate its catalog image: Admin → Packs → Catalog previews → **Generate preview**.

## 6. Make a design and render it

1. Open **Designs** and press **New design**. Pick the product from the catalog.
2. Upload an SVG (try `fixtures/artwork/samples/wordmark.svg`) and place it on the product. Designs
   save automatically.
3. Press **Render** in the editor toolbar, choose the settings, and submit. Renders run on the CPU
   and take minutes, not seconds.

Finished renders are listed under **Renders**. If email is set up, you are also emailed about any render that took longer than 90 seconds, unless you turn that off in your account settings.

## When something is wrong

Run `docker compose logs --tail 100 <service>`, then check section 6 of
[docs/27-deployment.md](docs/27-deployment.md). The most common problem is sign-in bouncing straight
back to the sign-in page, which almost always means the certificate wasn't issued: check the DNS
record and `docker compose logs caddy`.
