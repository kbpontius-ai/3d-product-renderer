alter table artworks add column archived_at timestamptz;

-- Rollback after reverting application code: alter table artworks drop column archived_at.
