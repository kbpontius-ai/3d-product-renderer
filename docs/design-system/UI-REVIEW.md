# Application UI/UX review

Review written before implementation. Observations below describe that baseline; recommendations are not all delivered features. The current implementation and verification record is [Workspace reskin](../30-workspace-reskin.md). Mockups use illustrative content, not live account data.

## Evidence and limits

Reviewed the page-route inventory, page implementations, shared navigation, editor, Artwork workflow, forms, upload components, status/queue UI, CSS tokens and responsive rules. Sources include `apps/web/app`, `apps/web/components`, `docs/03-gui.md`, `docs/01-features.md`, and `docs/design-system/DESIGN.md`.

The recent user-supplied Artwork screenshot represents the current light visual direction. Repository screenshots of Designs and the editor show an older dark theme; they are historical layout references only. Localhost did not respond to the initial HTTP check, and native browser inspection stalled awaiting computer-use permissions. This is a source-and-reference review, not a claim that every authenticated page or interaction was exercised live. Responsive behavior, error flows, and WebGL performance still require live verification before implementation is accepted.

Historical mockups generated with the built-in image-generation tool (local review artifacts only; regenerate with generic artwork before retaining them as implementation references):

- `editor.png`: shared navigation and a more structured design workstation.
- `designs.png`: image-led library with four columns at desktop width.
- `admin.png`: Organizations console, retaining the existing administrative sections.
- `prompts.json`: anonymized generation briefs; historical images may differ from these revised briefs.

## Recommended visual direction

Retain the existing linen, white, ink, and warm gray palette. Let models and artwork supply most color. Reserve muted green, amber, and red for meaningful states. Refine the existing identity into a compact professional workspace.

Use a common full-width 64px header. Keep Designs, Artwork, Catalog, Renders in that order. Add a visible staff-only Admin shortcut; keep Account and Organization in the account menu. Highlight Designs while editing a design. The document toolbar beneath the header holds document actions, not another set of global navigation links.

Proposed token changes need design approval: 28–32px page titles, 18px section headings, 14–16px interface text; 400 body, 500 labels, selective 600 emphasis; 8px control corners, 12px panels, 40px regular controls and 32px compact editor controls. Keep a 4px spacing scale. Align library content to a common 1280–1440px maximum, with fluid full-width editor and admin workspaces. The current `.catalog` maximum is 900px, while global navigation and console use 1280px. That mismatch limits visual libraries and makes page transitions feel inconsistent.

These changes deliberately evolve the existing reference: its floating pill header, single large radius, marketing-oriented spacing, and font rules should be revised if this direction is approved. The code already uses Inter, while the reference primarily describes a serif display face. Update the reference to match the agreed application system rather than trying to recreate the reference website literally.

## Page-by-page recommendations

| Route / screen | Current observation | Proposed improvement |
|---|---|---|
| `/` | Redirects to Designs. | Keep this predictable entry; improve the first-use Designs state. |
| `/designs` | Vertical design list, small thumbnails, separate row actions, no search/filter controls. New design uses the first available catalog variant. | Four-column image-led desktop gallery with optional list view; search, product filter, sort; consistent overflow menu; New design opens product/variant selection. Recently deleted becomes a secondary view. |
| `/artwork` — gallery | Four-column artwork tiles, search/sort, upload and per-tile rename/menu. | Preserve the approved four-across layout and prominent artwork. Use shared card metadata, compact actions, explicit transparency treatment, consistent dimensions and upload feedback. Keep only the top-right Upload SVG action. |
| `/artwork` — editor | Expanded viewer, name/dimensions, rotate/flip, undo/redo, zoom/pan, bottom artwork strip; Upload hidden. | Preserve the approved interaction. Align its toolbar, numeric inputs, selected filmstrip state, unsaved status and Save/Cancel hierarchy with the 3D editor. SVG interpretation remains a separately scoped feature requiring review. |
| `/catalog` | Search/facets, product cards with metadata and variant actions. | Image-first cards consistent with Designs; product name and physical dimensions first; pack keys/versions in details. Reduce competing variant actions by selecting the product before choosing a variant. Preserve filters in the URL. |
| `/catalog/[pack]/[product]` | Variant sections emphasize tables of zones and material slots. | Product image/preview beside key dimensions and variant selector; one clear Start design action; organized specifications, materials and decoration zones below. Interactive product preview would be additional functionality. |
| `/renders` | Image gallery mixes ready, running and failed jobs; timestamp/status dominate identification. The server page lists up to 50 jobs. | Identify each render by design name and product; consistent status/format/resolution metadata; filters for state; explicit download action and preview opening behavior. Live progress/refresh and pagination need deliberate implementation, not just styling. Replace “in the last while” with an accurate range/count. |
| `/design/[id]` | Separate header from the rest of the app; persistent left/right controls; render controls low in the inspector. | Shared compact navigation plus document toolbar, saved state and visible Render action. Product/zones/materials on the left; artwork/transform/finish on the right. Preserve Place/Split/Look and put camera controls next to the viewport. Render action opens settings before submission. |
| `/design/demo` | Uses the same editor, with fixture/sample behavior and no saved-design persistence. | Same workstation with a clear Demo badge and “Changes are not saved” status. Avoid implying the Saved state or production render capabilities shown in the signed-in concept. |
| `/account` | “Signed in” heading, raw organization UUID, demo-editor link. | Proper Account title, readable organization name, email and role; links to relevant existing actions. Add editable preferences/security settings only as separately approved functionality. |
| `/signin` | Compact invitation-only email/password form. | Consistent brand lockup, polished form sizing, clear heading/subtitle, steady error placement. Maintain concise invitation guidance. |
| `/invite/accept` | Password setup and incomplete/invalid invitation states. | Show organization context when safely available, explain the next step, and continue toward Designs or Catalog after acceptance. Give expired/incomplete links a clear recovery action. |
| `/reset` | Request, check-email and new-password states share one route. | Apply the same form system; distinct progress/success messages and consistent return-to-sign-in links. Preserve account-enumeration protections. |
| `/org` | Small overview of seats, rendering limits, and support-set quotas. | Compact overview cards with consistent number alignment and usage bars; clear links to People and Products. Keep owner scope distinct from platform administration. |
| `/org/people` | Member table, invitation controls and role/status actions. | Shared table toolbar and invitation dialog; consistent role/status badges; row overflow actions; useful invitation sent/expired states. |
| `/org/people/[id]` | Email title, role/status metadata, product-access controls. | Breadcrumb to People; identity summary; plain-language Allowed/Restricted product access and explicit save/result feedback matching actual persistence behavior. |
| `/org/catalog` | Products and “Withheld from” list. | Product thumbnails where available, clearer “Restricted for” language, links to affected people. Replace internal pack wording in ordinary owner-facing copy. |
| `/org/activity` | Raw action codes and target IDs in a table. | Human-readable events and target names/links, timestamps aligned consistently; retain IDs within details. Name resolution and filters would require supporting data work. |
| `/admin` | Organizations table and inline creation form. | Keep Organizations as the landing page. Compact grouped navigation, search/status filters, restrained totals, consistent rows and quota usage display. New organization becomes a focused dialog. Mockup pagination/filtering are proposed functionality. |
| `/admin/orgs/[id]` | Limits, invitation, people and raw activity share a long page. | Organization summary and breadcrumb; clear People, Limits and Activity sections; numeric quota fields with units and usage context; explicit save feedback. |
| `/admin/users` | Cross-organization people table with search and account actions. | Retain search, standardize table density/status styling, show organization context prominently, group sensitive actions in a row menu with existing confirmation safeguards. |
| `/admin/packs` | Pack upload/inspection alongside installed packs and publish/visibility actions. | Separate “Import product pack” entry from the library. Present inspection as a readable checklist with blocking issues first. Distinguish Save draft and Publish. Use matching status badges and overflow menus. |
| `/admin/packs/[id]/zones` | Per-variant 3D authoring and extensive forms, draft/published constraints. | Dedicated authoring workspace following editor conventions: variant/zone navigation, larger model, contextual inspector, visible Save and Check actions. Keep published-version restrictions prominent but concise; move detailed explanation into disclosure. |
| `/admin/cad` | File intake plus ingestion rows, technical details and draft-pack creation. | Visible progression Upload → Process → Review → Create draft pack. File name, state and next action first; technical metadata expandable. Preserve real importer failures and warnings. |
| `/admin/materials` | Material families with editable cards and previews; many properties visible per material. | Browse compact swatch cards, then edit one material in a focused inspector with a larger preview. Keep “used by N designs” next to Save because changes affect existing designs. Texture controls belong in an advanced section. |
| `/admin/queue` | Workers and render jobs with retry/cancel/log controls. | Compact worker summary and job table; status filter, readable progress/stage and waiting duration; expand a row for logs. Keep cancellation and bulk retry confirmation explicit. |
| `/admin/status` | Services, workers, active jobs, CAD, daily metrics and logs form a long operational page. | Put current health and actionable incidents first; group utilization/history separately; preserve pause/refresh and last-update visibility. Logs get compact filters and expandable detail. Avoid decorative KPI cards without operational meaning. |

## Shared interactions and states

- Page headers: one obvious primary action, one concise purpose sentence, consistent alignment with content.
- Cards: consistent thumbnail framing and metadata order; loading and missing-preview states should look intentional. Use actual saved previews in implementation, not the generated mockup product images.
- Tables: aligned numeric columns, stable row heights, header/row separation, a common toolbar and clear empty/filter-empty states. Sticky headers and pagination require live testing with representative data.
- Forms: persistent labels, units beside numbers, errors adjacent to affected fields, visible pending and saved states. Standardize whether edits save immediately or explicitly; never disguise one as the other.
- Dialogs: continue using the existing shared confirmation system. Keep destructive consequences and published/versioned-data restrictions intact.
- Notifications: a consistent anchored popover, meaningful empty state and direct destination links. Preserve unread/read behavior.
- Uploads: clear file constraints and processing phases; error messages should say what the user can do next. The SVG appearance/selection proposal remains separate from this visual review.
- Editor status: keep validation close to the canvas; a compact success state should not consume space needed for actionable warnings. Preserve autosave conflict handling.
- Responsive proposal: four library columns on wide desktop, three on narrower desktop, two on tablet, one on narrow mobile; retain readable thumbnail size. Editor side panels collapse to drawers and Split can switch to a single active view on constrained widths. Admin navigation collapses without making tables unreadable. These are proposals, not verified current behavior.
- Existing accessibility backlog remains a separate project decision; this review does not start that work or claim conformance.

## Mockup interpretation

The shared top bar is the navigation proposal for all three images. Admin is visible only to staff; Organization remains role-gated in the account menu. The editor toolbar is local document context. Render opens the existing quality/size/format settings in a focused panel rather than submitting immediately.

The generated product models, logos, measurements, organization names and totals are illustrative. They are not accurate CAD or manufacturability proofs. In particular, the editor image uses a simplified sample mark, and its rendered artwork appearance is not an acceptance reference for relief or ink behavior. Some generated icon/brand details and the blue Replace link differ from the specified monochrome system; the written token proposal and existing brand assets govern implementation.

Admin quota totals in the mockup are illustrative and should come from real queries. If each usage cell includes its limit, the final table can drop the duplicate Daily limit column after review. Do not add approval statuses, team collaboration indicators or other unsupported project states just to make cards appear richer.

## Priority and implementation boundaries

1. Agree on the shared shell and visual tokens: compact header, content widths, type hierarchy, controls, cards and tables. This gives all pages a coherent baseline.
2. Improve the three primary workspaces: Designs gallery, editor layout and Admin console. Retain the approved Artwork gallery/editor pattern.
3. Carry shared patterns through Catalog, Renders, Organization, Account and authentication screens; improve empty/loading/error copy.
4. Review functionality separately: product selection for New design, search/filter/pagination, render naming/live progress, source artwork selection, richer product previews and human-readable audit targets. Each has requirements beyond CSS.

Before implementation, present the concrete file-level plan and risks for the selected direction. Key affected areas would be `apps/web/app/globals.css`, shared navigation/components, page routes and their data adapters, with `docs/design-system/DESIGN.md` and feature/workflow documentation updated alongside approved behavior. Do not introduce a new component framework or runtime dependency merely for this restyle.

Verification after approved implementation: required local unit/integration tests, recursive typecheck, lint, environment documentation check; end-to-end tests for changed workflows and editor preview probe plus actual frames for viewport changes. Inspect representative normal, empty, long-name, failure, permission and unsaved states at desktop/laptop/narrow widths. Validate editor rendering parity and quota/permission behavior. GitHub CI must pass before merge unless explicitly waived for that PR; dispatch it if needed.

No commits, pushes, CI runs, data edits or implementation changes were made for this proposal.
