-- Per-member product access (docs/25-org-admin.md, F-ORG-03).
--
-- Catalog visibility has been per-organisation since the beginning: `pack_visibility` is
-- (pack_id, org_id) and it is enforced in row-level security rather than in a query somebody
-- remembered to filter. That is the right place for it, and it is why "which products may *this
-- person* use" cannot be answered in the interface — a checkbox that only hides a card leaves the
-- product reachable by anyone who types its URL.
--
-- So this goes in the policy too, on the same table, as one more clause on the same rule.

-- The organisation's context has carried a user since `withTenant` was written, and until now
-- nothing in SQL has read it. Same shape as `app_current_org`, and the same tolerance for absence:
-- a transaction with no user is a worker, not a person.
create or replace function app_current_user() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Deny by exception. A row here takes a product away from one person; no row means they have
-- whatever their organisation has.
--
-- The alternative — enumerate what each member may use — was considered and rejected: a product
-- added to an organisation would then reach nobody until an administrator granted it to every
-- member one at a time, and the failure mode of forgetting is a person who cannot work. The
-- failure mode here is a person who can see one product too many, which an owner can see and fix
-- on the member's own page.
create table user_pack_denials (
  user_id uuid not null references users (id) on delete cascade,
  pack_id uuid not null references product_packs (id) on delete cascade,
  -- Who took it away, and when. An access change is exactly the kind of thing somebody asks about
  -- six months later, and the audit log answers "what happened" while this answers "what is true".
  denied_by uuid references users (id) on delete set null,
  denied_at timestamptz not null default now(),
  primary key (user_id, pack_id)
);

-- Reading the other way round: "who cannot use this pack", for the catalog page's per-product view.
create index user_pack_denials_pack_idx on user_pack_denials (pack_id);

alter table user_pack_denials enable row level security;
alter table user_pack_denials force row level security;

-- A denial belongs to the organisation of the user it is about. Joining rather than duplicating
-- `org_id` on the row: a denormalised copy is a second source of truth for tenancy, and tenancy is
-- the one thing in this schema that must not have two.
create policy user_pack_denials_tenant on user_pack_denials
  using (
    app_is_staff()
    or exists (
      select 1 from users u
      where u.id = user_pack_denials.user_id and u.org_id = app_current_org()
    )
  )
  with check (
    app_is_staff()
    or exists (
      select 1 from users u
      where u.id = user_pack_denials.user_id and u.org_id = app_current_org()
    )
  );

-- The catalog rule, with one more clause.
--
-- Replaced whole rather than added beside: two policies on one table are OR-ed, so a second policy
-- could only ever grant more access, never less. A restriction has to live inside the rule it
-- restricts.
drop policy product_packs_visible on product_packs;

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
      -- Withheld from this person. A transaction with no person in it — the render worker, the CAD
      -- worker, anything under `withSystem` — denies nothing, because a denial is a statement about
      -- somebody and there is nobody here.
      and not exists (
        select 1 from user_pack_denials d
        where d.pack_id = product_packs.id and d.user_id = app_current_user()
      )
    )
  )
  with check (app_is_staff());
