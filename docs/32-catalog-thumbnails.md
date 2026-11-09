# Catalog thumbnails — F-CAT-08

Catalog cards display a captured web-viewer image, then a supplied pack thumbnail, then
**Preview not available**. These are static images; interactive Catalog cards remain F-CAT-05.

## Staff workflow

Open **Admin → Packs → Catalog previews**. Choose **Generate preview** or **Regenerate preview**
for a variant. The shared product viewer opens without artwork, using the default materials,
softbox lighting and a neutral background. Choose a camera preset, or rotate/pan/zoom manually.
Once meshes and textures finish loading, **Capture preview** saves the 768 × 576 image. The capture
contains only the canvas, without navigation or camera controls. Review the result in Catalog.

No render worker, Blender process, customer design or geometry repair is needed. A failed save
retains the previous picture and displays its reason. Reopen the viewer after a graphics/load error.

## Bulk backfill

An operator can publish a folder of captured PNGs through the same validation/storage function:

```bash
pnpm db:migrate
pnpm catalog:thumbnails /absolute/path/to/viewer-captures
```

Use the normal `DATABASE_URL` and absolute `STORAGE_ROOT`. Name each image
`<pack-key>--<variant-key>.png`, for example `cap-basic--38mm.png`. Only matching published variants
are updated; missing files are skipped, invalid images fail visibly. Repeating an upload creates
an immutable image and updates only its presentation pointer. The folder must contain actual
viewer captures; the command publishes images, it does not generate them.

## Implementation and safeguards

- Migration `0013_catalog_thumbnails.sql` adds a presentation-asset table. Imported manifests,
  geometry, saved designs and customer rendering remain unchanged. Rollback: revert callers,
  then drop this table; delete its generated objects separately if desired, never imported assets.
- The existing `Viewport3D` gains product-only mode, which bypasses relief geometry and draws plain
  slot materials. Normal editor calls retain their existing behavior. The frame callback waits for
  pending mesh/texture loads; capture is disabled while a new view settles.
- The API requires staff authentication, same-origin requests, valid pack/variant IDs, the existing
  thumbnail rate limit and a bounded PNG body. PNG structure, dimensions and decoding are checked
  before storage. Ordinary tenants may read metadata only for visible packs and cannot write it.
- Storage keys under `packs/.../catalog-thumbnails/` are immutable. Updating the pointer and audit
  event is transactional; a database failure removes the newly uploaded object and retains the old
  image. Concurrent saves serialize on the variant; the last completed save becomes current.
- Catalog uses existing shared-pack asset delivery and retains supplied-image fallback. Old captured
  objects are retained as provenance; automatic image-history cleanup is outside this fix.
- Web viewer capture replaces the initially trialed Cycles thumbnail queue. The two CAD caps contain
  empty assembly mesh entries that Blender rejects; the browser already tolerates them. Capture
  leaves those stored files intact. Fixing the CAD exporter or renderer compatibility is separate.

## Verification

Local coverage checks PNG validation, pack/variant matching, tenant policies, transactional
replacement, unchanged manifests/designs, staff capture, loaded image delivery and starting a design.
Real frames are inspected before publishing the backfill. GitHub CI must pass before merge unless explicitly waived for that PR.

Verified locally: 1,397 unit/integration tests passed (seven skipped); typecheck,
lint, environment documentation, production build and bundle budgets passed. The full browser run
passed 157 tests and skipped three; the existing prepared-carton preview/render parity case failed
(mean SSIM 0.2080), matching the pre-feature baseline. The final focused Catalog/Packs browser run
passed all ten tests without a render worker, including capture, served-image loading, starting a
design and save-in-progress controls. All five actual products were captured through the new Admin
viewer, their frames inspected, and their images published using the bulk command. A separate review
server uses the existing development database on port 3114; shared servers were not restarted.
