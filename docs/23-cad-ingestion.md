# 23 — CAD ingestion pipeline

Scope for `F-ADM-01` and the missing half of `F-GEN-02`. Nothing here is built yet. This is the
design to argue with before anyone writes it.

## What it is for

Today a Product Pack arrives as a zip that already contains built glTF. Somebody has to have made
that glTF, and for the fixture packs that somebody is `scripts/make-fixture-meshes.ts`, which builds
a cap and a carton parametrically. Its own comment says "real packs are tessellated from CAD by the
ingestion pipeline" — this document is that pipeline.

The job: a supplier's STEP file goes in, and a publishable Product Pack comes out, with meshes at
the right scale, UVs good enough to put a logo on, LODs the browser can stream, a render mesh dense
enough to displace, and a thumbnail. Zone authoring, QA and publishing already exist and are not
re-specified here — this feeds them.

## The shape of it

Three seams, mirroring how rendering is already built, because that arrangement has earned it:

| Piece                       | What it is                                                                                                                                   | State                                                                                                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pr/cad`                   | TypeScript, no native dependencies. The job contract, the format registry, the budgets, the validator, and a kernel-free reference importer. | **Built.** The same role `@pr/render-backend` plays: a contract with a conformance suite, so a second importer can be proven equivalent instead of hoped equivalent.                                                                                                                                  |
| `@pr/job-queue`             | The lease, heartbeat, attempt cap, quarantine and quota lock, shared by every queue.                                                         | **Built.** Factored out of `render-jobs`, which now runs on it unchanged.                                                                                                                                                                                                                             |
| `@pr/cad-jobs` + `cad_jobs` | The ingestion queue.                                                                                                                         | **Built.**                                                                                                                                                                                                                                                                                            |
| `@pr/cad-occt`              | Python driving OCCT, run as a subprocess.                                                                                                    | **Built.** Exactly how `@pr/blender` drives Cycles: same cancellation, same timeouts, same "the native thing is a subprocess, not a library in our process". It reads STEP, heals, analyses and tessellates; the glTF is encoded on the TypeScript side by the encoder the mesh digests are keyed on. |
| `apps/worker-cad`           | Queue consumer and supervisor.                                                                                                               | **Built.** Same claim/lease/heartbeat machinery as `apps/worker-render`, plus the one thing the render supervisor does not do: it disbelieves its own worker, and runs everything the importer returns through the validator before storing a byte of it.                                             |

**A separate package, not a separate repository.** The contract is small and it shares the pack
schema, the storage adapter and the fixtures; splitting repositories would duplicate all three and
buy isolation we get anyway from the package boundary. The _runtime_ is a different matter: this
gets its own container image, because it carries a large native dependency and a much more hostile
threat model than anything else in the system, and those should not share a filesystem with the web
app.

**The queue.** `render_jobs` is render-shaped — it has `design_version_id`, `gpu_model`,
`gpu_seconds`. A CAD job has none of those, so it has its own table with the same mechanics. The
lease, heartbeat, attempt-cap and quarantine logic was factored out of
`packages/render-jobs/src/queue.ts` into `@pr/job-queue` rather than copied; it had already been
debugged once, including a quota race that only a saturation test found, and a copy would have been
a copy of that bug. The render queue's own tests pass unchanged on the shared version, which is what
makes the claim that nothing moved worth anything.

Two things `cad_jobs` does not inherit. It dedupes on the source digest **together with the pipeline
version**, because the same file is only the same work while the pipeline reading it has not
changed. And retrying is the exception rather than the rule: nearly every way an import fails
describes the file, and an unsupported schema will still be unsupported in ninety seconds.

## Formats

STEP first, and the seam is a registry rather than an `if`:

```ts
export type CadFormat = 'step' | 'iges' | 'brep' | 'stl' | 'parasolid' | 'jt';

export interface CadImporter {
  readonly id: string; // 'occt'
  readonly formats: readonly CadFormat[];
  probe(): Promise<{ available: boolean; version: string }>;
  import(request: CadImportRequest): Promise<CadImportResult | CadImportFailure>;
}
```

Adding Parasolid means registering an importer, not editing the pipeline. Two rules keep that true:

- **Detect by content, never by extension.** A STEP file begins `ISO-10303-21;`; IGES has its own
  header. The extension is a hint from whoever named the file, and the parser is the last place to
  be trusting a stranger's hint.
- **One normalised result type.** Every importer returns the same `CadImportResult` — shapes, units,
  bounding box, assembly tree — so everything downstream is written once. A format that cannot fill
  a field returns null rather than the pipeline learning what a Parasolid is.

## Stages

1. **Intake.** Sniff the format, cap the byte size, write to the quarantine prefix. No parsing yet.
2. **Parse and heal.** OCCT reads the file; sew open shells, fix orientations, drop free edges.
   Record every repair, because a healed shape is not the shape the supplier sent and somebody will
   eventually need to know that.
3. **Units and scale.** STEP declares its unit. Normalise to millimetres and _show the operator the
   overall dimensions before anything else happens_ — a file that comes in as inches and is treated
   as millimetres produces a plausible-looking pack that is wrong by 25.4× in every render.
4. **Analyse.** Bounding box, volume, watertightness, symmetry axis, assembly tree, part count.
   Bounds are evaluated from the precise geometry, independently of mesh density: OCCT's fast
   conservative box can overstate rounded faces. Volume uses adaptive integration (1e-9 relative
   integration tolerance) to avoid drift on spline/lofted faces. These calculations affect newly
   imported metadata and draft dimensions; they do not modify source geometry or rewrite existing
   stored imports/packs. A synthetic rounded-ring/twisted-loft fixture covers both regressions.
   Watertightness reaches the operator as a `not_watertight` todo on the draft rather than a
   refusal: an open shell is a legitimate part — a sleeve, a label, a formed liner — and a defect
   for anything moulded, and only somebody holding the supplier's drawing can tell which. The
   preview draws both sides so an open part does not read as a hole (docs/16), but Cycles renders
   the true surface, so publishing one is still a decision to make deliberately.
5. **Tessellate.** Deflection-controlled, per LOD. Deflection in millimetres, not a magic ratio, so
   the operator can reason about it.
6. **UV.** Authored where quality matters; `xatlas` as the fallback, flagged for review. See the
   risks — this is the hard part, not the tessellation.
7. **Decimate** to LOD0 and LOD1 against the bundle budgets `pnpm bundle:budget` already enforces.
8. **Render mesh.** Separate, denser output, dense enough for adaptive displacement.
9. **Thumbnail.** Capture the shared web viewer after drafting, through Admin → Packs → Catalog
   previews (`F-CAT-08`). Review the camera framing before saving; no render worker is needed.
10. **Draft pack.** Scaffold a manifest: one material slot per assembly part, cameras seeded from
    the symmetry axis, zones left empty for the existing authoring step.

Then the existing path takes over: zone authoring, test-pattern QA, publish.

**Where each stage stands.** Stages 1–5, 8 and 10 are built and running end to end against a real
kernel, plus the re-validation the supervisor does between 5 and 10. Stage 2 (heal) runs
`ShapeFix_Shape` and reports what it changed; a healed shape reaches the operator as a todo on the
pack draft rather than as a silent success.

Authored UVs remain open; thumbnails are a separate reviewed step after drafting:

- **Stage 6, authored UVs.** OCCT hands back each face's own surface parameters, which is what the
  four frame-based zone types never look at. A cylinder's `u` runs 0..2π and a trimmed face's range
  is whatever the trim left, so the meshes claim `auto` and nothing else — which is exactly what
  makes the validator refuse to draft a `uv` zone from them. `xatlas` is the next piece here, and
  decision 1 above is why it is not urgent.
- **Stage 9, thumbnail.** Built under `F-CAT-08`: frame the product in the shared web viewer and
  capture it after reviewing the drafted presets. It is deliberately not captured before that review.

**Stage 7, decimate**, is a budget the validator enforces rather than an operation performed: OCCT
tessellates straight to each LOD's deflection, and the budgets are checked against what comes out.
A part that cannot hit `lod0` at its deflection is refused rather than quietly coarsened, because a
mesh a zone was authored against is not something to change underneath it.

## Determinism

Same input, same pipeline version, same output bytes.

This is not tidiness. Render dedupe is keyed on a spec hash that includes the mesh digest, and the
parity budget is measured against a specific mesh. A tessellator that produces a different vertex
order on a different machine silently invalidates both. It needs a pinned OCCT version, fixed
deflection parameters, a stable sort before writing, and no timestamps in the GLB. The test is
cheap and belongs in CI from the first commit: ingest the same file twice, compare digests.

## Hardware

The pipeline is CPU and memory bound. No GPU, anywhere — which is deliberate, because it means CI
can run the real thing rather than a mock.

| Profile    | Where                        | Limits                  | For                                                           |
| ---------- | ---------------------------- | ----------------------- | ------------------------------------------------------------- |
| `wasm`     | in-process, `opencascade.js` | small files only        | Development and CI, where a native install would be a barrier |
| `standard` | container                    | 2–4 cores, 8 GB, 10 min | Single parts — a closure, a carton                            |
| `heavy`    | container                    | 16 cores, 32 GB, 60 min | Large assemblies                                              |

The job declares what it needs from the file's size and shape count; the queue routes to a worker
class. One environment variable caps threads, exactly as `RENDER_THREADS` does now, so the same
image runs on a laptop and on a build box. A deployment that only ever ingests single closures
should never have to provision the heavy class at all.

## Security

This is the most dangerous thing in the product: a large native C++ parser, written for a trusted
engineering context, fed files from outside. OCCT has a CVE history and there is no reason to
believe it is finished. Design as though the parser will be exploited, because the cheapest
assumption is that it already has been.

**Isolation.** Two layers, and neither replaces the other. `deploy/cad-worker/` is the outer one —
the image, capabilities, seccomp, read-only root, resource ceilings — and it holds when an operator
set it up as written. `packages/cad-occt/src/sandbox.ts` is the inner one, and it holds whether they
did or not. The outer layer is configuration and can therefore be misconfigured; the inner layer is
code with tests.

Built, and covered by `sandbox.integration.test.ts`:

- **No network at all** for the parser — an empty network namespace, not a filtered egress. The
  container itself _does_ have network, because the supervisor needs Postgres and object storage;
  only the parser must be offline, and it is. This is the single highest-value control here.
- **No view of any other process**, including the supervisor holding the database credentials. Worth
  one warning: `--pid` alone gives a new PID namespace and leaves the host's `/proc` mounted, so the
  confined process still reads every process on the box. It looks exactly like working.
  `--mount --mount-proc` is what makes it real, and a test counting processes is what caught it.
- **Hard memory, CPU-second and output-size ceilings**, applied by `prlimit` before the parser's own
  code runs, and applied again by the parser to itself for the case where it is invoked another way.
  A malformed shape can spin in tessellation with no exploit involved at all.
- **`CAD_SANDBOX=require`**, which the image sets: the worker refuses to start rather than parse a
  stranger's file unconfined.
- **One process per job, killed afterwards.** The parser is one-per-job and its scratch directory is
  deleted in a `finally`. The Node supervisor is long-lived, but it never parses CAD — the thing
  that reads hostile input is never reused between jobs or between tenants.

Specified but unverified — written where there is a Docker CLI and no daemon, so never built:
non-root, read-only root filesystem, tmpfs scratch with a size cap, dropped capabilities, the
seccomp profile, and the pids/memory/CPU ceilings. See `deploy/cad-worker/README.md`.

One trade to know about: the seccomp profile has to keep the namespace syscalls that the default
Docker profile blocks, or the nested confinement fails and the parser inherits the container's
network. The cleaner arrangement — a separate parser container per job with `network_mode: none` —
needs an orchestrator API to drive, and is the right target.

**Inputs.** Byte cap before parse; entity, shape and nesting-depth caps during. Refuse rather than
attempt: a 4 GB assembly is not a thing to be brave about.

**Source CAD never leaves the server.** `F-PLAT-04` says so and it is already half-enforced — packs
may only declare servable asset types. Add the other half: source files live under a
`cad-source/{orgId}/…` prefix that the asset route _denies by name_, not merely omits from the
allow-list, so a future refactor cannot quietly make it servable. Separate retention, separate
encryption key, and it is the customer's supplier's most valuable file, so treat deletion as a
feature rather than an afterthought.

**Trust nothing that comes back.** The TypeScript side re-validates the sidecar's output — file
magic, digests, triangle counts, bounding box sanity, no NaN, a tree that is a tree — before any of
it becomes a pack. The sidecar is inside the blast radius; the validator is not. Built, in
`packages/cad/src/validate.ts`, and the supervisor also refuses to carry a file the importer wrote
but did not declare: the output directory is not a channel.

Two more things the supervisor checks before the kernel sees anything: the byte cap, and that the
file still hashes to what the job was submitted with. A file swapped underneath a queued job is a
different ingestion wearing that job's row, and its meshes would carry that job's provenance.

**Staging, not publishing.** Meshes land under `cad-out/{orgId}/{jobId}/` and stay there until
someone has looked at the dimensions and accepted them. `packs/` is served to every signed-in
account the catalog allows; it is not a place to stage something nobody has approved.

**Supply chain.** Pin the OCCT version and the Python dependencies by hash, produce an SBOM, and
watch the CVE feed for the kernel specifically. This dependency will need patching on someone
else's schedule.

The interpreter is `CAD_PYTHON`, and the bindings are whatever it has — `cadquery-ocp` and
`pythonocc-core` both expose the `OCP`/`OCC` modules this uses. The container image is where the
version gets pinned; the importer reports whatever it found in its probe, and that version is
recorded on every job, because determinism is pinned to a build and a mesh digest means nothing
without knowing which one produced it.

**Staff only, for now.** Customer-uploaded CAD is a materially larger step: it turns the most
dangerous parser in the system into an endpoint anyone with an account can reach. Recommend keeping
ingestion staff-only for v1 and treating customer upload as its own project with its own review.

## Exports

| Format         | State                                                         |
| -------------- | ------------------------------------------------------------- |
| PNG (8/16-bit) | Implemented — `F-REND-05`, the default for renders.           |
| JPEG           | Implemented, alongside WebP.                                  |
| STEP           | **Backlog.** See below — it is not a variation on the others. |

STEP _export_ is worth being clear-eyed about. Handing back a modified solid means performing the
emboss as a boolean against the original B-rep in the kernel — not on the mesh. It is a different
operation from anything the render path does, it is where CAD kernels are slowest and least
reliable, and the result has to be manifold enough for a toolmaker to accept. It is already
`F-EXP-04` at P2 and should stay there, but it should be scoped as its own piece of work rather
than bundled into "exports".

## Features worth adding while the pipeline is being built

Proposals, not commitments. Each is cheap _now_ and expensive to retrofit:

- **Reproducibility check in CI** — ingest a fixture twice, compare digests. Guards the determinism
  everything else depends on.
- **Assembly → material slots.** A STEP assembly already names its parts. That maps directly onto
  the material slots a pack declares, and it is free at ingestion time and tedious by hand.
- **Symmetry-axis detection to seed cameras.** A closure has an obvious axis; deriving the camera
  presets from it beats an author guessing angles.
- **Manufacturability analysis** — draft angle, undercut, wall thickness. This is a packaging
  product, and a supplier who learns at ingestion that a zone has no draft is better served than one
  who learns it from a tool trial.
- **A golden CAD corpus.** A dozen real files with known-good outputs, run in CI. The regression
  suite for a tessellator is a set of files, not a set of assertions.

## Decisions

These four were open when this was first written. They are settled, and the reasoning is here so a
later reader can tell a decision from an assumption.

### 1. UV unwrapping — de-risked by the zone model, not by better unwrapping

The worry was that auto-UV produces charts too distorted to place a logo at a precise millimetre.
It does. It also mostly does not matter here, because of a choice this codebase already made:
of the five zone types, four — `planar`, `cylindrical`, `conformal`, `flat_panel` — address geometry
through a **frame in millimetres**, not a UV chart. Only `uv_rect` depends on the unwrap. Both
fixture packs, a curved closure and a flat carton, use frames.

So:

- **Decoration placement never depends on unwrap quality** for frame-based zones. The mapping from
  millimetres to the surface is analytic — `packages/placement/src/mappers.ts` already does it, and
  a cylinder unrolls isometrically, which is why its `metric()` returns exactly 1.
- **`xatlas` auto-UV is for base material texturing only** — the knurl, the kraft, the linen. A
  chart seam in the middle of a texture tile is invisible; a chart seam in the middle of a logo is
  the product failing. Auto-UV output carries a review flag and is never used for a decoration zone.
- **`uv_rect` zones require authored UVs and say so.** Ingestion refuses to draft a `uv_rect` zone
  from an auto-unwrapped mesh; an author who wants one brings a mesh with a `decor` UV set.

This turns the largest risk into a constraint the system already satisfies. It also means the
pipeline can ship before anyone solves chart packing.

### 2. Re-tessellation — immutable versions, zones carried forward as proposals

- **A re-tessellation is always a new pack version.** Never an edit in place. Pack versioning
  already exists; this makes it a rule. Mesh digests are what render dedupe and the parity budget
  are keyed on, so an in-place change would silently invalidate both for every design already made
  against that pack. The importer enforces it: changed contents under a published or deprecated
  `key@version` are refused (`version_exists`), and the upload preview says the version already
  exists. Only a draft is replaced in place; `--replace` on the command line overrides deliberately,
  and even then refuses to drop a zone any design uses.
- **Existing designs keep pointing at the version they were made against.** They do not follow the
  new one. A design's product reference already carries `packVersion`.
- **Zones carry forward as proposals, re-validated, never silently re-projected.** Because zones are
  frames in millimetres rather than UV charts, a re-tessellation of the same part usually leaves
  them valid — the geometry did not move, only its triangulation. So the pipeline re-runs
  `checkPackInvariants` plus the existing zone-check against the new mesh and presents the result:
  green means one click to accept, a failure means re-authoring. Automatic acceptance is refused
  even when the check passes, because "the numbers still validate" is not the same as "the logo
  still lands where the customer approved it".
- **Parity baselines are per pack version**, which the harness already handles: it renders whatever
  the design points at.

### 3. Licensing — LGPL is comfortable, given the architecture already chosen

OCCT is LGPL-2.1 with an exception. The subprocess-in-its-own-container design, chosen for security
reasons, happens to make the licensing question easy:

- **Unmodified, dynamically linked, in a separate process.** No static linking into anything we
  ship, no patched kernel. This is the arrangement LGPL is least ambiguous about.
- **Ship the licence text and an SBOM** with the container image, and keep the OCCT version pinned
  and recorded in the ingestion provenance, so any pack can be traced to the kernel build that made
  it.
- **If a commercial kernel is ever needed** — for a format OCCT reads badly, most likely Parasolid or
  JT — the importer registry is the seam it plugs into, and nothing above it changes.
- The one thing to avoid is vendoring a modified OCCT into the application image. If that ever looks
  necessary, it is a legal question before it is an engineering one.

### 4. The queue — Postgres, and the tech stack is corrected

`docs/04-tech-stack.md` named BullMQ on Redis. What exists is Postgres-as-queue with
`for update skip locked`, leases, heartbeats, dedupe by content hash, quotas and a saturation test
that found and fixed a real concurrency bug. That is the answer.

- **No Redis.** Adding it for a second worker would mean two queue implementations, two failure
  modes and two things to operate, to gain nothing this workload needs.
- **`cad_jobs` is its own table** — `render_jobs` is render-shaped and a CAD job has no
  `design_version_id` or `gpu_seconds` — but the claim, lease, heartbeat, attempt-cap and quarantine
  logic is **shared code**, not copied. It has been debugged once already.
- The tech stack document is corrected rather than left to disagree with the code.

## Remaining risks

1. **Skills.** This is CAD-domain work — deflection, sewing, healing, chart packing — and it is not
   adjacent to the rest of the codebase. It is the part where an inexperienced implementation
   produces output that looks right and is subtly wrong. Budget for review by someone who has done
   it before.
2. **Cost.** CPU-hours per ingestion, plus storing source CAD indefinitely on the customer's behalf.
3. **Supplier file quality.** Real STEP files from real suppliers are worse than test files: wrong
   units, open shells, thousands of tiny faces, whole assemblies where a part was expected. The
   healing stage and the operator confirmation exist because of this, and the golden corpus should
   be built from genuinely bad files rather than clean ones.

## Guided completion after ingestion

CAD draft generation now seeds an explicit unconfirmed presentation frame (+Z Front, +Y Up) as a starting choice, not an inferred semantic orientation. Existing kernel output, units, asset digests, part/material identities and provisional mesh-space geometry are preserved. Staff confirms the frame visually in Orientation, then authors zones and reviews material defaults before publishing.

Processed jobs and existing drafted-pack links open **Continue setup**. Import/Review show available original filename, importer/pipeline, dimensions, part/triangle counts, assumed-unit/open-surface notices, recorded repairs and job logs. Matching uses the derived mesh digest and tenant scope; packs without accessible job provenance say diagnostics are unavailable. Published products reorient through a new draft version without reconversion. Do not advise rotating/re-exporting CAD to fix presentation lighting.

## Empty assembly components and drawable bounds (`F-PREV-08`)

OCCT may return a named assembly component with no triangles before a drawable child. New GLB
output omits such empty primitives and draft material-slot generation omits their unused slots,
while retaining original part diagnostics. Material naming and indices derive from the same
filtered part set. Derivation records bounds measured from surviving geometry in scene space;
it does not invent dimensions from an empty component's infinite accessor bounds.

Old stored packs remain readable. Render jobs repair their known empty-mesh defect in scratch
instead of requiring reimport or rewriting the published source. Zone authoring can explicitly
select **Artwork target part** when several drawable parts are available. Retargeting affects
physical placement, so it requires an unused draft; published/used targets remain immutable.
