# 3D Product Renderer

A generic product customizer: pick a 3D product, place vector artwork on it in a 2D face view,
preview it live, and export a photorealistic render. The first product pack is plastic closures with
embossed/debossed logos — the platform itself knows nothing about caps.

Product setup now includes a shared [orientation workflow](docs/33-product-orientation.md): staff
confirm Front/Up after CAD import, review zones/material defaults, then publish. Designs can use an
independent orientation override. Source geometry and legacy saved views are preserved. Run web and
render workers from the same revision when reviewing orientation-aware exports.

**Installing it on a server:** [QUICKSTART.md](QUICKSTART.md). Before relying on it, read
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md). What changed in each release is in
[RELEASE-NOTES.md](RELEASE-NOTES.md). **Working on it:** the first work after the initial release
is [docs/38](docs/38-first-work-after-release.md).

## Status

v1 is built: 75 of its 77 features are done, and the two left are content rather than code
([docs/01-features.md](docs/01-features.md), "Where this stands"). The table lists the workspace
packages.

| Area | State |
|---|---|
| `docs/` | Feature, workflow, GUI, security and implementation plans (down to pseudocode) |
| `packages/design-schema` | Design document, product pack manifest, materials, render spec, migrations |
| `packages/artwork` | Emboss height profile, signed distance fields, height baking, PNG output |
| `packages/placement` | Zone mappers, transforms, snapping, shared validation |
| `packages/face-view` | Viewport, hit testing, pointer gestures for the 2D placement view |
| `packages/scene` | Bounding-sphere framing, camera presets, shared turntable path |
| `packages/materials` | Neutral material definitions mapped to three.js and Cycles |
| `packages/render-spec` | Canonical JSON, spec hashing, job spec builder, cost estimates |
| `packages/svg` | XML reader, allow-list sanitiser, normaliser, artwork validation |
| `packages/raster` | Curve flattening, scanline coverage rasteriser, stroke-to-area |
| `packages/gltf` | GLB writer and the parametric geometry the fixture packs ship |
| `packages/db` | Schema, migrations, row-level security, tenancy helpers |
| `packages/auth` | Invitations, sessions, password reset, policy, rate limiting |
| `packages/catalog` | Product Pack import, catalog and material reads |
| `packages/designs` | Design documents: create, load, versioned save with an optimistic lock |
| `packages/storage` | Object storage interface, local adapter, conformance suite |
| `packages/artworks` | Artwork ingest and immutable edits: pipeline, derived assets, dedupe by content |
| `packages/render-jobs` | The queue: leases, dedupe by spec hash, retries, quotas, cancellation |
| `packages/blender` | Height bake, generated Cycles scene, renderer process control |
| `packages/observability` | Structured logging, request-scoped context, in-process metrics |
| `packages/admin` | Staff operations: organisations, quotas, people, audit log |
| `packages/packfile` | Reading an uploaded pack archive: zip, manifest, declared assets |
| `packages/notifications` | The bell and render-finished email |
| `packages/render-backend` | The renderer contract, its conformance suite, and a stand-in backend |
| `packages/parity` | Structural similarity between two renders, and the budget the harness holds them to |
| `apps/worker-render` | The render worker: claim, fetch, bake, trace, upload |
| `apps/web` | Next.js editor: 2D face placement, 3D preview, uploaded artwork, autosaved designs, renders |
| Turntable video, PDF spec sheet | v2 — see `docs/21-build-order.md` |

## Requirements

| | Needed for | Notes |
|---|---|---|
| Node.js 22+ | everything | `engines.node` is `>=22` |
| pnpm 10 | everything | `corepack enable` picks up the pinned `packageManager` |
| PostgreSQL 16 | accounts, catalog, saved designs, the render queue | server binaries only — `scripts/dev-db.sh` runs a throwaway cluster under `.tmp/`, no Docker |
| Blender 4.0+ | photorealistic renders | headless; the preview and the editor work without it |
| Python 3.11 + OCCT | CAD ingestion (`/admin/cad`) | `pip install cadquery-ocp==7.9.3.1.1`. Without it the CAD worker falls back to a kernel-free reference importer — see below, because that fallback looks like success |
| Chromium | the end-to-end suite | `pnpm exec playwright install chromium`, or point `CHROMIUM_PATH` at one you have |

None of the optional pieces is a hard dependency: without a database the demo route still runs,
without Blender everything works up to the point of asking for pixels, and without OCCT everything
works up to the point of reading a real STEP file.

On Debian/Ubuntu:

```bash
sudo apt-get install postgresql-16 blender python3-numpy python3-pip util-linux
pip install cadquery-ocp==7.9.3.1.1
```

`python3-numpy` is not optional if you want renders: Blender's glTF importer needs it, and without
it every render fails at mesh import.

On macOS:

```bash
brew install postgresql@16 python@3.11 util-linux
brew install --cask blender
pip3.11 install cadquery-ocp==7.9.3.1.1     # an Apple Silicon wheel is published
export PG_BIN="$(brew --prefix postgresql@16)/bin"
export BLENDER_PATH="/Applications/Blender.app/Contents/MacOS/Blender"
export PATH="$(brew --prefix util-linux)/bin:$PATH"   # setsid, which scripts/e2e.sh needs
export LC_ALL="en_US.UTF-8"                           # or PostgreSQL 16 will not start; see below
```

Four things bite on macOS and nowhere else. None is a problem with the machine:

- **PostgreSQL 16 refuses to start without a locale.** `scripts/dev-db.sh start` reports
  `postmaster became multithreaded during startup` and exits. Set `LC_ALL`.
- **`scripts/e2e.sh` needs `setsid`**, which macOS does not ship. Homebrew's `util-linux` has it and
  is keg-only, hence the `PATH`. It does *not* provide a working `unshare` or `prlimit` — the CAD
  sandbox stays unavailable, as below.
- **`STORAGE_ROOT` must be an absolute path.** The web app runs with its working directory at
  `apps/web` while the CLI scripts run from the repository root, so a relative value silently splits
  the object store in two. Pack meshes then 404, which takes the whole editor down with a
  client-side exception that says nothing about paths.
- **Safari cannot sign in over http.** The session cookie is `__Host-`-prefixed, which mandates
  `Secure`; Chrome and Firefox grant `http://localhost` a trustworthy-origin exception and Safari
  does not, so it discards the cookie and bounces back to `/signin`. Use Chrome, or serve the dev
  server over https (`next dev --experimental-https` with a `mkcert` certificate).

If the Blender cask cannot write to `/Applications` without a password, install it somewhere you own
with `brew install --cask blender --appdir=~/Applications` and point `BLENDER_PATH` there.

Everything runs on macOS with one difference, and it is a real one: **the CAD parser sandbox is
Linux-only.** `unshare` and `prlimit` are util-linux, so on macOS the sandbox probe fails and the
default `CAD_SANDBOX=prefer` logs a warning and parses unconfined. That is a reasonable trade on a
laptop reading your own files. It is not a reasonable trade on a server, where `CAD_SANDBOX=require`
should be set so the worker refuses to start rather than parse a stranger's file unconfined. See
[`deploy/cad-worker/README.md`](deploy/cad-worker/README.md).

`scripts/dev-db.sh` looks for the server binaries in `/usr/lib/postgresql/16/bin`. Elsewhere —
Homebrew, another major version — set `PG_BIN` to the directory holding `initdb` and `pg_ctl`.

## Getting started

```bash
pnpm install
pnpm test                     # unit suite, including the two-pack conformance gate
pnpm --filter @pr/web dev     # http://localhost:3000/design/demo
```

`/design/demo` is the whole editor against a fixture cap, with no account and no database: upload an
SVG, place it, change the finish, watch the preview. Nothing is saved, because there is nowhere to
save it.

### The real thing, locally

Saved designs, the catalog, uploads and renders all need a database and an account. The platform is
invite-only by construction, so the first account is created the same way every later one is.

```bash
# 1. A throwaway PostgreSQL under .tmp/ — safe to delete, `dev-db.sh reset` starts over.
export DATABASE_URL=$(./scripts/dev-db.sh start | tail -1)

# 2. Schema, row-level security and all.
pnpm db:migrate

# 3. Optional: sample products. A fresh install has an empty catalog; packs are the only way
#    anything enters it, and these two are the test fixtures. Skip this to start empty and add
#    your own at /admin/packs or /admin/cad. Importing the same contents again is a no-op. Changed contents under a version that is already
#    published are refused — designs are built on it, so it is never rewritten: give the pack a new
#    version, or pass --replace to overwrite it deliberately (still refused if a design uses a zone
#    the new contents drop). A draft is simply replaced.
pnpm import:pack fixtures/packs/cap-basic --publish
pnpm import:pack fixtures/packs/box-basic --publish

# 4. An organisation and an invitation. Prints a link — open it and set a password.
#    The first account is staff, so it can reach the admin console at /admin.
pnpm seed:dev you@example.com

# 5. The app.
pnpm --filter @pr/web dev     # http://localhost:3000
```

Signed-in navigation is **Designs · Artwork · Catalog · Renders**. `/artwork` is the organisation’s
shared SVG library: upload using **Upload SVG**, search or sort the four-column gallery, rename,
and delete unused artwork. Open a tile to view the SVG, change its name or dimensions, rotate or
flip it, and use undo/redo, zoom, pan and corner resize handles. Other artwork appears in a
horizontal strip below the editor; selecting it asks before discarding unsaved changes. **Back to
artwork** returns to the gallery. **Upload SVG** is hidden while an artwork is open.

**Save changes** stores shape edits as a new immutable version. Existing designs keep the version
they already place; choose the edited artwork from the design editor’s library to use it in a design.
Renaming changes only the shared label. Deletion is refused while a saved design uses any version.
**Archive artwork** in a tile’s overflow menu hides every version from the active library and
new-design pickers. **Active / Archived** switches views; **Restore artwork** makes it available
again. Saved designs using archived artwork stay visible with a pale amber **View-only** banner.
Their saved controls and new renders are disabled, while orbit, camera presets, cross-sections and
inspection lighting remain available as temporary viewing tools. Existing renders can still be
downloaded. Restore every archived file in a design to enable editing again. The catalogue product
remains usable with other artwork. See [artwork archive](docs/34-artwork-archive.md).

Whole-artwork transforms do not automatically update saved designs. See [W-17](docs/02-workflows.md#w-17--manage-and-edit-artwork) for the full workflow.


**SVG preparation:** Upload opens **Select → Review → Confirm**, with a styled source and the
prepared monochrome mark. Click objects or use the object/group list and color shortcuts. Only
selected visible paint is kept; unselected foreground paint still preserves counters and holes.
**Repair paths** is a separate optional mode: inspect open contours, keep usable strokes open,
preview a straight closure or compatible join, then explicitly **Apply repair**. Selection never
closes paths. Repair previews highlight added/removed paint and flag changes to transparent counters
for review. Unsupported content has a readable error and a re-export hint; it is never silently
removed from the source preview. Confirm dimensions and save before any library item is created.
From a saved design, saving returns to its library; choose the new artwork explicitly to place it.
The demo uses the same preparation core in the browser without persistence.

Source-backed versions offer **Edit selection** and **Download original SVG**. Whole-artwork
transforms remain composed with the selection recipe. Older uploads require an original-file
reupload and explicit **Save new version**; their discarded styles cannot be reconstructed.
Migration `0012_artwork_preparation.sql` adds nullable metadata to existing artwork versions and
preserves old records. Original bytes and safe editable source remain private under
`artwork-source/`; only a session/tenant-authorized attachment endpoint returns original bytes.
See [the preparation spec and supported subset](docs/29-artwork-preparation.md).

Then sign in and start from `/catalog`. Staff accounts also get `/admin`, where organisations,
limits and people are managed; `pnpm grant:staff someone@example.com` promotes an existing account
(and `--revoke` takes it back), which is the only way staff can be created without staff.

Uploaded artwork and imported pack assets are written to
`.tmp/storage` unless `STORAGE_ROOT` says otherwise; the database and the object store have to agree
about that path, so set it for every process or for none of them.

`./scripts/dev-db.sh stop` when you are done, `status` to check, `reset` to throw the cluster away.

### Renders

For an immediate image, choose **Snapshot** beside Render in the editor toolbar. It downloads a
PNG of the current 3D viewer at viewer resolution, including its current camera, lighting,
materials, artwork and displayed background. No render job or save is needed. Snapshot also works
in the demo and view-only designs; switch from Place to Viewer or Split to use it. Viewer controls
are excluded from the image. Use Render for a photorealistic export or a transparent background.
Snapshot filenames include the browser's local date and time, down to milliseconds, so repeated
captures have distinct names (for example, `My-cap-snapshot-2026-10-23_18-34-56-789.png`).

Rendering is a separate process reading a queue, so the editor stays responsive while Cycles works.

```bash
# One design straight to Cycles: the quickest check that this machine can render at all.
pnpm render:sample .tmp/sample

# The queue worker: renders submitted from the editor. Leave it running.
pnpm worker:render
```

`render:sample` takes its settings from the environment, which is what makes it quick to sweep:
`PRESET` (`draft`/`standard`/`final`), `SAMPLES`, `PX`, `SIZE_W`/`SIZE_H`, `CAMERA` or `PRESET_KEY`,
`OFFSET_X`/`OFFSET_Y`, `DEPTH`, `DISPLACE`, `DICING` and `ARTWORK` to point at your own SVG.

`scripts/screenshot.ts` refreshes the images in `docs/screenshots` against a running server
(`BASE_URL`, default `http://127.0.0.1:3100`).

`preview:probe` puts the two halves side by side — it drives `/design/demo` in a real browser and
captures the face view and the 3D preview, so they can be compared against `render:sample` output.
It needs a server already running (`BASE`, default `http://127.0.0.1:3100`, which is what
`scripts/e2e.sh` leaves behind), and writes to `OUT`.

The worker refuses to start if it cannot find a usable Blender, rather than claiming jobs it would
only fail: set `BLENDER_PATH` if `blender` is not on the path. `RENDER_THREADS` caps the tracer's
cores, which is worth doing on a laptop you are also using.

### CAD ingestion

A supplier sends a STEP file; the catalog needs a Product Pack. `/admin/cad` is the bridge, and it is
staff-only by design — it hands a stranger's file to a large native CAD parser, which is the most
dangerous thing in this product.

```bash
# The kernel. Without it, see the warning below.
pip install cadquery-ocp==7.9.3.1.1

# The queue worker: ingestions submitted from /admin/cad. Leave it running.
pnpm worker:cad
```

Then, signed in as staff:

1. **`/admin/cad`** — upload a `.step` file. The format is decided by reading the file, not by its
   extension, and a STEP file declaring a protocol with no solids in it is refused in milliseconds
   rather than after a minute of the kernel's time.
2. **Watch the job.** The worker tessellates at three levels of detail, re-validates everything the
   kernel hands back, and stages the meshes. The row shows the measured dimensions and part count —
   check the dimensions before anything else, because a file read in the wrong unit produces a pack
   that is plausible and wrong by a constant factor in every render.
3. **Draft a pack.** Give it a pack key, product name and category — geometry cannot supply those.
   You get a **draft** pack with one material slot per named assembly part, camera presets seeded
   from the symmetry axis, and no decoration zones.
4. **Author the zones** at `/admin/packs/<id>/zones`, then publish. The zones are empty on purpose:
   geometry cannot tell you where a customer may put a logo, and a zone in the wrong place is a logo
   in the wrong place on a real product.

> **Without OCCT installed, the worker does not fail — it falls back to a reference importer with no
> kernel behind it, which produces a parametric cylinder rather than your geometry.** That fallback
> exists so the queue, the validator and the whole storage path can be exercised in CI and on a
> laptop, and it is why the worker logs which importer it chose at startup. If a drafted pack looks
> nothing like the file you uploaded, read that line first: `importer=occt` is the real one,
> `importer=reference` is the stand-in. `CAD_IMPORTER=occt` forces the real one and fails loudly
> when it is missing.

`CAD_SANDBOX` decides what happens when the host cannot confine the parser — see the macOS note under
Requirements, and [`deploy/cad-worker/README.md`](deploy/cad-worker/README.md) for what the
confinement does and why there are two layers of it.

### Running it built

`pnpm --filter @pr/web dev` is the development server. A deployment wants the built app:

```bash
pnpm build:web
pnpm start:web                # http://localhost:3000, or PORT=... to move it
```

Worth knowing about the difference: the Content-Security-Policy middleware stamps a per-request nonce,
and Next only does that on **dynamically rendered** pages. That is why `/` and `/design/demo` carry
`export const dynamic = 'force-dynamic'` — statically prerendered, they would ship script tags the
policy then refuses, and the page would come up blank in a way `dev` never shows you.

### Backups

```bash
./scripts/backup.sh                 # database + object store, into .tmp/backups/<timestamp>
pnpm backup:drill                   # take one, restore it into a scratch database, compare
```

A backup nobody has restored is a hope, so the drill is the point: it restores into a scratch
database and a scratch directory, then compares every table's row count and every stored file's
digest against the live ones. Restoring for real needs an explicit target, and refuses to write
over `DATABASE_URL` unless told to:

```bash
TARGET_DATABASE_URL=postgres://… TARGET_STORAGE_ROOT=/srv/storage \
  ./scripts/restore.sh .tmp/backups/<timestamp>
```

Both scripts claim the staff context for their session, because every tenant table is
`force row level security` — that applies to the table owner too, so an ordinary `pg_dump` refuses
outright rather than risk writing a partial dump. A deployment may instead give its backup role
`BYPASSRLS`; the drill is what proves whichever choice was made actually works.

### Tests

```bash
pnpm test                     # unit and integration; CI requires PostgreSQL, OCCT and Blender
pnpm typecheck
pnpm lint                     # a short list of rules whose findings are bugs, not style
./scripts/e2e.sh              # builds, starts a server, runs the browser suite
./scripts/e2e.sh auth.spec.ts # one file; any playwright argument works
pnpm fixtures                 # regenerate the fixture artwork and meshes
pnpm bundle:budget            # gzipped bundle sizes against their budgets (needs pnpm build:web)
```

`scripts/e2e.sh` is self-contained: it starts the database if one is not already up, migrates,
imports both fixture packs, builds the app, starts a worker if this machine can render, and replaces
any server left over from a previous run. Do not run this script while another session owns a
local server: its cleanup is broad. Local suites can skip optional dependencies; CI requires the
database, CAD kernel, renderer and Linux sandbox and fails when they are unavailable. The `CI`
flag, set automatically by GitHub Actions, enables these required-prerequisite checks.

GitHub CI must pass on the PR head before merge unless explicitly waived for that PR. The workflow
is manually dispatched when it has not run. Browser CI starts the reference CAD worker for synthetic
inputs; the render job runs both parity and render lifecycle tests with real Blender. See
[the testing guide](docs/20-testing-ci.md) for job ownership and test prerequisites.

### Budgets

```bash
pnpm build:web && pnpm bundle:budget
```

Two numbers from `docs/19-frontend.md`, and one claim from the same page. The shell — what every
route pays before it has done anything — is measured as the chunks all routes have in common, so it
cannot drift out of date when the framework reorganises itself. The editor is the whole of
`/design/[id]`, which is allowed to be large and not allowed to be large and unwatched. The claim is
that three.js loads only where a 3D view does; one stray import in a shared component is all it
takes to put a WebGL renderer in front of someone signing in.

Sizes are gzipped. They will not match a CDN serving brotli to the byte — what matters is that the
number is computed the same way every time, so fifty kilobytes of growth reads as fifty kilobytes.

### Load

Two halves, because "the queue is fine" and "the API is fine" are different claims.

```bash
pnpm test                                      # the queue half runs with the rest
BASE_URL=… EMAIL=… PASSWORD=… DESIGN_ID=… k6 run load/api-saturation.js
```

The queue half is `packages/render-jobs/src/saturation.integration.test.ts`: a hundred submissions
arriving together and eight workers racing for the same rows, asserting no job runs twice, none is
dropped, and the quota holds under a burst rather than merely under a sequence. It runs in CI with
the other integration tests, because it is a correctness test that happens to need concurrency —
a `for update skip locked` queue behaves perfectly with two workers and hands the same job to three
of them the first afternoon it is busy.

It earned its place immediately: the concurrency quota let thirteen jobs past a limit of ten,
because fifty concurrent submissions all read the count before any of them inserted.

The API half needs k6 and a target worth measuring, so it is run per milestone against a deployed
environment rather than on a CI runner — a requests-per-second number from a shared runner is not a
fact about this system. What it checks is that the app sheds load on purpose: a 429 or a quota
refusal is a pass, a timeout or a 500 is not.

### Parity

```bash
./scripts/e2e.sh parity.spec.ts   # needs a machine that can render
```

The product's one promise is that what you arrange in the browser is what comes out of the path
tracer, and that promise is only kept if something measures it. This drives the real editor, reads
the preview's own drawing buffer, renders the same saved design through the real queue at the same
aspect, and scores the two with SSIM.

Two numbers, doing different jobs. The mean is a sanity floor — most of a product shot is backdrop,
so it cannot tell a well-placed logo from a badly placed one, but it catches an exposure or a tone
transform going wrong. The number about placement is the average of the worst one per cent of
windows: a matching pair measures about 0.57, and the same render against a mark six millimetres out
of place measures about 0.11. The test renders once and compares it against both previews, so a
budget that could not fail would fail the test.

It found three real disagreements while it was being written, all since fixed: orbit limits that
clamped the preview's camera closer than the preset frames it (the product drew nineteen per cent
large), a field of view derived from a fixed sensor height rather than the frame's actual shape, and
a backdrop the preview painted flat and untone-mapped where the renderer sweeps a gradient.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string. Unset means the demo route only, and integration tests skip. |
| `STORAGE_ROOT` | `<repo>/.tmp/storage` | Where uploaded artwork, pack assets and finished renders live. |
| `APP_URL` | `http://localhost:3000` | Origin used to build invitation and password-reset links. |
| `AUTH_INVITE_ACCEPT_LIMIT` | `10` | Invitation acceptances allowed per IP per ten minutes. Raise it for a deployment behind a single NAT, where a team onboarding together shares one address. |
| `ARTWORK_UPLOAD_LIMIT` | `30` | Artwork uploads allowed per account per five minutes. The end-to-end suite raises it, because every spec uploads through one shared account. |
| `ARTWORK_PREPARE_LIMIT` | Preparation analysis/preview requests per account per minute; defaults to 120. The isolated E2E suite uses 1000 for its shared account. |
| `BLENDER_PATH` | `blender` on the path | The renderer executable. |
| `RENDER_THREADS` | all cores | Cycles thread cap for the worker. |
| `RENDER_SCRATCH` | `.tmp/render-work` | Per-job working directory for bakes and generated scenes. |
| `RENDER_BACKEND` | `cycles-local` | Set to `fake` to run the whole render path — queue, worker, download — without a renderer installed. |
| `CAD_PYTHON` | `python3` | The interpreter that has the OCCT bindings. A container pins this; a laptop with several Pythons needs to say which. |
| `CAD_IMPORTER` | auto | `occt` forces the real kernel and fails loudly if it is missing; `reference` forces the kernel-free stand-in. Unset picks OCCT when present and warns when falling back. |
| `CAD_SANDBOX` | `prefer` | `require` refuses to start without a sandbox — set this on any server. `prefer` warns and parses unconfined. `off` is an explicit decision. Linux only; see Requirements. |
| `CAD_SCRATCH` | `.tmp/cad-work` | Per-job working directory. Deleted when the job ends; a stranger's CAD file does not outlive its import. |
| `CAD_THREADS` | all cores | Cap on OCCT's parallel meshing, worth setting on a machine you are also using. |
| `CAD_TIMEOUT_SEC` | `600` | Wall clock for one import. The parser's own CPU ceiling is derived from it. |
| `CAD_MAX_SOURCE_BYTES` | `268435456` | Largest file the worker will parse. Refused before the kernel sees it. |
| `CAD_PIPELINE_VERSION` | `2026.08.1` | Part of the ingestion dedupe key: the same file is only the same work while the pipeline reading it has not changed. Bump it when the kernel or the tessellation parameters change. |
| `CAD_UNSHARE` | `unshare` | Path to util-linux `unshare`, which builds the parser's namespaces. |
| `CAD_PRLIMIT` | `prlimit` | Path to util-linux `prlimit`, which applies the parser's ceilings at `exec`. |
| `ASSET_URL_SECRET` | a new one per process | Signs asset URLs. Set it in any deployment running more than one server, or half the images on a page fail. |
| `RESEND_API_KEY` | — | Resend API key. Unset means no mail is sent: invitations, resets and render notifications are logged and reach nobody. The application still works, because the console hands an administrator the invitation link, but nothing is delivered. `api.resend.com` has to be reachable — that failure arrives at runtime, not at deploy time. |
| `MAIL_FROM` | — | Envelope sender, e.g. `3D Product Renderer <no-reply@mail.example.com>`. The domain must be verified with the provider. Required alongside `RESEND_API_KEY`; a key without a sender sends nothing and says so once at startup rather than failing one message at a time. |
| `MAIL_REPLY_TO` | — | Optional. Unset means replies bounce. |
| `DEV_TOOLING` | `false` | Turns on the invitation endpoint and the in-memory mailbox — the stand-ins for an admin console. Development and the e2e suite only. |
| `ALLOW_DEV_TOOLING_IN_PRODUCTION` | `false` | Second, deliberate gate: `DEV_TOOLING` alone does nothing in a production build. |
| `E2E_PORT` | `3100` | Port `scripts/e2e.sh` serves the built app on. |
| `E2E_DATABASE` | `product_renderer_e2e` | The database `scripts/e2e.sh` runs against. The suite provisions accounts and imports packs on every run and tears none of it down, so it is given one of its own rather than whatever `DATABASE_URL` points at. |
| `E2E_STORAGE_ROOT` | `.tmp/e2e-storage` | The object store the suite writes pack assets, artwork and renders into, kept apart from `STORAGE_ROOT` for the same reason. |
| `E2E_KEEP_DATA` | unset | Set to anything to keep `E2E_DATABASE` and the e2e object store from the last run instead of starting from nothing. |
| `CHROMIUM_PATH` | `/opt/pw-browsers/chromium` | Browser for Playwright. Set it to the empty string to use Playwright's own download. |
| `PASSWORD_BREACH_CHECK` | on | Set to `off` where there is no outbound network; the local strength gate still applies. |
| `LOG_LEVEL` | `debug`, or `info` in production | Lowest level that reaches the log. |
| `LOG_FORMAT` | pretty, or JSON lines in production | Set to `json` to get machine-readable logs in development. |
| `PG_BIN` | `/usr/lib/postgresql/16/bin` | Where `scripts/dev-db.sh` finds the PostgreSQL server binaries. |

## Deploying it

`deploy/` holds what a single server needs: images for the web app and the render worker, one
compose file wiring them to PostgreSQL and Caddy, and an environment template.

### The first deployment

The step-by-step version is [QUICKSTART.md](QUICKSTART.md). In short, from a release tag:

```bash
cd deploy && cp .env.production.example .env && $EDITOR .env
docker compose up -d --build        # --profile cad adds STEP ingestion, uncertified in this release
docker compose exec -w /app web node --import tsx scripts/seed-dev.ts you@example.com
```

The last line prints an invitation link for the first, staff account. It runs the script with
`node --import tsx` from `/app`, as the `migrate` service does, because the web image has no pnpm.
A proper production setup command is the first work after the release (`F-SHIP-11`).

TLS is a prerequisite rather than a hardening step — the session cookie is `__Host-` prefixed, so
nobody can sign in over plain http off localhost. Caddy handles the certificate, but `APP_DOMAIN`
has to resolve to the droplet **before** the first `up`, or Let's Encrypt refuses.

Droplet sizing, first products, backups, and what the single-node design cannot do are in the
runbook, [`docs/27-deployment.md`](docs/27-deployment.md).

### Every deployment

The same three steps every time. Step 3 is the one that gets skipped.

**1. Check CI is green on the commit being deployed** — the `images` job in particular. It builds
both images through this same compose file, boots the stack, and waits for `/api/health`. A red
`images` job means the thing about to be run on the droplet does not start.

**2. Deploy.**

```bash
git fetch --tags && git checkout <new release tag> && docker compose up -d --build
```

Read that release's notes in [RELEASE-NOTES.md](RELEASE-NOTES.md) first, for any action it needs.
`migrate` runs to completion before `web` starts, every time. Migrations are forward-only: roll back
by restoring a backup, not by reversing one. Expect a few seconds of downtime — one web container,
no rolling deploy.

**3. Verify.** Four checks, because four different things can be broken while the port is open:

```bash
# The migration one-shot finished. If it did not, nothing else started either.
docker compose ps -a migrate            # exited (0)

# The app can reach the database and the object store — not merely that it is listening.
curl -sS https://your-domain/api/health # {"status":"ok"}

# The render worker is up. It has no healthcheck, so a crash-loop here is silent.
docker compose ps worker-render         # running

# Sign in, in a browser. The cookie is the one thing curl will not tell you about.
```

A 503 from `/api/health` names the part that is down — `{"status":"degraded","failed":["storage"]}`
— and says nothing an anonymous caller should not know. When something is wrong,
`docker compose logs --tail 100 <service>`, then section 6 of the runbook.

### What fails silently

Each of these leaves a stack that starts, serves pages, and is wrong. Worth re-reading before any
deployment that changes settings.

| If | Then | What guards it |
|---|---|---|
| `POSTGRES_USER` names the application role | it becomes the cluster superuser, and a superuser bypasses **every** row-level security policy — including under `force row level security`. Tenancy is off and nothing says so | two roles, the ordinary one created by [`deploy/postgres/10-app-role.sh`](deploy/postgres/10-app-role.sh); CI asserts `packaging` is not a superuser |
| `ASSET_URL_SECRET` is unset, or differs between the web app and the worker | each process invents its own at start-up, so a URL signed by one is rejected by the other and images 404 for no visible reason | set it once, the same value for every process; the env template carries the command to generate it |
| `APP_URL` does not match the real origin | invitation and password-reset links point somewhere that cannot sign anyone in | set it to the same https origin as `APP_DOMAIN` |
| anything terminates plain http | the `__Host-` cookie is discarded and sign-in bounces back to `/signin` saying nothing | Caddy, and nothing in front of it that downgrades |
| the render image's Blender moves off the 4.0 series | renders diverge from the SSIM budgets the parity suite is calibrated on, silently | the image asserts the series at build time; moving it is a parity-suite event, not a package upgrade |
| `pgdata` is backed up without `storage`, or at a different moment | the restore is a catalog referencing meshes and renders that are not there | back up both together — section 5 of the runbook |
| `CAD_SANDBOX` is weakened from `require` | a stranger's STEP file is parsed unconfined | it is set in `compose.yaml`, not the env file, so editing settings cannot reach it |
| `RESEND_API_KEY` is unset, or `api.resend.com` is unreachable from the server | every invitation, password reset and render notification is logged and delivered to nobody. Pages serve, but outside development the console never shows invitation links, so nobody past the first account can be invited and nobody can reset a password | the variable is in the deploy template with the consequence written beside it, and Compose passes it to every service; a key without `MAIL_FROM` logs a warning at start-up rather than failing one message at a time (`F-SHIP-12` makes that a start-up failure) |

## Documentation

Start at [`docs/README.md`](docs/README.md).

## Application visual system

The Wrap identity and workspace styling are documented in [the application style guide](docs/design-system/DESIGN.md). The scalable master is [wrap.svg](docs/brand/wrap.svg). Designs offers grid/list browsing, search, product filtering and sorting; **New design** opens the Catalog so the product is chosen explicitly. Per-design actions are in the overflow menu. The editor shares the global navigation; its toolbar **Render** action reveals the existing render settings without submitting a job. Admin Organizations supports search and status filtering, plus read-only email lookup across organizations. Open an organization for Overview, People, Products, Limits and Activity header sections; account controls live on person detail pages. See [organization workflows](docs/31-organization-workspace.md).

### Catalog product previews

Staff can open **Admin → Packs → Catalog previews**, choose **Generate preview** / **Regenerate
preview**, frame the product in the existing web viewer and press **Capture preview**. Only the
canvas is captured, without artwork or interface controls. No render worker is needed. Missing
images show **Preview not available**; a failed save keeps the previous image. For bulk publishing,
`pnpm catalog:thumbnails <folder>` accepts 768 × 576 viewer captures named
`<pack-key>--<variant-key>.png`. See [Catalog thumbnail workflow](docs/32-catalog-thumbnails.md).

## License and support

Released under the [MIT License](LICENSE). No support is offered: issues are open, but replies
aren't promised. To report a security problem, see [SECURITY.md](SECURITY.md).
