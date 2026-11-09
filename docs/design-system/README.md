# Application design system

[DESIGN.md](DESIGN.md) is the current **Wrap** style guide. It defines the identity, palette,
typography, shared navigation, page layouts, controls and state styling used by the application.
[UI-REVIEW.md](UI-REVIEW.md) preserves the original review; its recommendations are historical,
not a list of delivered features. [The reskin plan](../30-workspace-reskin.md) records delivery
scope and local verification.

## Implementation

`apps/web/app/globals.css` contains the base semantic tokens and component styles.
`apps/web/app/workspace.css`, imported after it, applies the approved application-wide refinements.
The project uses locally hosted Inter and plain CSS, with existing Lucide icons. There is no
Tailwind runtime or second component framework.

The native SVG mark is `apps/web/public/brand/wrap.svg`; the full-size master is
[`../brand/wrap.svg`](../brand/wrap.svg). `apps/web/app/icon.svg` supplies the favicon.
