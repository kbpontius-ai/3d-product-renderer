# Artwork archive

Feature F-ART-13 adds an organisation-wide archive to the existing artwork library. Archive hides
unwanted SVG files without removing assets required by saved designs. It covers every immutable
version of an artwork. It does not archive the underlying catalogue product.

## Hide artwork

In Artwork, open a tile’s overflow menu and choose **Archive artwork**. The confirmation displays
how many saved designs will become view-only for everyone in the organisation. Confirming removes
the file from Active and from new-design artwork pickers. Search and sorting follow the selected
**Active / Archived** view. The upload workflow remains available from the gallery.

Archived tiles retain their previews and dimensions, show an Archived status/date, and offer
**Restore artwork**. Opening a tile reuses the SVG viewer and filmstrip. Properties, selection
editing, transforms and saving are disabled; zoom, pan and retained original downloads still work.
The existing protected delete operation remains separate from archive.

## Inspect an affected design

Affected designs remain in the Designs gallery and list with **Archived artwork · View-only**.
Opening one shows a pale amber banner below the document toolbar, naming the archived files.
**View artwork** opens the archived SVG directly.

Placement gestures, saved material/colour/finish/lighting/background edits, reorientation,
rename/duplicate, undo/redo writes and new render submissions are disabled. Saved values and actual
artwork remain readable. Place/Split/Look, orbit/zoom, camera presets/lens, cross-sections and
temporary inspection lighting remain available. These viewing changes do not save a new design
version or replace its dashboard thumbnail. Existing renders remain viewable/downloadable, and
already submitted immutable render snapshots can finish.

## Restore artwork

Switch to Archived or follow View artwork, then choose **Restore artwork**. The file returns to
Active and can be placed in new designs. Affected designs become editable when every archived file
they currently reference is restored. Restoration does not alter artwork versions, placements,
materials, finish, lighting or orientation. Existing open design tabs refresh archive status when
they regain focus.

If another tab archives artwork while a user edits, the server refuses the save with
`archived_artwork`. Autosave stops and unsaved local work remains in the tab. After explicit
restoration, that pending work may save again. Reuploading identical archived content gives a
restore instruction rather than silently reactivating it.

## Data and enforcement

Migration `0013_artwork_archive.sql` adds nullable `artworks.archived_at`. Archived assets remain
available through the existing authorised reads. The application derives archive blockers from
all pinned versions in the current saved placements; it never copies flags into design JSON.

Archive/restore, artwork edits, design writes and render submission share a tenant transaction
lock. Saves check both current saved references and incoming placements, so removing a reference
through a direct API call cannot bypass the design lock. Existing tenancy/RLS, immutable versions,
optimistic conflicts, deletion safeguards and rendering mathematics remain authoritative.

See [the API contract](13-api.md), [workflow W-18](02-workflows.md#w-18--archive-artwork-and-inspect-a-read-only-design)
and [the data model](11-data-model.md) for endpoints, permissions and rollback instructions.
