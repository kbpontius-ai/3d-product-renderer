-- Designs keep working on a retired pack version (F-ADM-13).
--
-- Publishing a new version of a pack now retires the old one to `deprecated`, so the catalog offers
-- one version rather than merging two into a product with every size twice. Deprecating has always
-- promised that existing designs keep working — but this policy only ever let a tenant read
-- `published` packs, so a design on a deprecated pack could not find its own product and 404'd.
--
-- A tenant may now also *read* a deprecated pack. What is offered for new designs is decided by the
-- catalog query, which still asks for `published` only; this widens what a design can resolve, not
-- what the catalog lists. Drafts stay staff-only, and per-organisation visibility and per-person
-- denials apply to a retired version exactly as they did while it was live.
drop policy product_packs_visible on product_packs;

create policy product_packs_visible on product_packs
  using (
    app_is_staff()
    or (
      status in ('published', 'deprecated')
      and (
        not exists (select 1 from pack_visibility v where v.pack_id = product_packs.id)
        or exists (
          select 1 from pack_visibility v
          where v.pack_id = product_packs.id and v.org_id = app_current_org()
        )
      )
      and not exists (
        select 1 from user_pack_denials d
        where d.pack_id = product_packs.id and d.user_id = app_current_user()
      )
    )
  )
  with check (app_is_staff());
