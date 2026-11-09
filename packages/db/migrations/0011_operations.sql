-- What the platform is doing, for the people running it (F-ADM-07, F-PLAT-02, W-13, W-14).
--
-- Three gaps an operations audit found: a worker that died mid-job looked, for two minutes, exactly
-- like one that was working; nothing recorded a job's own log lines anywhere staff could read them;
-- and the error-reporter seam in @pr/observability was never connected, so an error went to a
-- terminal and nowhere else. All three live here, in the database everything else already uses,
-- rather than in a new service: the status page reads them with the queries it already runs.
--
-- Both tables are staff-only and bounded. Nothing here is customer data, and nothing grows forever.

-- Every worker process says it is alive every few seconds. Alive, stale and gone are derived from
-- `last_seen_at` when read, never stored, so a process that dies cannot leave itself marked alive.
create table workers (
  id text primary key,
  kind text not null check (kind in ('render', 'cad')),
  host text not null,
  pid integer not null,
  -- The renderer or kernel it drives and that build's version: what a job's provenance will say.
  engine text,
  engine_version text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Set by a clean shutdown, so "stopped" and "vanished" read differently.
  stopped_at timestamptz,
  current_job_id uuid
);
create index workers_seen_idx on workers (last_seen_at desc);

alter table workers enable row level security;
alter table workers force row level security;
create policy workers_staff on workers
  using (app_is_staff() or app_is_system())
  with check (app_is_staff() or app_is_system());

-- Warnings and errors from the web app and both workers, as the logger recorded them — already
-- redacted by it, so a token in a field name never arrives here.
create table service_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  service text not null,
  level text not null check (level in ('warn', 'error')),
  message text not null,
  fields jsonb not null default '{}',
  error jsonb,
  request_id text,
  job_id text
);
create index service_events_at_idx on service_events (at desc);

alter table service_events enable row level security;
alter table service_events force row level security;
create policy service_events_staff on service_events
  using (app_is_staff() or app_is_system())
  with check (app_is_staff() or app_is_system());

-- A job's own log: claimed, each stage, warnings, errors, outcome. On the job, because that is where
-- someone asking "what happened to this one" is already looking, and it goes when the job does.
-- Bounded by the writer, which keeps the newest lines.
alter table render_jobs add column log jsonb not null default '[]';
alter table cad_jobs add column log jsonb not null default '[]';
