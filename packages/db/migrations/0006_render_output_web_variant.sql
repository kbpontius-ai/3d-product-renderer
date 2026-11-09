-- A web-sized copy of every render output (F-EXP-01).
--
-- The original is what a customer downloads and hands to a printer: 2K or 4K, sixteen bits a
-- channel, tens of megabytes. The gallery and the render tray were showing that file directly,
-- which is a page that costs a hundred megabytes to look at. This is where the small copy lives;
-- the original is untouched and still what the download link points at.
--
-- Nullable, because outputs written before this migration do not have one and a render is not worth
-- re-running for a thumbnail. Anything reading it falls back to the original.
alter table render_outputs
  add column web_storage_key text,
  add column web_bytes bigint;
