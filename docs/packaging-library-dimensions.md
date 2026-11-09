# Packaging CAD library — reference audit and pilot decisions

Companion to [the approved lineup](packaging-library-spec.md).
Status: recommended choices and approximation packages released for generation.
The [five-pair library](../output/packaging-library/README.md) is generated; the pilot appearance was approved.
Importer bounds/volume corrections and the separately approved renderer material fix are implemented.
No product has been published. The [build handoff](packaging-library-build-plan.md) covers all pairs.

## Work remaining

- [x] Inspect the supplier drawings and record dimensional conflicts.
- [x] Confirm the existing OCP installation: `cadquery-ocp` 7.9.3.1.1.
- [x] Release the recommended source choices and visualization approximations.
- [x] Generate the pilot STEP files and execute kernel/importer checks.
- [x] Correct importer bounds/volume and verify all five actual assemblies.
- [x] Review pilot appearance, live upload/draft and production renderer output.
- [x] Complete the other four dimension sheets, parts, assemblies and validation.
- [x] Package editable sources, STEP exports, views, hashes and validation reports.
- [ ] Resolve remaining application acceptance limits in the deliverable validation notes.

## Source choices released for generation

1. **70-400 cap:** the 74-7225 drawing specifies OD 2.875 in = 73.025 mm;
   its [catalog page](https://www.pcinternational.com/catalog/jars/70-400-continuous-thread-closure-smooth-pp/)
   lists 2.75 in / 69.87 mm. Use the drawing dimensions for the proposed pilot.
2. **110-400 jar:** the linked 68W64H drawing specifies the threaded version at
   7.44 ± 0.060 in tall (188.976 ± 1.524 mm), with a scalloped neck transition and shoulder ribs.
   Its [catalog page](https://www.thecarycompany.com/64-oz-natural-hdpe-wide-mouth-jar-110mm-110-400-6x1-reshipper-carton)
   lists 6.75 in (171.45 mm), a difference of 17.526 mm. Drawing OD is 5.18 ± 0.080 in;
   catalog OD is 5.17 in. This is not a rounding discrepancy. Proposed choice: model the
   drawing version, including its shoulder detail, and identify it as that version; do not
   combine the catalog height with the drawing's neck/body. Alternatively, hold this pair for
   a supplier-confirmed drawing of the catalog version.
3. **110-400 cap:** proposed finish is non-ribbed sides and glossy PP. Included in the recommended plan.

For the 70 and 89 jars, use each drawing consistently rather than mixing its dimensions/capacity
with the slightly different catalog values. These choices do not establish which revision is
currently supplied commercially.

## Documented cap dimensions

Values below are drawing callouts in inches, with millimetre equivalents in parentheses.
`H`, `E` and `T` retain the drawing's labels; they are not an independently verified mating neck
specification. Decimal conversion does not imply additional measurement precision.

| Cap | Outside diameter | Overall height | Internal H | E | T | Pitch / turns |
|---|---|---|---|---|---|---|
| 120-400 | 4.855 (123.317) | .715 (18.161) | .655 (16.637) | 4.615 (117.221) | 4.732 (120.1928) | 5 TPI / 1.25 |
| 110-400 candidate | 4.500 (114.300) | .625 (15.875) | .575 (14.605) | 4.265 (108.331) | 4.375 (111.125) | 5 TPI / 1.25 |
| 89-400 | 3.635 (92.329) | .573 (14.5542) | .511 (12.9794) | 3.430 (87.122) | 3.555 (90.297) | 5 TPI / 1.25 |
| 70-400 | 2.875 (73.025) | .462 (11.7348) | .400 (10.160) | 2.643–2.657 | 2.737–2.751 | Unknown / unknown |
| 58-400 | 2.366 (60.0964) | .475 (12.065) | .393 (9.9822) | 2.141 (54.3814) | 2.238 (56.8452) | 6 TPI / 1.125 |

The EMP drawings specify a general ±.010 in tolerance. The 58 drawing also specifies ±.010 in.
The 70 drawing provides E/T limits; no general tolerance was found. All five specify PP.
The 58 drawing identifies fine ribs and a chamfered matte top, but does not dimension rib count,
rib depth or the chamfer. EMP max-deck-dip limits are limits, not instructions to model that dip.

## Documented container dimensions

These are reference dimensions, not fully specified CAD definitions. Millimetres shown on a
dual-unit drawing are retained here as printed; generation must record which unit is authoritative.

| Pair / SKU | Body OD | Overall height | Neck H | Label panel, wrap × height | Overflow |
|---|---|---|---|---|---|
| 120 / 61-0033 | 6.000 in [152.40 mm] | 8.655 in [219.82 mm] | .923 in [23.43 mm] | 18.660 × 4.659 in [473.96 × 118.33 mm] | 3451 cc |
| 110 / 68W64H drawing | 5.18 ± .080 in | 7.44 ± .060 in, threaded version | .582–.612 in | Panel height 4.33 in REF; panel diameter 5.12 in REF | 71 fl oz, drawing units |
| 89 / 71-1770 | 3.660 in [92.96 mm] | 2.625 in [66.68 mm] | .547 in [13.91 mm] | 11.20 × 1.53 in [284.5 × 38.9 mm] | 398 cc |
| 70 / 71-1760 | 2.856 in [72.54 mm] | 3.038 in [77.17 mm] | .424 in [10.77 mm] | 8.73 × 2.18 in [221.7 × 55.4 mm] | 285 cc |
| 58 / N1002038 catalog only | 2.37 in [60.198 mm converted] | 2.933 in [74.4982 mm converted] | Unknown | Unknown | 185 cc |

Nominal capacities remain 100, 64, 12, 8 and 6 oz respectively. Overflow capacity is not nominal
capacity and will not be used to silently adjust the exterior profile. Container resins remain
HDPE, HDPE, PET, PET, HDPE. Actual wall/base thicknesses are unknown for all five.

## 70-400 pilot approximation package

This is a render-library interpretation of the two drawings, not a mechanically qualified replica.
Values below are `approved approximation` where the supplier did not dimension them. Approval
authorizes visualization modeling, not a claim of supplier accuracy. No value was measured from a PDF image.
The delivered pilot dimension sheet records numerical implementation details and its clearance guard.

| Detail | Proposed construction | Effect / limitation |
|---|---|---|
| Dimension authority | Use inch callouts × 25.4; cap OD 73.025, H 11.7348; jar OD 72.5424, H 77.1652, neck H 10.7696 mm | Consistent conversion within each drawing; replaces conflicting catalog measurements |
| Cap cavity | Nominal E/T midpoints 67.310 / 69.6976 mm; planar inner/outer deck with 1.5748 mm nominal thickness from overall H minus internal H | Does not reproduce mold draft, gate detail or measured deck sag |
| Cap top edge | 0.6 mm round; straight non-ribbed skirt | Undimensioned edge profile is approximate; maintain drawing overall bounds |
| PET wall / base / neck | 0.7 / 1.4 / 1.5 mm nominal thickness | Gives real inner surfaces for transmission; optical appearance, capacity and weight will be approximate |
| Jar transitions | 1.5 mm shoulder round, 3 mm heel round; 2 mm recessed underside and three equally spaced support details | Preserve the general reference features; exact radii and support geometry are unknown |
| Thread form | One-start right-hand helix, proposed 6 TPI (4.2333… mm pitch), 1.25 turns, rounded trapezoidal section | These are proposals for this pilot, not claims about the supplier's thread standard; document the complete generated profile before export |
| Mating clearance | Target 0.2 mm radial and flank clearance, matching helical phase; rim seated against cap's inner deck | Kernel interference check can validate the digital pair only; no assertion of fit to commercial parts or of sealing performance |
| Base codes / branding | Omit incidental codes and marks | Keeps models generic; three support details remain geometry |
| Finish | Glossy PP cap and clear PET jar using existing shared materials | Shader intent is separate from STEP; transparency and reflections require visual review |

Nominal drawing callouts should be reproduced within 0.01 mm computational error; this proposed
check is not a new supplier tolerance. STEP round-trip bounds should agree within 0.001 mm and
volume within 0.001% relative. Appearance of undimensioned features requires explicit visual
acceptance; no numerical fidelity to an unavailable physical sample can be claimed.

Before generating the other sizes, complete their own specific approximation sheets. Do not copy
the pilot pitch onto the EMP caps: their drawings explicitly specify 5 TPI. Keep the 58 rib count
and profile, the 120 chimes/shoulder, and the 110 source choice explicit in those sheets.

## Validation plan and current limits

Use the existing OCP interpreter and direct B-rep modeling; no new dependency or application service.
Validate generated solids and STEP re-import without healing, positive volumes, expected solid
counts, dimensions and seating intersections. Export separate cap/container parts plus an assembly
with named solids, +Y up, millimetres and recorded transforms. Inspect front/side/top/underside and
section views. Run actual OCCT ingestion and a Blender render with generic artwork before claiming
the pilot works in the application. Keep catalog entries unpublished and remove temporary test data.

All five pairs pass the generator, kernel/round-trip checks and real application importer with
normal LOD budgets. The pilot appearance was approved and its live upload/draft succeeded; temporary
records were removed. Production rendering confirmed a material-slot reset bug, corrected separately
with approval and a regression test. Source files remain unchanged by the importer. See the
[deliverable notes](../output/packaging-library/validation-notes.md) for the remaining carton parity
failure, material/zone-authoring limits and sampled rather than exhaustive thickness validation.
Commercial fit remains unverified even when digital geometry checks pass.

## References inspected

The PDFs remain supplier-owned; links identify the source without
assigning a redistribution license. No supplier drawing is copied into the retained documentation.

| ID | Source | Drawing date / revision |
|---|---|---|
| cap120 | [EMP 120-400 SM](https://www.empclosures.com/pdfs/EMP_DataSheets724-120-400SM.pdf), page 2 | July 11, 2014 |
| cap110 | [EMP 110-400 SM](https://www.empclosures.com/pdfs/EMP_DataSheets724-110-400SM.pdf), page 2 | November 21, 2016 |
| cap89 | [EMP 89-400 SM](https://www.empclosures.com/pdfs/89-400SM_DataSheets426.pdf), page 2 | November 21, 2016 |
| cap70 | [Precision Concepts 74-7225](https://www.pcinternational.com/wp-content/uploads/74-7225-Precision-Concepts-70-400-Continuous-Thread-Closure-Smooth-PP-Tech-Drawing.pdf), page 1 | No revision/date shown |
| cap58 | [Cary 30W58P](https://www.thecarycompany.com/media/pdf/specs/30W58P.pdf), page 2, drawing 58-400-6201(S) | December 15, 2003; revision 5 |
| jar120 | [Precision Concepts 61-0033](https://www.pcinternational.com/wp-content/uploads/61-0033-Precision-Concepts-100-oz-Canister-120-400-Panel-HPDE-Tech-Drawing.pdf), page 1 | No revision/date shown |
| jar110 | [Cary 68W64H](https://www.thecarycompany.com/media/pdf/specs/68W64H.pdf), page 1 | September 29, 2003; reference D-70441-2 |
| jar89 | [Precision Concepts 71-1770](https://www.pcinternational.com/wp-content/uploads/71-1770-Precision-Concepts-12-oz-Wide-Mouth-Jar-89-400-PET-Tech-Drawing.pdf), page 1 | No revision/date shown |
| jar70 | [Precision Concepts 71-1760](https://www.pcinternational.com/wp-content/uploads/71-1760-Precision-Concepts-8-oz-Wide-Mouth-Jar-70-400-PET-Tech-Drawing.pdf), page 1 | No revision/date shown |
| jar58 | [O.Berk N1002038 catalog](https://www.oberk.com/containers/plastic/plastic-jar/n1002038--6oz-white-wide-mouth-round-hdpe-with-58-400-neck-finish) | No engineering drawing obtained |

SHA-256 identifiers of the inspected PDFs, to distinguish future revisions at the same URL:

```text
cap120 df9f296164d7dff6affe5c1369e687d771bcd0c884280574d44ba0a197471a47
cap110 bd996b07c1bed01e1ad9e402e6a3827f4c990f34efbfc37cc80870ec9d9d2462
cap89  8832c3b4809ccfb01e0567292d903530fd75bd54099552006eace82e820d63bf
cap70  5e78131777d458d11678ba48dfd1f4d957a9ba2f820fca77e823f4b3ab89562e
cap58  1dfe15618994674ed6952c5d2113bf547ec70c438462e5d5c02066eda9e58f26
jar120 69a6f2d983c67a13131113259cb4ff761e7f260dc1ee7b2dc2fab52d4aecc523
jar110 e664cd4e11644f102489d0870607cbf413aad468c30929dc28befa40e9e362ac
jar89  4ff31d13bcde832e85d0c7e6ceca118cb97d32807e1bf7b86cba76fe44a8115f
jar70  044abcb832c31c9be434a57a3495500388e40552bc7d6f30d166dec502dd1395
```
