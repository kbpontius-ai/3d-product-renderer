-- Deleting a person keeps what they made (F-ADM-06).
--
-- Every "who made this" reference to `users` was `no action`, so deleting anybody who had ever saved
-- a design failed on `design_versions_created_by_fkey` — staff "Delete" answered 500 for every real
-- account. `deleteUser` nulled three of these columns by hand and missed the rest; a list in code is
-- a list somebody forgets to extend.
--
-- The work belongs to the organisation, not the person: designs, their versions, artwork, renders,
-- CAD ingestions, packs and invitations all stay, and only the name of who made them goes. Sessions,
-- password resets, notifications and access denials still cascade, because those are about the
-- person.

-- Re-adding a foreign key re-checks the existing rows, and that check runs under row-level security
-- as the role migrations use. Without the staff flag it sees no users at all: tables whose own rows
-- it cannot see either pass vacuously, but a published pack is visible to everyone, so its author
-- looked missing and the migration failed on any database holding one. The staff flag makes the
-- check see, and check, every row. Local to this migration's transaction.
select set_config('app.is_staff', 'on', true);

alter table design_versions drop constraint design_versions_created_by_fkey,
  add constraint design_versions_created_by_fkey foreign key (created_by) references users (id) on delete set null;

alter table designs drop constraint designs_created_by_fkey,
  add constraint designs_created_by_fkey foreign key (created_by) references users (id) on delete set null;

alter table artworks drop constraint artworks_created_by_fkey,
  add constraint artworks_created_by_fkey foreign key (created_by) references users (id) on delete set null;

alter table render_jobs drop constraint render_jobs_submitted_by_fkey,
  add constraint render_jobs_submitted_by_fkey foreign key (submitted_by) references users (id) on delete set null;

alter table cad_jobs drop constraint cad_jobs_submitted_by_fkey,
  add constraint cad_jobs_submitted_by_fkey foreign key (submitted_by) references users (id) on delete set null;

alter table product_packs drop constraint product_packs_created_by_fkey,
  add constraint product_packs_created_by_fkey foreign key (created_by) references users (id) on delete set null;

alter table invitations drop constraint invitations_invited_by_fkey,
  add constraint invitations_invited_by_fkey foreign key (invited_by) references users (id) on delete set null;
