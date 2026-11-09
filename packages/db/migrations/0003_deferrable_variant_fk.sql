-- Re-importing a pack version has to be able to move designs onto the rows that replace their
-- variant. Both happen in one transaction, and in the middle of it the designs necessarily point at
-- rows that are on their way out — so the check belongs at commit, not at the statement.
--
-- Still INITIALLY IMMEDIATE: only the importer defers it, and only for the moment it needs to.

alter table designs drop constraint designs_product_variant_id_fkey;
alter table designs
  add constraint designs_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants (id)
  deferrable initially immediate;
