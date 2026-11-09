-- The CAD ingestion queue (docs/23-cad-ingestion.md).
--
-- Its own table rather than a widened `render_jobs`: a render job has a design version, a GPU model
-- and GPU seconds, and an ingestion has none of those. What the two share is the mechanics — the
-- lease, the heartbeat, the attempt cap, the quarantine — and those are shared as code, in
-- `@pr/job-queue`, rather than as columns.

-- Which worker class a job needs, from the file's size and shape count. The queue routes on it, so
-- a deployment that only ever ingests single closures never has to provision the heavy class.
create type cad_profile as enum ('wasm', 'standard', 'heavy');

create table cad_jobs (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  submitted_by uuid references users (id),

  -- The source file lives under the `cad-source/` prefix, which the asset route denies by name.
  -- This is the customer's supplier's most valuable file and it never leaves the server.
  source_key text not null,
  source_name text,
  source_bytes bigint not null,
  -- sha256 of the bytes. The identity of an ingestion, exactly as a spec hash is the identity of a
  -- render: the same file ingested twice at the same pipeline version is the same work.
  source_digest bytea not null,

  -- Decided by sniffing content, never by the extension. Deliberately text and not an enum: the
  -- format registry in `@pr/cad` is the authority on what is importable, and a second copy of that
  -- list here could only drift from it.
  format text not null,
  profile cad_profile not null default 'standard',

  status job_status not null default 'queued',
  priority integer not null default 100,
  progress numeric(5, 4) not null default 0,
  stage text,
  attempts integer not null default 0,
  error jsonb,

  -- Provenance. Determinism is pinned to a kernel build, so which one produced a mesh is part of
  -- what the mesh is, not a log line.
  importer_id text,
  importer_version text,
  pipeline_version text,
  worker_id text,

  -- The `CadImportResult`: bounding box, parts, repairs, mesh digests. Re-validated before it is
  -- believed, and kept afterwards because an operator asking "what did this file turn into" is
  -- asking about this.
  result jsonb,
  -- The draft pack this ingestion produced, once it has produced one.
  pack_id uuid references product_packs (id) on delete set null,

  cpu_seconds numeric(10, 2),
  lease_expires_at timestamptz,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  canceled_by uuid,
  trace_id text
);

create index cad_jobs_org_idx on cad_jobs (org_id, queued_at desc);
create index cad_jobs_dispatch_idx on cad_jobs (status, priority, queued_at)
  where status in ('queued', 'running');
-- Identical work is never paid for twice while it is live or already done.
create unique index cad_jobs_dedupe_idx on cad_jobs (org_id, source_digest, pipeline_version)
  where status in ('queued', 'running', 'succeeded');

-- Ingestion is CPU-bound and slow — minutes, not seconds — so its limits are their own numbers
-- rather than a share of the render quota. A missing row still must not mean unlimited; these
-- defaults are what the application falls back to and they agree with it.
alter table org_quotas
  add column cad_ingests_per_day integer not null default 20,
  add column max_concurrent_cad_jobs integer not null default 2;

-- Same tenancy story as every other table: the policy is what isolates organisations, and FORCE is
-- what stops the application role — which owns the table — from walking past its own policy.
--
-- Note what this does *not* decide: ingestion is staff-only for v1, because it turns the most
-- dangerous parser in the system into an endpoint. That is enforced where policy belongs, at the
-- API, so lifting it later is a decision rather than a migration.
alter table cad_jobs enable row level security;
alter table cad_jobs force row level security;
create policy cad_jobs_tenant on cad_jobs
  using (org_id = app_current_org() or app_is_staff())
  with check (org_id = app_current_org() or app_is_staff());
