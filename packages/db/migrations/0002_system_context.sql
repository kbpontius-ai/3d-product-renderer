-- Pre-session access.
--
-- Signing in, accepting an invitation and resetting a password all have to read org-scoped tables
-- BEFORE any organisation is known — the token in the request is the authorization, and the row it
-- points at is what tells us which tenant the caller belongs to. Under the tenant policies alone
-- those lookups return nothing, so the flows silently fail closed.
--
-- Rather than widen the tenant policy or run these paths as staff (which would grant cross-tenant
-- access to everything), the application declares a narrow system context that reaches only the
-- tables the account lifecycle needs.

create or replace function app_is_system() returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('app.is_system', true), ''), 'off') = 'on'
$$;

do $$
declare
  t text;
begin
  foreach t in array array['users', 'sessions', 'invitations', 'audit_log', 'organizations']
  loop
    execute format(
      'create policy %I on %I using (app_is_system()) with check (app_is_system())',
      t || '_system', t
    );
  end loop;
end
$$;

-- `organizations` is included because every one of those lookups joins it: an invitation into a
-- suspended organisation must not be acceptable, and that check needs the row.

-- password_resets is not org-scoped and had no policy at all; give it the same treatment as the
-- others so it is protected by default and reachable only from the reset flow.
alter table password_resets enable row level security;
alter table password_resets force row level security;
create policy password_resets_system on password_resets
  using (app_is_system()) with check (app_is_system());
