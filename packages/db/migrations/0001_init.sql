-- Initial schema. Mirrors docs/11-data-model.md.
--
-- Written as SQL rather than generated, because the parts that matter most here — row-level
-- security, partial unique indexes, the single-use guarantees on tokens — are exactly the parts a
-- schema generator would not express. Migrations are append-only and reversible in review.

create extension if not exists "citext";

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------
-- Roles and permissions (F-AUTH-07). Every read and write is org-scoped by the row-level
-- security policies below; the role decides what may be done inside an organisation, and `staff`
-- is the only one that crosses between them.
create type user_role as enum ('staff', 'owner', 'member');
create type user_status as enum ('invited', 'active', 'suspended');
create type pack_status as enum ('draft', 'published', 'deprecated');
create type asset_kind as enum ('lod0', 'lod1', 'render_mesh', 'thumbnail', 'texture', 'blend');
create type zone_type as enum ('planar', 'cylindrical', 'uv_rect', 'conformal', 'flat_panel');
create type artwork_status as enum ('pending', 'ready', 'rejected');
create type artwork_asset_kind as enum ('mask', 'sdf', 'height', 'normal', 'contours', 'thumb', 'sanitized');
create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');
create type output_kind as enum ('image', 'video', 'thumb', 'contact_sheet');

-- ---------------------------------------------------------------------------------------------
-- Tenancy helpers. Every policy reads these; they fail closed when unset.
-- ---------------------------------------------------------------------------------------------
create or replace function app_current_org() returns uuid language sql stable as $$
  select nullif(current_setting('app.org_id', true), '')::uuid
$$;

create or replace function app_is_staff() returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('app.is_staff', true), ''), 'off') = 'on'
$$;

-- ---------------------------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------------------------
create table organizations (
  id uuid primary key,
  name text not null,
  slug citext not null unique,
  status text not null default 'active',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  email citext not null unique,
  password_hash text,
  password_algo text not null default 'argon2id-v1',
  role user_role not null default 'member',
  status user_status not null default 'invited',
  email_verified_at timestamptz,
  totp_secret_enc bytea,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create index users_org_idx on users (org_id);

create table sessions (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  token_hash bytea not null unique,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;

create table invitations (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  email citext not null,
  role user_role not null default 'member',
  token_hash bytea not null unique,
  invited_by uuid references users (id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
-- One live invitation per address per org: resending revokes the previous one.
create unique index invitations_active_email_idx on invitations (org_id, email)
  where consumed_at is null and revoked_at is null;

create table password_resets (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  org_id uuid,
  actor_user_id uuid,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}',
  ip inet,
  created_at timestamptz not null default now()
);
create index audit_log_org_idx on audit_log (org_id, created_at desc);

create table org_quotas (
  org_id uuid primary key references organizations (id) on delete cascade,
  renders_per_day integer not null default 50,
  gpu_seconds_per_month integer not null default 36000,
  storage_bytes bigint not null default 53687091200,
  max_concurrent_jobs integer not null default 3,
  max_resolution_px integer not null default 4096
);

-- ---------------------------------------------------------------------------------------------
-- Catalog: product packs are the only way products enter the system.
-- ---------------------------------------------------------------------------------------------
create table product_packs (
  id uuid primary key,
  key text not null,
  version text not null,
  name text not null,
  status pack_status not null default 'draft',
  manifest jsonb not null,
  digest bytea not null,
  created_by uuid references users (id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (key, version)
);

create table pack_visibility (
  pack_id uuid not null references product_packs (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  primary key (pack_id, org_id)
);

create table products (
  id uuid primary key,
  pack_id uuid not null references product_packs (id) on delete cascade,
  key text not null,
  name text not null,
  category text not null,
  facets jsonb not null default '{}',
  sort integer not null default 0,
  status pack_status not null default 'draft',
  unique (pack_id, key)
);

create table product_variants (
  id uuid primary key,
  product_id uuid not null references products (id) on delete cascade,
  key text not null,
  name text not null,
  dimensions_mm jsonb not null,
  material_slots jsonb not null,
  camera_presets jsonb not null default '[]',
  capabilities jsonb not null default '{}',
  unique (product_id, key)
);

create table product_assets (
  id uuid primary key,
  variant_id uuid not null references product_variants (id) on delete cascade,
  kind asset_kind not null,
  storage_key text not null,
  digest bytea not null,
  bytes bigint not null,
  meta jsonb not null default '{}',
  unique (variant_id, kind)
);

create table decoration_zones (
  id uuid primary key,
  variant_id uuid not null references product_variants (id) on delete cascade,
  key text not null,
  name text not null,
  type zone_type not null,
  frame jsonb,
  size_mm jsonb not null,
  uv_rect jsonb,
  constraints jsonb not null default '{}',
  sort integer not null default 0,
  unique (variant_id, key)
);

create table materials (
  id uuid primary key,
  org_id uuid references organizations (id) on delete cascade,
  key text not null,
  name text not null,
  family text not null,
  definition jsonb not null,
  version integer not null default 1,
  status pack_status not null default 'published'
);
create unique index materials_key_idx
  on materials (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), key, version);

create table environments (
  id uuid primary key,
  key text not null unique,
  name text not null,
  hdri_key text not null,
  rotation_deg numeric(6, 2) not null default 0,
  exposure_ev numeric(6, 3) not null default 0,
  backdrop jsonb not null default '{}',
  status pack_status not null default 'published'
);

-- ---------------------------------------------------------------------------------------------
-- Artwork
-- ---------------------------------------------------------------------------------------------
create table artworks (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  created_by uuid references users (id),
  current_version_id uuid,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
create index artworks_org_idx on artworks (org_id) where deleted_at is null;

create table artwork_versions (
  id uuid primary key,
  artwork_id uuid not null references artworks (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  version integer not null,
  status artwork_status not null default 'pending',
  source_key text not null,
  digest bytea not null,
  pipeline_version text not null,
  natural_size_mm jsonb,
  bbox jsonb,
  report jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (artwork_id, version)
);
-- Re-uploading the same bytes through the same pipeline reuses the work.
create unique index artwork_versions_dedupe_idx on artwork_versions (org_id, digest, pipeline_version);

create table artwork_assets (
  id uuid primary key,
  artwork_version_id uuid not null references artwork_versions (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  kind artwork_asset_kind not null,
  storage_key text not null,
  meta jsonb not null default '{}',
  unique (artwork_version_id, kind)
);

-- ---------------------------------------------------------------------------------------------
-- Designs
-- ---------------------------------------------------------------------------------------------
create table designs (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  product_variant_id uuid not null references product_variants (id),
  created_by uuid references users (id),
  current_version_id uuid,
  thumbnail_key text,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index designs_org_updated_idx on designs (org_id, updated_at desc) where deleted_at is null;

create table design_versions (
  id uuid primary key,
  design_id uuid not null references designs (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  version integer not null,
  schema_version integer not null,
  document jsonb not null,
  label text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (design_id, version)
);
create index design_versions_document_idx on design_versions using gin (document jsonb_path_ops);

-- ---------------------------------------------------------------------------------------------
-- Rendering
-- ---------------------------------------------------------------------------------------------
create table render_jobs (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  design_version_id uuid not null references design_versions (id),
  submitted_by uuid references users (id),
  spec jsonb not null,
  spec_hash bytea not null,
  status job_status not null default 'queued',
  priority integer not null default 100,
  progress numeric(5, 4) not null default 0,
  stage text,
  attempts integer not null default 0,
  error jsonb,
  renderer_id text,
  renderer_version text,
  worker_id text,
  gpu_model text,
  cost_estimate_cents integer,
  cost_actual_cents integer,
  gpu_seconds numeric(10, 2),
  lease_expires_at timestamptz,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  canceled_by uuid
);
create index render_jobs_org_idx on render_jobs (org_id, queued_at desc);
create index render_jobs_dispatch_idx on render_jobs (status, priority, queued_at)
  where status in ('queued', 'running');
-- Identical work is never paid for twice while it is live or already done.
create unique index render_jobs_dedupe_idx on render_jobs (org_id, spec_hash)
  where status in ('queued', 'running', 'succeeded');

create table render_outputs (
  id uuid primary key,
  job_id uuid not null references render_jobs (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  kind output_kind not null,
  storage_key text not null,
  width integer,
  height integer,
  format text,
  bytes bigint,
  provenance jsonb not null,
  created_at timestamptz not null default now()
);

create table usage_events (
  id bigserial primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid,
  kind text not null,
  quantity numeric(14, 3) not null,
  occurred_at timestamptz not null default now()
);
create index usage_events_org_idx on usage_events (org_id, kind, occurred_at desc);

create table idempotency_keys (
  key text primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  endpoint text not null,
  response jsonb,
  status integer,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Row-level security.
--
-- FORCE is essential: without it the table owner — which is the application role — bypasses its own
-- policies, and the safety net would exist only on paper.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'sessions', 'invitations', 'org_quotas', 'audit_log',
    'artworks', 'artwork_versions', 'artwork_assets',
    'designs', 'design_versions',
    'render_jobs', 'render_outputs', 'usage_events', 'idempotency_keys'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I using (org_id = app_current_org() or app_is_staff()) '
      'with check (org_id = app_current_org() or app_is_staff())',
      t || '_tenant', t
    );
  end loop;
end
$$;

-- Organizations are visible only as your own.
alter table organizations enable row level security;
alter table organizations force row level security;
create policy organizations_tenant on organizations
  using (id = app_current_org() or app_is_staff())
  with check (id = app_current_org() or app_is_staff());

-- Catalog: published packs are readable by everyone they are visible to; staff see everything.
alter table product_packs enable row level security;
alter table product_packs force row level security;
create policy product_packs_visible on product_packs
  using (
    app_is_staff()
    or (
      status = 'published'
      and (
        not exists (select 1 from pack_visibility v where v.pack_id = product_packs.id)
        or exists (
          select 1 from pack_visibility v
          where v.pack_id = product_packs.id and v.org_id = app_current_org()
        )
      )
    )
  )
  with check (app_is_staff());
