# Wrap — Application style guide

The approved identity connects vector artwork to three-dimensional surfaces. The interface is a precision workspace with quiet warm surfaces, clear hierarchy and generous product imagery. This guide supersedes the historical website-oriented reference. Implementation: `apps/web/app/workspace.css`, layered after the base component styles in `globals.css`.

## Identity

The Wrap mark is a continuous ribbon with an open center. Use the exact SVG in `apps/web/public/brand/wrap.svg`; a full-size 1024 × 1024 master is also in `docs/brand/wrap.svg`. It scales without raster images, fonts, filters or external references. The favicon uses the same paths. Use ink on light backgrounds; the CSS mask inherits the interface text color. Keep the center transparent and preserve the viewBox. Maintain clear space of at least one-quarter of the mark width. Minimum intended UI size is 22px; use 30–34px in navigation and 48–56px in authentication. Keep “3D Product Renderer” as the current wordmark; the symbol is independent of any one kind of product.

## Tokens

| Role | Value |
|---|---|
| Canvas | Linen `#f7f5f3` |
| Surface | White `#ffffff` |
| Text / primary action | Ink `#171717` |
| Secondary text | Stone `#6e6a69` |
| Border | Ink at 10%; 22% for stronger boundaries |
| Status | Existing muted success/warning/error colors; always paired with text |
| Font | Locally hosted Inter; system sans fallback |
| Page title | 28–32px, 600 weight, tight tracking |
| Section title | 16–18px, 500–600 weight |
| Controls / body | 14px; 16px where reading space benefits |
| Metadata | 12–13px; units and numeric columns aligned |
| Spacing | 4px base; 8, 12, 16, 20, 24, 32, 40px |
| Corners | Controls 8px; cards/panels 12px; authentication 16px |
| Controls | 36–40px normal; compact editor controls 32px |

Use restrained borders and surface contrast. Avoid decorative gradients, heavy shadows, oversized pills, all-uppercase section headings and technical identifiers as primary labels. Color belongs primarily to product imagery and user artwork. Thin Lucide line icons should match existing icons.

## Navigation and layouts

Global header: 64px, white, full width; Wrap and wordmark, Designs → Artwork → Catalog → Renders, staff-only Admin shortcut, notifications and account menu. At narrow widths the wordmark may collapse; the account menu retains administrative destinations. The editor highlights Designs. Authentication uses the same mark and form styling without the authenticated shell.

Library pages: common content width up to 1440px, 24–40px horizontal padding; title and one primary action, then filter toolbar, then content. Designs uses four desktop columns, three at laptop widths, two at tablet widths and one on narrow screens. Keep list view for scanning. Artwork retains its approved four-column gallery and expanded editor with bottom filmstrip; Upload SVG stays hidden while editing.

Editor: global navigation above a local document toolbar, followed by product/zone/material controls, the canvas and artwork/finish inspector. The shell subtracts header height from the viewport. Side panels scroll independently. Retain Place, Split and Look, numeric transforms, undo/redo, safe-area feedback, autosave/conflicts, camera and cross-section controls. Toolbar Render reveals the existing render settings; settings/job state stays mounted. Narrow screens scroll the desktop workstation rather than losing tools or pretending to offer a redesigned mobile CAD editor.

Admin and Organization: 224px section navigation, compact groups, white content tables on linen. Owner and staff scopes remain separate. Highlight parent sections on detail routes. Staff tenant navigation contains Organizations; within a selected organization, use a persistent identity/status header and an understated underline section row: Overview, People, Products, Limits, Activity. Person detail keeps People selected. This local section row does not repeat the global application navigation. Email lookup in the organization directory is read-only; account controls live within the organization. Controls and dangerous actions retain their existing safeguards. Material/zone/CAD/status screens share the system while preserving their specialized controls.

## Components and states

Cards: consistent preview framing, then title, product/dimensions and secondary date/version. Thumbnails must come from actual saved designs. Missing thumbnails show a deliberate placeholder, never generated artwork that implies a real saved result. Rename, duplicate and delete use one overflow menu. Restore stays visible under Recently deleted.

Tables: white surface, subtle tinted header, 14px body, readable row spacing, right-aligned counts, status text with restrained chips. Preserve horizontal scrolling for wide technical tables. Never remove technical detail that an operator needs; put primary identity before metadata.

Forms: persistent labels, units beside measurements, consistent input corners, explicit pending/error/saved feedback. Keep immediate-save and explicit-save behavior intact. Reuse the existing confirmation dialog for consequential operations.

Empty/loading/error: use the same typography and surfaces, explain the next useful action and avoid fabricated statistics. Long names wrap or truncate without overlapping menus. Save conflicts and invalid artwork remain visible and actionable.

The standard indeterminate loading animation is the quiet ring: `LoadingSpinner` uses a 30px,
2px ring in the current interface ink, rotating at 900ms per revolution. Pair it with a specific
status such as “Preparing placement colors…”. The placement pane uses it while the artwork repaint
prepares; the sampled material color replaces the part's own color when it arrives, without a spinner. Keep actual progress bars, stage names and cancellation
controls for transfers and background jobs. A spinner indicates activity, not a percentage or proof
of progress. Other adoption points are proposed in [the loading-state review](LOADING-REVIEW.md).

## Page coverage and evolution

See [UI review](UI-REVIEW.md) for all 26 route files and additional UX recommendations; see [implementation plan](../30-workspace-reskin.md) for scope and verification. A proposal in the review is not a claim of implementation: new rendering capabilities, deep audit-name resolution, mobile editing need their own approved plans. SVG preparation was approved separately and is documented in [artwork preparation](../29-artwork-preparation.md).

Changes to this system should extend shared tokens/components and be verified on library, editor, admin and auth surfaces. Do not add a second UI framework or scatter per-page color and sizing constants. Existing authorization, asset versions and rendering mathematics remain authoritative.

## Product orientation workspace

Use the existing AppNav unchanged. Under location breadcrumbs, pair the page heading with four connected numbered steps. The main/inspector columns use the application's existing card borders, control radii and Inter type. Pale blue is reserved for the reference grid/rings and Front/Up directions; black indicates the current/completed step and primary action. Main viewer presets remain bottom-left. The inspector includes a live Front preview; the sticky footer holds navigation and confirmation. Below 800px the inspector stacks beneath the viewer. Scope and saved/staged state must remain explicit. See [orientation requirements](../33-product-orientation.md).

Editor orientation/lighting controls stay beneath Background. Use the existing 14px sidebar headings,
32px compact buttons, 8px corners and joined segmented-control pattern. **Lighting preset** names the
saved dropdown choice; **Viewer lighting** distinguishes **Design lighting** from temporary
**Inspection**. Show the rotation slider only while Inspection is selected; keep reset available
in both modes. Place the angle beside its label,
with a full-width slider and secondary reset button. Helper copy uses normal muted 12px text rather
than a technical monospace readout. Orientation-wizard buttons use 40px height and 18px section
headings, matching the normal control and inspector scale.

## Archived artwork notices

Use a compact persistent notice beneath the saved-design toolbar and above archived SVG viewers:
very pale amber `#fff5e4`, subtle border `#ead7b3`, existing `--warn` archive icon, dark ink heading
and stone body text. Reuse standard outlined action buttons. Keep product imagery undimmed and
show disabled editing controls individually. Gallery/design status chips remain restrained and
neutral; the notice provides the stronger visual signal.
