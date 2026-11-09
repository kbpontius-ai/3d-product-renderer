# Loading-state review

Approved animation: **Quiet ring (#1)**. Implemented as `LoadingSpinner` and used in the placement
color-loading overlay and the locations below. The existing placement readiness gate remains authoritative.

| Priority | Area | Implemented use |
|---|---|---|
| First | 3D Viewer initializes its studio and loads a product behind a skeleton and progress track (`viewport-3d.tsx`). The same viewer is reused in orientation and Admin thumbnail capture. | Replace the skeleton shape with the ring while retaining the product-download progress bar and descriptive stage text. Avoid a progress bar implying download progress during studio/shader setup. |
| First | Admin zone preview loads its viewer module and part data with text-only waiting states (`variant-zones.tsx`). | Center the ring and “Loading the part…” inside the reserved preview area; keep failures and Retry visible. |
| First | SVG viewer shows “Loading SVG…” while source data becomes ready (`artwork-editor.tsx`). | Ring and label in the preview area only during actual loading. Do not animate “Enter valid dimensions” or “Preview unavailable”; those need user action. |
| Next | Artwork preparation shows “Analyzing SVG…”; repair/save actions have pending states (`artwork-preparation.tsx`). | Ring next to the operation label during analysis or a submitted repair. Stop it on completion/error and preserve Back/Cancel and recovery controls. |
| Next | “Use artwork you have already uploaded” previously showed plain “Loading…” while fetching its library (`artwork-library.tsx`). | Small ring beside “Loading artwork…” inside the open picker. Retain empty and error states separately. |
| Next | Upload, save and invite controls change their labels while requests run (`artwork-page.tsx`, editor upload, orientation confirmation, thumbnail capture, organization invite). | Compact ring beside the existing pending label; preserve the button's width and duplicate-submission guard. Do not cover the whole page for a local action. |
| Lower | Worker log opens with text-only “Loading…” (`job-log.tsx`). | Compact ring while the initial log request is pending. An empty log is a completed empty state, not continuing loading. |

## Keep meaningful progress

- Rendering: retain the existing progress, stage, time estimate and cancel/retry controls in
  `render-panel.tsx`. A ring may accompany “Submitting…” or an explicitly queued state; it must
  not replace job progress or suggest an idle queue is actively rendering.
- CAD and product-pack workflows: distinguish transfer, validation, queued import and worker
  execution. Use a ring only for a request with no measured progress; keep any real job status.
- Autosave: retain “Unsaved changes”, “Saving…” and “All changes saved”. A compact ring could
  accompany the actual saving request, never the entire debounce interval or a save error.
- Gallery thumbnails: keep their image placeholders while individual images load. A grid of
  independent rotating rings would compete with the artwork.
- Ordinary filtering, validation, empty results and errors: no spinner unless a real asynchronous
  operation is pending. Do not add artificial delays merely to display the animation.

## Verification

Browser regressions hold real asset/analysis requests pending to observe the ring, then release them
and verify completion or error recovery. The placement regression checks that unmatched colors stay
hidden until the sampled color and artwork repaint agree. Existing download/job progress, empty
states, error messages and duplicate-submission guards remain in place.

The shared viewer carries the ring into product orientation and Admin thumbnail previews. Compact
rings also accompany CAD transfer, pack inspection/import and initial worker-log loading. Rendering
progress, autosave and gallery image placeholders retain their existing behavior.
