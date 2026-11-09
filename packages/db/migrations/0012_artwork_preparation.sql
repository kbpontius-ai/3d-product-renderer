alter table artwork_versions
  add column original_key text,
  add column editable_key text,
  add column preparation_recipe jsonb,
  add constraint artwork_versions_preparation_complete check (
    (original_key is null and editable_key is null and preparation_recipe is null)
    or (original_key is not null and editable_key is not null
        and preparation_recipe is not null and jsonb_typeof(preparation_recipe) = 'object')
  );
