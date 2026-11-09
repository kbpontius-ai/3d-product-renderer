# Packaging library — build handoff

Generated using the recommended choices and approximations.
**Pilot appearance approved; all five pairs generated and validated. See the deliverable notes for remaining application acceptance limits.**
See the [CAD files and validation evidence](../output/packaging-library/README.md).
Read alongside the [spec](packaging-library-spec.md) and [source/dimension audit](packaging-library-dimensions.md).

## Review package

The recommended package is drawing-led visualization models: use the 70 cap drawing diameter,
use the taller 110 jar drawing version, and use a non-ribbed glossy 110 cap. Missing geometry is
explicitly approximate. This recommended package is the one generated. If exact commercial
replication is required, obtain supplier CAD or measured samples instead of approving estimates.
The 58 jar has the weakest evidence: catalog envelope dimensions without a detailed drawing.

No outside supplier has been contacted. No dependencies, services or catalog entries have been added.
Preparation cannot establish actual fit or render quality before geometry exists.

## Common construction rules

- Millimetres, +Y up, X/Z centered. Jar origin at its lowest support surface; cap origin at skirt bottom.
- Use inch drawing callouts × 25.4 consistently. Preserve documented min/max ranges separately;
  use their midpoint only as an explicitly recorded nominal design choice.
- Create closed hollow solids by revolving inner/outer sections, then add separate geometric
  details and helical threads. Keep cap and jar separate named solids in the assembly.
- Each pair gets independent parameters; do not scale another pair's geometry.
- Unknown profile details below are proposed visualization choices, not values extracted by
  scaling drawings. Blend adjoining sections tangentially; preserve overall bounds and minimum walls.
- All section dimensions refer to the final exterior. Derive inner surfaces from the stated thickness,
  with a smooth transition into the neck/base. Test minimum thickness through blends and details.
- Do not silently adjust source envelope dimensions, suppress failed features, heal invalid shapes,
  or drop threads to make an export pass. Report a failed construction and revise its source.

## Proposed missing geometry for the remaining pairs

All numbers in this section are **approved visualization approximations**, except explicitly marked derived
from drawing callouts. Final parameter sheets must classify each value individually. Dimensions
are mm. These proposals complement the 70 pilot package in the dimension audit.

| Pair | Cap deck / top edge | Jar wall / base / neck wall | Exterior profile proposal |
|---|---|---|---|
| 120 | Deck 1.524, derived from OAH−H; 1.0 top round | 1.2 / 2.2 / 1.8 | 5.0 heel round; main recessed panel OD 150.4, Y=25 to 143.3386 (drawing label height 118.3386); lower chime Y=13–24, upper chime Y=145–158, OD 152.4; shoulder Y=158–185; transfer bead centered Y=192 with 2.0 radial projection over neck root; neck H=23.4442 from drawing |
| 110 | Deck 1.270, derived from OAH−H; 1.0 top round | 1.3 / 2.2 / 1.8 | Drawing version only: panel OD 130.048 from 5.12 in REF; usable label Y=25–134.982; tapered heel Y=0–20 with bottom OD 114; body up to Y=153.416; shoulder to Y=161; neck-transition recesses below threaded finish; retain drawing envelope OD 131.572 and H 188.976 |
| 89 | Deck 1.5748, derived from OAH−H; 0.8 top round | 0.8 / 1.6 / 1.6 | 2.0 shoulder and 3.5 heel rounds; neck H=13.8938 from drawing; label Y=9–47.862; recessed underside 2.0 deep with three support details |
| 58 | Deck 2.0828, derived from OAH−H; 1.0 × 45° top chamfer | 0.95 / 1.5 / 1.4 | Neck H=11.5; 2.0 shoulder and 3.0 heel rounds; label Y=9–57; recessed underside 1.5 deep; flat annular standing surface |

Cap decks use planar nominal sections; OAH−H is a derived nominal value, not a measured uniform
wall thickness. EMP maximum allowed deck dip is not applied as actual sag. Skirts have zero draft
in these proposals. The 120 label location and panel diameter are approximate even though its
label height is documented. Transition dimensions must be reconciled as one connected section,
not independent intersecting cylinders. If the proposed blends cannot fit, stop for a dimension
revision instead of changing them without recording it.

Additional approximate details:

- **58 cap grip:** 144 equally spaced axial ribs, radial height 0.35, crest width 0.55,
  rounded edges radius 0.10; Y=0.6–10.7. Drawing OD 60.0964 includes the ribs, so the
  underlying skirt OD is 59.3964. Top stipple belongs to the material, not tessellated CAD.
- **110 jar shoulder:** propose 72 shallow slanted ribs, 0.25 radial height, and 12 equally
  spaced rounded recesses on the neck transition, each 8 wide × 10 high × 0.5 deep.
  These counts/depths are not documented. Keep maximum drawing OD and minimum wall budgets.
- **70/89 underside:** three 120°-spaced support pads on the recessed underside; proposed
  8 × 3 pads with 0.5 corner radii and 0.6 projection into the recess, remaining above Y=0.
  Preserve a continuous annular standing surface. These are visual approximations of base details.
- **120 underside:** annular standing surface and 2.0 recessed base; omit embossed codes.

## Thread and seating policy

Use the documented cap pitches/turn counts: 120/110/89 are 5 TPI and 1.25 turns;
58 is 6 TPI and 1.125 turns. The 110 jar drawing specifies 1.5 turns: do not replace this
with the cap's turn count. Other jar thread turn counts are approximate unless independently sourced.
The 70 pilot proposal remains 6 TPI / 1.25 turns, not a verified 74-7225 specification.

A supplemental [Rieke/Innovative Molding drawing S-070-16](https://www.liquidbottles.com/_wss/clients/1/shopping_images/20211217162102828.pdf)
specifies 6 TPI but 1.125 turns for its recommended container. It corroborates the plausibility
of the pitch, **not** the exact selected cap/jar geometry. Do not substitute its dimensions or
label the pilot's thread as supplier-verified.

Proposed missing thread geometry: right-hand, single start; rounded trapezoidal section,
60° included angle with 0.15 crest/root rounds, 30° angular lead-in/out ramps. Derive cap radial
depth from its E/T callouts and record their interpretation against the drawing section.
Thread axial placement must respect each source S datum, where provided, and stay within H.
If the rounded profile cannot fit the available pitch/depth, stop rather than silently changing pitch.

Where jar neck E/T are missing, propose a modeled mating neck with 0.2 radial clearance to the
corresponding cap thread/root and 0.2 normal flank clearance. Label this as a derived visualization
mate, not a verified standard neck. Where jar E/T are supplied (110), retain those callouts and
measure the resulting clearance rather than imposing the generic value. Record final profile
vertices, thread phase, axial offset and actual minimum clearances with each export.

Seat the jar rim against the cap's inner deck, without a liner. Proposed cap translation is
`jar overall H − cap internal H` along +Y, with rotation solved for thread clearance. Confirm skirt
clearance to shoulder/bead and check the complete seated assembly for overlap. A collision is a
failed pair, not permission to shorten the neck or resize the source cap. This digital seating
does not qualify a physical seal, closure torque, or commercial interchangeability.

## Materials and artwork

Retain the requested non-ribbed glossy caps and ribbed/matte-top 58 cap. The 110 finish is non-ribbed glossy, as recommended at release. White caps are proposed only as a neutral review color, not an approved product color.
Use clear PET for 70/89; natural HDPE for 110; white HDPE for 58; propose natural HDPE for 120.
Select material definitions from the existing library at build time and record their IDs/versions.
The shared material mapper supports transmission; that alone does not verify optical parity.
No independently authored Blender-only finish is accepted as the app's material result.

Derive top artwork disks from the final planar face, with a 2 mm margin inside the start of the
edge round/chamfer. Use the smooth label bands above, clipped further if final blends encroach.
Record the surface frame, usable extent, minimum wall and curvature from actual geometry.
Test print first. Relief remains unsupported for a zone until its depth and residual wall are
checked; proposed thin PET walls must not inherit generic deboss limits.

## Build sequence after explicit release

1. Record approval/rejection of the three pending choices and the approximation packages.
2. Implement an isolated parameterized OCP generator, using the existing named STEP export pattern
   in `scripts/make-fixture-cad.py`. Do not modify that fixture generator or application behavior.
3. Generate only the 70 pair. Validate in memory and after STEP re-import, without healing.
4. Export views and section images, inspect thread seating and wall thickness, and test through
   the actual application's OCCT import and Blender workflow. Review the pilot before the other four.
5. Generate remaining pairs from their own parameters; repeat every check for every pair.
6. Deliver ten part STEP files and five assembly STEP files, editable source/parameters,
   per-pair dimension sheets, material/zone recommendations, view images and validation reports.

Proposed isolated output root: `output/packaging-library/`. Each pair gets its own directory with
`cap.step`, `container.step`, `assembly.step`, `parameters.json`, `dimensions.md`, `validation.json`
and `views/`. Shared generator source stays within this root. No existing output files are overwritten.
Record file SHA-256, source URLs/hashes, tool versions and assembly transforms in the manifest.
No committing, CI, publication or dependency installation is included.

## Acceptance checks

| Check | Required evidence |
|---|---|
| Solid topology | Every part: one valid closed solid, finite positive volume; assembly: exactly two correctly named solids; no extra fragments |
| Source dimensions | Nominal callouts within proposed 0.01 mm computational error, separately retaining supplier tolerance and source status |
| Round trip | STEP re-import without healing; bounds within 0.001 mm and volume within 0.001% of source shape |
| Fit | Common/intersection volume no more than 1e-6 mm³ numerical allowance; separate clearance measurements and section inspection; contact at intended seat only |
| Shell thickness | Section checks at wall, neck, shoulder, heel, base and every rib/recess; no breach of the approved local thickness budget |
| Visual | Front/side/top/underside, assembly perspective and section for each pair; smooth highlights, readable ribs, credible hollow PET |
| App | Actual OCCT worker identity, import job and bounds/counts, named material ownership, outside/inside normals, preview frame and completed Blender render |
| Decoration | Generic counters/thin strokes on cap and body; print and only thickness-approved relief; no visible blank placement-zone footprint |
| Cleanup | Remove temporary live-test records/artifacts; retain only deliverables and validation evidence; catalog stays unpublished |

Geometric checks run locally. If application code changes become necessary, present a separate
plan before editing and run the repository's required unit/typecheck/lint/env/e2e/preview checks.
Do not run the e2e wrapper alongside an active dev session: it can stop that server.

## Preflight completed before generation

- Existing Python 3.11.9 and OCP 7.9.3.1.1 import the required sweep, boolean, validity and
  named STEP reader/writer APIs successfully; no installation needed.
- Existing Blender reports 5.2.0 LTS. Its version command emits an OpenUSD cache-line-size warning;
  no render was attempted, so renderer usability is not yet verified.
- Checked the documented `/admin/cad` draft workflow and shared transmission mapping.
- Source PDF hashes were verified during the dimension audit.
- No CAD geometry, generator code, meshes, test products or render jobs have been created.

Current status: all five pairs are generated; source/round-trip, fit, wall sampling and
actual application import checks pass. The pilot was visually approved, uploaded and drafted through
the website. The separately approved importer bounds/volume and renderer material-assignment fixes
are implemented with regressions. Diagnostic views and the pilot production render are available.
See the output package for the outstanding carton browser-test failure and optical/zone-authoring limits.
