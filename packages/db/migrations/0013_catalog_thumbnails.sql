-- Presentation assets are separate from imported manifests: regenerating a picture must not
-- rewrite a published product version that customer designs have pinned.
create table catalog_thumbnails (
  variant_id uuid primary key references product_variants(id) on delete cascade,
  storage_key text not null check (storage_key like 'packs/%'),
  updated_at timestamptz not null default now()
);
alter table catalog_thumbnails enable row level security;
alter table catalog_thumbnails force row level security;
create policy catalog_thumbnails_read on catalog_thumbnails for select
  using (app_is_staff() or exists (
    select 1 from product_variants v join products p on p.id = v.product_id
    join product_packs pk on pk.id = p.pack_id where v.id = variant_id
  ));
create policy catalog_thumbnails_staff on catalog_thumbnails for all
  using (app_is_staff()) with check (app_is_staff());

