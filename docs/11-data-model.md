# 11 — Data Model

Postgres 16. Drizzle for schema + migrations. Every org-scoped table carries `org_id` and is
protected by row-level security; the application also filters explicitly (belt and braces).

Conventions: `id uuid` default UUIDv7, `created_at/updated_at timestamptz not null default now()`,
soft delete via `deleted_at` only where restore is a product requirement, money in integer cents,
physical dimensions in millimetres stored as `numeric(10,3)`.

---

## Enums

```sql
create type user_role        as enum ('staff','owner','member');
create type user_status      as enum ('invited','active','suspended');
create type pack_status      as enum ('draft','published','deprecated');
create type asset_kind       as enum ('lod0','lod1','render_mesh','thumbnail','texture','blend');
create type zone_type        as enum ('planar','cylindrical','uv_rect','conformal','flat_panel');
create type artwork_status   as enum ('pending','ready','rejected');
-- height/normal are OPTIONAL caches for library thumbnails only; the render worker bakes height
-- per job from the SDF and the placement's finish params (see 14-artwork-pipeline.md).
create type artwork_asset_kind as enum ('mask','sdf','height','normal','contours','thumb','sanitized');
create type job_status       as enum ('queued','running','succeeded','failed','canceled');
create type output_kind      as enum ('image','video','thumb','contact_sheet');
create type finish_kind      as enum ('emboss','deboss','print');   -- mirrored in the design schema
create type cad_profile      as enum ('wasm','standard','heavy');   -- which worker class an ingestion needs
```

## Identity & tenancy

```sql
create table organizations (
  id uuid primary key,
  name text not null,
  slug citext not null unique,
  status text not null default 'active',
  settings jsonb not null default '{}',      -- theming (v3), defaults
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  email citext not null unique,
  password_hash text,                         -- null until invite accepted
  password_algo text not null default 'argon2id-v1',
  role user_role not null default 'member',
  status user_status not null default 'invited',
  email_verified_at timestamptz,
  totp_secret_enc bytea,                      -- v2
  failed_logins int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create index on users (org_id);

create table sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  token_hash bytea not null unique,           -- sha256 of the opaque cookie value
  ip inet, user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz
);
create index on sessions (user_id) where revoked_at is null;

create table invitations (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  email citext not null,
  role user_role not null default 'member',
  token_hash bytea not null unique,
  invited_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index invitations_active_email
  on invitations (org_id, email) where consumed_at is null and revoked_at is null;

-- Who made something is `on delete set null` everywhere it is recorded — invitations, packs,
-- artworks, designs, design versions, render and CAD jobs (0010). Deleting a person keeps what they
-- made for the organisation and loses only the name; a test asserts no reference to `users` can
-- block a delete. Sessions, resets, notifications and access denials cascade: they are about the
-- person, not their work.

create table password_resets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  org_id uuid,
  actor_user_id uuid,
  action text not null,                       -- 'invite.created', 'render.submitted', …
  target_type text, target_id text,
  metadata jsonb not null default '{}',
  ip inet,
  created_at timestamptz not null default now()
);
create index on audit_log (org_id, created_at desc);
```

## Catalog (Product Packs — global, optionally org-restricted)

```sql
create table product_packs (
  id uuid primary key,
  key text not null,                          -- 'closures.standard'
  version text not null,                      -- semver
  name text not null,
  status pack_status not null default 'draft',
  manifest jsonb not null,                    -- validated against PackManifest schema (12-schemas)
  digest bytea not null,                      -- sha256 of the bundle
  created_by uuid references users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (key, version)
);

create table pack_visibility (                -- absent rows = visible to all orgs
  pack_id uuid references product_packs(id) on delete cascade,
  org_id  uuid references organizations(id) on delete cascade,
  primary key (pack_id, org_id)
);

create table products (
  id uuid primary key,
  pack_id uuid not null references product_packs(id) on delete cascade,
  key text not null,                          -- 'cap-38-flat'
  name text not null,
  category text not null,
  facets jsonb not null default '{}',         -- pack-declared filter facets
  sort int not null default 0,
  status pack_status not null default 'draft',
  unique (pack_id, key)
);

create table product_variants (
  id uuid primary key,
  product_id uuid not null references products(id) on delete cascade,
  key text not null,
  name text not null,
  dimensions_mm jsonb not null,               -- {"diameter":38,"height":18,"bbox":[…]}
  material_slots jsonb not null,              -- [{"key":"body","label":"Cap body","default":"pp-matte"}]
  camera_presets jsonb not null default '[]',
  capabilities jsonb not null default '{}',   -- {"transmission":false,"video":true}
  unique (product_id, key)
);

create table product_assets (
  id uuid primary key,
  variant_id uuid not null references product_variants(id) on delete cascade,
  kind asset_kind not null,
  storage_key text not null,
  digest bytea not null,
  bytes bigint not null,
  meta jsonb not null default '{}',           -- {"triangles":128000,"uvSet":"decor"}
  unique (variant_id, kind)
);

create table decoration_zones (
  id uuid primary key,
  variant_id uuid not null references product_variants(id) on delete cascade,
  key text not null,
  name text not null,
  type zone_type not null,
  frame jsonb not null,                       -- projection frame; shape depends on type (see 15)
  size_mm jsonb not null,                     -- {"width":28.0,"height":28.0,"safeMargin":1.5}
  uv_rect jsonb,                              -- for uv_rect/conformal zones
  constraints jsonb not null default '{}',    -- {"maxDepthMm":0.6,"minStrokeMm":0.25,"finishes":["emboss","deboss","print"]}
  sort int not null default 0,
  unique (variant_id, key)
);

create table materials (
  id uuid primary key,
  org_id uuid references organizations(id) on delete cascade,  -- null = global library
  key text not null,
  name text not null,
  family text not null,                       -- 'plastic','metal','paperboard','glass','ink','foil'
  definition jsonb not null,                  -- neutral PBR definition (12-schemas)
  version int not null default 1,
  status pack_status not null default 'published',
  unique (coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid), key, version)
);

create table environments (
  id uuid primary key,
  key text not null unique,
  name text not null,
  hdri_key text not null,
  rotation_deg numeric(6,2) not null default 0,
  exposure_ev numeric(6,3) not null default 0,
  backdrop jsonb not null default '{}',
  status pack_status not null default 'published'
);
```

## Artwork

```sql
create table artworks (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_by uuid references users(id) on delete set null,
  current_version_id uuid,
  deleted_at timestamptz,
  archived_at timestamptz,                   -- 0013: reversible, across every version
  created_at timestamptz not null default now()
);
create index on artworks (org_id) where deleted_at is null;

create table artwork_versions (
  id uuid primary key,
  artwork_id uuid not null references artworks(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  version int not null,
  status artwork_status not null default 'pending',
  source_key text not null,                   -- quarantined original
  digest bytea not null,                      -- sha256(source bytes) - dedupe + cache key
  pipeline_version text not null,             -- artwork pipeline semver (provenance)
  natural_size_mm jsonb,                      -- from viewBox + units
  bbox jsonb,                                 -- normalized content bbox
  report jsonb not null default '{}',         -- errors[], warnings[], stats{}
  created_at timestamptz not null default now(),
  unique (artwork_id, version)
);
create unique index on artwork_versions (org_id, digest, pipeline_version);  -- dedupe re-uploads

create table artwork_assets (
  id uuid primary key,
  artwork_version_id uuid not null references artwork_versions(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  kind artwork_asset_kind not null,
  storage_key text not null,
  meta jsonb not null default '{}',           -- {"px":2048,"mmPerPx":0.0117,"range":[-2.4,3.1]}
  unique (artwork_version_id, kind)
);
```

## Designs

```sql
create table designs (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  product_variant_id uuid not null references product_variants(id),
  created_by uuid references users(id) on delete set null,
  current_version_id uuid,
  thumbnail_key text,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index on designs (org_id, updated_at desc) where deleted_at is null;

create table design_versions (
  id uuid primary key,
  design_id uuid not null references designs(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  version int not null,
  schema_version int not null,
  document jsonb not null,                    -- DesignDocument (12-schemas)
  label text,                                 -- named snapshot (v2)
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (design_id, version)
);
create index on design_versions using gin (document jsonb_path_ops);
```

Rationale: the design document is a single JSONB blob validated by a shared Zod schema, not a
normalized placement table. It is versioned, diffable, portable, and is exactly what both renderers
consume. Queries over placements are rare; queries over designs are by org/user/date.

## Rendering

```sql
create table render_jobs (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  design_version_id uuid not null references design_versions(id),
  submitted_by uuid references users(id) on delete set null,
  spec jsonb not null,                        -- RenderSpec, immutable
  spec_hash bytea not null,                   -- dedupe + idempotency
  status job_status not null default 'queued',
  priority int not null default 100,
  progress numeric(5,4) not null default 0,
  stage text,                                 -- 'assets','build','trace','denoise','encode','upload'
  attempts int not null default 0,
  error jsonb,
  renderer_id text, renderer_version text, worker_id text, gpu_model text,
  cost_estimate_cents int, cost_actual_cents int, gpu_seconds numeric(10,2),
  lease_expires_at timestamptz, trace_id text,
  log jsonb not null default '[]',            -- the worker's own lines for this job, newest 200
  queued_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz, canceled_by uuid
);
create index on render_jobs (org_id, queued_at desc);
create index on render_jobs (status, priority, queued_at) where status in ('queued','running');
create unique index on render_jobs (org_id, spec_hash) where status in ('queued','running','succeeded');

create table render_outputs (
  id uuid primary key,
  job_id uuid not null references render_jobs(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  kind output_kind not null,
  storage_key text not null,
  width int, height int, format text, bytes bigint,
  provenance jsonb not null,                  -- the determinism tuple (10-architecture)
  created_at timestamptz not null default now()
);
```

## CAD ingestion

The render queue's twin (see [23-cad-ingestion.md](23-cad-ingestion.md)). Its own table rather than a
widened `render_jobs`, because a render job has a design version, a GPU model and GPU seconds and an
ingestion has none of those. The mechanics they *do* share — lease, heartbeat, attempt cap,
quarantine, the quota lock — are shared as code in `@pr/job-queue`, not as columns.

```sql
create table cad_jobs (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  submitted_by uuid references users(id) on delete set null,
  source_key text not null,                   -- under cad-source/, which the asset route denies by name
  source_name text, source_bytes bigint not null,
  source_digest bytea not null,               -- sha256: the identity of an ingestion
  format text not null,                       -- sniffed from content; @pr/cad owns the list, not this column
  profile cad_profile not null default 'standard',
  status job_status not null default 'queued',
  priority int not null default 100,
  progress numeric(5,4) not null default 0,
  stage text,                                 -- 'parse','heal','analyse','tessellate','uv','decimate','write'
  attempts int not null default 0,
  error jsonb,
  importer_id text, importer_version text, pipeline_version text, worker_id text,
  result jsonb,                               -- the CadImportResult, re-validated before it is believed
  pack_id uuid references product_packs(id) on delete set null,
  cpu_seconds numeric(10,2), lease_expires_at timestamptz,
  log jsonb not null default '[]',            -- as on render_jobs
  queued_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz, canceled_by uuid, trace_id text
);
create index on cad_jobs (org_id, queued_at desc);
create index on cad_jobs (status, priority, queued_at) where status in ('queued','running');
-- Dedupe includes the pipeline version: the same file is only the same work while the pipeline
-- reading it has not changed, because every mesh digest downstream depends on it.
create unique index on cad_jobs (org_id, source_digest, pipeline_version)
  where status in ('queued','running','succeeded');
```

Ingestion is staff-only for v1 — it turns the most dangerous parser in the system into an endpoint —
but the table's policy is ordinary tenancy, so lifting that later is a decision at the API rather
than a migration.

## Operations (`0011_operations.sql`)

What the platform is doing, for the people running it. Neither table holds customer data; both are
staff-only and bounded. See [17-render-service.md](17-render-service.md) for how they are used.

```sql
-- Every worker process, reporting in every 10 s. Alive / stale / gone is derived from last_seen_at
-- when read, never stored, so a process that dies cannot leave itself marked alive.
create table workers (
  id text primary key,                        -- host-pid, the same id a job's worker_id carries
  kind text not null check (kind in ('render','cad')),
  host text not null, pid int not null,
  engine text, engine_version text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  stopped_at timestamptz,                     -- set by a clean shutdown
  current_job_id uuid
);

-- Warnings and errors from the web app and both workers, already redacted by the logger.
-- Kept 14 days and at most 20 000 rows; the writer prunes.
create table service_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  service text not null,                      -- 'web' | 'worker-render' | 'worker-cad'
  level text not null check (level in ('warn','error')),
  message text not null,
  fields jsonb not null default '{}',
  error jsonb,                                -- { name, message, stack? }
  request_id text, job_id text
);
```

## Quotas, usage, flags, idempotency, sharing

```sql
create table org_quotas (
  org_id uuid primary key references organizations(id) on delete cascade,
  renders_per_day int not null default 50,
  gpu_seconds_per_month int not null default 36000,
  storage_bytes bigint not null default 53687091200,
  max_concurrent_jobs int not null default 3,
  max_resolution_px int not null default 4096,
  -- Ingestion limits are their own numbers: minutes of CPU on a container with tens of gigabytes,
  -- so the cost of letting one loose is a machine rather than an invoice line.
  cad_ingests_per_day int not null default 20,
  max_concurrent_cad_jobs int not null default 2
);

create table usage_events (
  id bigserial primary key,
  org_id uuid not null, user_id uuid,
  kind text not null,                          -- 'render.gpu_seconds','artwork.upload','storage.delta'
  quantity numeric(14,3) not null,
  occurred_at timestamptz not null default now()
);
create index on usage_events (org_id, kind, occurred_at desc);

create table feature_flags (
  key text not null, org_id uuid references organizations(id) on delete cascade,
  enabled boolean not null default false,
  primary key (key, coalesce(org_id,'00000000-0000-0000-0000-000000000000'::uuid))
);

create table idempotency_keys (
  key text primary key,                        -- client key or spec hash
  org_id uuid not null, endpoint text not null,
  response jsonb, status int,
  created_at timestamptz not null default now()
);

create table share_links (                     -- v2
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  design_version_id uuid not null references design_versions(id) on delete cascade,
  token_hash bytea not null unique,
  password_hash text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
```

## Row-level security

Every request opens a transaction that sets the tenancy GUCs, then runs queries as a non-superuser
role. A forgotten `where org_id = …` therefore returns nothing rather than someone else's data.

```sql
-- once per request/transaction, set by the repository layer
set local app.user_id  = '…';
set local app.org_id   = '…';
set local app.is_staff = 'off';

alter table designs enable row level security;
create policy designs_tenant on designs
  using (org_id = current_setting('app.org_id')::uuid
         or current_setting('app.is_staff', true) = 'on')
  with check (org_id = current_setting('app.org_id')::uuid);
-- identical policies for: artworks, artwork_versions, artwork_assets, design_versions,
-- render_jobs, render_outputs, cad_jobs, usage_events, share_links, org_quotas, audit_log(read).
```

Catalog tables are readable by all authenticated users, filtered by `pack_visibility`:

```sql
create policy packs_visible on product_packs for select using (
  status = 'published' and (
    not exists (select 1 from pack_visibility v where v.pack_id = product_packs.id)
    or exists (select 1 from pack_visibility v
               where v.pack_id = product_packs.id
                 and v.org_id = current_setting('app.org_id')::uuid)
  )
  or current_setting('app.is_staff', true) = 'on'
);
```

Workers connect with a dedicated role that sets `app.org_id` from the job row before touching
org-scoped tables — workers get no ambient cross-tenant read.

`workers` and `service_events` are staff-only: their policy admits `app.is_staff` or
`app.is_system` and nothing else, so an organisation's session sees neither.

## Storage key layout

```
packs/{packKey}/{packVersion}/manifest.json
packs/{packKey}/{packVersion}/meshes/{productKey}/{variantKey}/{lod0|lod1|render}.glb
packs/{packKey}/{packVersion}/textures/{name}.ktx2
packs/{packKey}/{packVersion}/thumbs/{productKey}.webp

quarantine/{orgId}/{artworkId}/{versionId}/source.svg        # never served, never rendered
artwork/{orgId}/{artworkId}/{versionId}/sanitized.svg
artwork/{orgId}/{artworkId}/{versionId}/mask.png             # 1-channel coverage
artwork/{orgId}/{artworkId}/{versionId}/sdf.png              # 16-bit signed distance
artwork/{orgId}/{artworkId}/{versionId}/height.png           # 16-bit, finish-independent profile
artwork/{orgId}/{artworkId}/{versionId}/normal.png
artwork/{orgId}/{artworkId}/{versionId}/contours.json
artwork/{orgId}/{artworkId}/{versionId}/thumb.webp

designs/{orgId}/{designId}/thumb-{versionId}.webp
renders/{orgId}/{jobId}/output-{n}.{png|jpg|webp|mp4}
renders/{orgId}/{jobId}/thumb-{n}.webp
env/{envKey}/{name}.hdr

cad-source/{orgId}/{fileName}                                # never served, to anyone, ever
cad-out/{orgId}/{jobId}/{lod0|lod1|render}.glb               # staged until a pack accepts them
```

Buckets are private. Delivery is always a short-lived signed GET issued after an authorization
check; keys are never guessable-by-enumeration in a useful way and are never the security boundary.

## Migration policy

Expand → migrate → contract, always reversible. `design_versions.schema_version` allows old
documents to be read by a migration chain in `packages/design-schema` (see [12](12-schemas.md)) —
documents are never rewritten in place, so an approved render's inputs remain byte-stable.

## Artwork edit persistence (`F-ART-11`)

The standalone `/artwork` editor reuses `artworks`, `artwork_versions` and `artwork_assets`.
Whole-artwork transforms (`F-ART-11`) need no migration or new table. Source retention for `F-ART-12`
uses the additive migration described below. Shape edits append a version and atomically move
`artworks.current_version_id`; name-only edits update `artworks.name`. The edit supplies its expected
current version and the service checks it under `FOR UPDATE` before adoption. Version numbers
increase from the maximum historical version, even when a matching old version is reused.

Design documents keep their original `artwork.versionId`, and the source/mask/SDF/contour assets
under that version’s storage prefix remain immutable. The organisation/digest/pipeline unique index
continues to deduplicate uploads. Editing can reuse a matching version of the same artwork;
it cannot move a matching version from another artwork. Library deletion remains soft and blocked
when a saved design uses any version. The library exposes current entries only; history browsing
and "update to latest" remain planned.


## Prepared artwork source metadata (F-ART-12)

Migration `0012_artwork_preparation.sql` adds `original_key`, `editable_key`, and
`preparation_recipe` to `artwork_versions`, all nullable together for legacy records. A constraint
requires all three together for source-backed versions. Existing table RLS and version pointers
remain intact. Successful saves stage private originals at
`artwork-source/{orgId}/{artworkId}/{versionId}/original.bin` and regenerated editable SVG at
`.../editable.svg`; a failed adoption cleans staged assets. There is no draft table or service.

The recipe binds the raw source SHA-256 and analyzer version to selected per-instance object IDs,
fill/stroke choices, ordered explicit repairs, acknowledgements and composed whole-artwork
transforms. Prepared identity is SHA-256 of the canonical recipe with a domain prefix, plus the
existing pipeline version in the organization dedupe index. Raw byte identity is separate.
Different selections remain different versions; retries can return the identical committed result.
Old source-backed versions and derived assets remain immutable. Legacy records need their original
file for selection re-entry; normalized legacy SVG cannot recover discarded styles.

## Orientation persistence

No database migration or additional state store is introduced. The pack manifest owns the optional variant `presentationOrientation`; the existing derived variant rows continue to own material slots. Design versions hold an optional `scene.presentationOrientationOverride`. Immutable render specs capture the effective frame in `resolved.presentationOrientation`.

Catalog setup locks the pack row, checks a SHA-256 revision of the stored JSONB manifest, requires draft status and refuses a variant referenced by active designs. Saves are audited. Publishing rejects a present unconfirmed orientation; legacy manifests without the field retain prior eligibility. CAD diagnostics are matched by derived mesh digest within the staff user's organization, without exposing source CAD or crossing tenant boundaries.

## Artwork archive metadata (migration 0013)

`artworks.archived_at` is nullable and independent of deletion. Existing rows remain active.
Artwork and design assets are retained. Design read-only status is derived from all current
placements’ pinned version IDs and their parent artwork, rather than stored in design JSON.
Archive/restore and affected writes serialize with a tenant advisory transaction lock; existing
RLS still applies to every query. No new table or tenancy policy is needed.

Rollback requires reverting archive-aware application code first, then
`ALTER TABLE artworks DROP COLUMN archived_at` and removing the matching schema migration record.
That loses archive flags only; it does not delete artwork or design content.
