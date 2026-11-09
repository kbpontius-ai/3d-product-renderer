-- Notifications (F-REND-08).
--
-- A render takes minutes, so the person who asked for it has usually gone to do something else.
-- Telling them it finished is the difference between a tool people use and a tool people babysit.
--
-- Rows are per user rather than per organisation: a colleague's render finishing is not news, and a
-- shared inbox would make everyone's bell useless within a day.
create table notifications (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid references users (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  /** Where to go when it is clicked; relative to the app. */
  link text,
  metadata jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on notifications (user_id, created_at desc)
  where read_at is null;
create index notifications_org_idx on notifications (org_id, created_at desc);

alter table notifications enable row level security;
alter table notifications force row level security;
create policy notifications_tenant on notifications
  using (org_id = app_current_org() or app_is_staff())
  with check (org_id = app_current_org() or app_is_staff());

-- Whether each person wants email as well as the bell. Absent means the default: email only for
-- renders slow enough that nobody would have waited for them.
alter table users add column notify_email boolean not null default true;
