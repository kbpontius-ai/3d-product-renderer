# Cap and container library — CAD generation brief

Approved lineup. Generated using the recommended drawing
choices and visualization approximations. The [70-400 pilot](../output/packaging-library/README.md)
was visually approved; all five pairs are generated and kernel/importer validated. Importer metadata
and renderer material-assignment corrections are implemented. Remaining application acceptance
limits are recorded in the deliverable validation notes. See the [dimension audit](packaging-library-dimensions.md)
and [build handoff](packaging-library-build-plan.md). No catalog products published.
Target: visually faithful, editable packaging models for artwork placement and rendering, not
manufacturing-qualified replicas. This replaces the earlier small-cap and bottle shortlist.

## Approved models

Build five cap/container pairs: ten independently reusable parts, plus five seated assemblies.
All containers below have the matching **-400** neck finish; retain their individual profiles.
Do not obtain smaller sizes by uniformly scaling a larger model.

| Pair / stable asset ID | Cap requirement | Container geometry and resin | Reference |
|---|---|---|---|
| `120-400` | Non-ribbed sides; glossy finish | 100 oz HDPE round canister with panel/chime profile | [Precision Concepts 61-0033](https://www.pcinternational.com/catalog/canisters/100-oz-hdpe-threaded-canister120-400/) |
| `110-400` | Non-ribbed sides; glossy finish (confirmed by release of recommended plan) | 64 oz natural HDPE wide-mouth round jar; rounded shoulder and base | [Cary 68W64H](https://www.thecarycompany.com/64-oz-natural-hdpe-wide-mouth-jar-110mm-110-400-6x1-reshipper-carton) |
| `89-400` | Non-ribbed sides; glossy finish | 12 oz PET low-profile wide-mouth round jar | [Precision Concepts 71-1770](https://www.pcinternational.com/catalog/jars/12-oz-wide-mouth-jar-89-400-pet/) |
| `70-400` | Non-ribbed sides; glossy finish | 8 oz PET wide-mouth round jar | [Precision Concepts 71-1760](https://www.pcinternational.com/catalog/jars/8-oz-wide-mouth-jar-70-400-pet/) |
| `58-400` | Ribbed sides; matte textured top | 6 oz white HDPE wide-mouth round jar | [O.Berk N1002038](https://www.oberk.com/containers/plastic/plastic-jar/n1002038--6oz-white-wide-mouth-round-hdpe-with-58-400-neck-finish) |

**“Smooth” means no ribbed sides.** It does not prescribe a flat top, sharp corners, zero draft,
or a particular edge profile. Follow the selected cap drawing for those details. Gloss and matte
are material/finish requirements, separate from CAD shape. Smooth supplier descriptions alone
do not establish a measured gloss level. Cap resin target: PP, with the exact reference confirmed
before generation. Preserve the two PET / three HDPE container mix.

Starting cap references, not fully verified manufacturing specifications:

- 120-400: [EMP smooth cap](https://www.empclosures.com/caps-and-closures/120-400-sm/).
- 110-400: [EMP smooth-cap drawing](https://www.empclosures.com/pdfs/EMP_DataSheets724-110-400SM.pdf)
  is the selected non-ribbed candidate; use the glossy finish intent recorded at release.
- 89-400: [EMP smooth cap](https://www.empclosures.com/caps-and-closures/89-400-sm/).
- 70-400: [Precision Concepts 74-7225](https://www.pcinternational.com/catalog/jars/70-400-continuous-thread-closure-smooth-pp/).
- 58-400: [Cary 30W58P drawing](https://www.thecarycompany.com/media/pdf/specs/30W58P.pdf),
  fine-rib sides and chamfered matte top.

## Instructions to the generating AI

1. **Prepare a dimension sheet before modeling.** Record the exact SKU, drawing revision, source
   URL, units and each driving value. Classify every value as `documented`, `measured`,
   `approved approximation`, or `unknown`. Catalog photographs establish appearance, not dimensions.
   Read drawing callouts rather than scaling a PDF image. Resolve conflicting revisions with the
   reviewer; do not mix dimensions from different products or interpret case dimensions as part sizes.
2. Collect cap outside diameter/height, deck thickness and profile, skirt taper, edge radii,
   bore dimensions, and rib count/profile for 58-400. Collect container height/body diameter,
   shoulder/heel/base profiles, label-panel extents, neck dimensions and wall/base thickness.
   Record nominal versus overflow capacity separately. Matching finish labels establish an intended
   pairing, not demonstrated fit: obtain thread profile, pitch, starts, turns, handedness, lead-ins,
   engagement and seating clearances for both parts. Nominal neck size is not cap outside diameter.
3. **Stop on missing geometry-critical data.** Request measurements or present a specific
   simplification with its effect on appearance, fit and transparency. Do not silently substitute
   a generic cylinder, guess a wall thickness, copy another size's threads, or call inferred geometry
   an exact replica. Interiors may be simplified only after approval; transparent PET still needs
   credible inner surfaces and base thickness. The 110-400 cap finish decision was resolved by the recommended plan.
4. Generate parameterized source with an OCCT-backed CAD workflow. Prefer the repository's existing
   Python/OCP tooling and named STEP export pattern in [make-fixture-cad.py](../scripts/make-fixture-cad.py).
   Record versions and parameters. A different CAD dependency or way to run generation requires
   review before adoption; a manually typed STEP document is not a CAD-generation workflow.
5. Use **millimetres**, a shared +Y vertical axis and consistent part transforms. Container base is
   Y=0, centered on X/Z. Standalone cap uses a documented skirt-bottom origin; the assembly records
   its seated transform and thread phase. Keep `cap-body` and `container-body` as separate named
   solids with separate material ownership. No fused cap/container and no new liner feature.
6. Model hollow vessels as valid closed solids: an open mouth does not mean an open B-rep shell.
   Preserve reference silhouettes, shoulders, chimes, top profiles, ribs and visible bottom features.
   Exclude brand marks and incidental embossed codes unless separately requested. Reject invalid
   output and correct the generation source; do not repair supplier files or post-process generated
   files into an undocumented shape.
7. Supply finish intent separately from STEP. Use the app's existing shared preview/render material
   definitions for glossy PP, matte PP, PET and HDPE where supported. Matte top stipple is a shading
   detail unless macro comparison proves geometric texture necessary; grip ribs remain geometry.
   Color, PET clarity, HDPE translucency and gloss strength need sample/reference review. Do not claim
   transmission parity or independently tune the two renderers to different appearances.

## Artwork and application integration

Identify candidate decoration surfaces in the dimension sheet: each cap's usable top and each
container's smooth body/label panel. Record origin, outward normal, tangent, extents, clearances and
remaining wall thickness. Derive these from actual geometry, not the nominal neck size. Keep zones
off ribs, fillets, shoulder transitions and recessed-panel edges. Relief depth needs a verified
thickness budget; do not declare every surface emboss/deboss-capable automatically.

Reuse the existing [STEP ingestion and zone-authoring workflow](../README.md#cad-ingestion),
associated with `F-GEN-02` / `F-ADM-01`. Import with `CAD_IMPORTER=occt`; a reference-importer result
does not validate these assets. Review every named part and material assignment in the draft pack,
then author zones against the actual surface. Keep all products as drafts until approved.

The current importer includes healing. Therefore validate the exported STEP **before** importing;
record any importer repair and stop acceptance for review if one occurs. This brief neither changes
the CAD pipeline nor authorizes automatic repair. Preserve the exported source bytes and digest.

## Deliverables and acceptance

For each pair, deliver parametric source, a dimension/assumption sheet, separate cap and container
STEP files, a named seated assembly STEP, front/side/top/underside and section previews, and a
validation report. Record units, tool versions, part names, expected bounds, volume and file hashes.
References remain linked; do not assign their drawings or derivative models an assumed CC0 license.

- Re-import each STEP into the kernel without healing: expected named solid count, closed shells,
  finite positive solid volumes, and valid geometry. Export/re-import bounds and volumes must agree
  within recorded numerical tolerances. Original dimension tolerances govern reference comparisons;
  any missing visual acceptance tolerance is agreed before generation, not chosen afterward.
- Inspect seating and thread engagement in section, including interference and explicit contact/
  clearance allowances. A matching neck label or attractive assembly image alone is not fit evidence.
- Import the real files through the running app; compare bounds/part counts with the kernel report.
  Inspect materials and normals from inside and outside, and inspect glossy reflections for seams.
- Place generic artwork on the cap top and container body. Verify print and supported relief,
  position/scale, section views, and an actual Blender render. Examine counters, thin strokes,
  panel boundaries and the blank zone footprint; no customer artwork is required.
- Run applicable local unit/integration checks, typecheck, lint, environment checks, browser tests
  and a real preview frame for any resulting implementation. Record failures, skips and unverified
  cases plainly. GitHub CI must pass before merge unless explicitly waived for that PR; thresholds are not relaxed to accept new assets.

**Generation order:** propose the 70-400 PET jar/cap pair as the pilot because both selected
references offer technical drawings. Confirm its dimension sheet and assumptions first, generate
only that pair, then obtain visual/import/render acceptance before producing the other four.
No CAD generation, dependency installation, catalog publication or application code change is
authorized by creation of this brief.
