# 12 — Shared Schemas

All schemas live in `packages/design-schema` as Zod, are exported to JSON Schema for the Python
CAD pipeline, and are the contract between browser, API, and workers. If a value can change a
rendered pixel, it is in one of these schemas.

---

## 1. DesignDocument

The saved state of a design. Portable, versioned, renderer-independent.

```ts
export const DesignDocument = z.object({
  schemaVersion: z.literal(1),
  units: z.literal('mm'), // explicit; no implicit unit anywhere

  product: z.object({
    packKey: z.string(),
    packVersion: z.string(), // pinned: a pack upgrade never mutates a design
    productKey: z.string(),
    variantKey: z.string(),
  }),

  materials: z.record(
    SlotKey,
    z.object({
      // keyed by pack-declared material slot
      materialKey: z.string(),
      colorHex: HexColor.optional(), // only if the material is colorizable
      textureScale: z.number().positive().default(1),
      textureRotationDeg: z.number().default(0),
      overrides: z
        .object({
          // bounded artistic control
          roughness: z.number().min(0).max(1).optional(),
          metallic: z.number().min(0).max(1).optional(),
          clearcoat: z.number().min(0).max(1).optional(),
        })
        .partial()
        .optional(),
    }),
  ),

  placements: z.array(Placement).max(32),

  scene: z.object({
    environmentKey: z.string(),
    environmentRotationDeg: z.number().default(0),
    exposureEv: z.number().default(0),
    background: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('studio') }),
      z.object({ kind: z.literal('solid'), colorHex: HexColor }),
      z.object({ kind: z.literal('transparent') }),
    ]),
    camera: Camera,
  }),

  annotations: z.object({ note: z.string().max(2000).optional() }).default({}),
});

export const Placement = z.object({
  id: z.string().uuid(),
  zoneKey: z.string(),
  artwork: z.object({ artworkId: z.string().uuid(), versionId: z.string().uuid() }),

  // Transform is expressed in ZONE SPACE: millimetres, origin at zone center,
  // +x right, +y up, on the unrolled surface. See 15-placement-math.md.
  transform: z.object({
    offsetMm: z.object({ x: z.number(), y: z.number() }),
    sizeMm: z.object({ w: z.number().positive(), h: z.number().positive() }),
    rotationDeg: z.number().min(-360).max(360).default(0),
    flipX: z.boolean().default(false),
    flipY: z.boolean().default(false),
    lockAspect: z.boolean().default(true), // UI state, preserved for round-trips
  }),

  finish: z.discriminatedUnion('kind', [
    z.object({
      kind: z.enum(['emboss', 'deboss']),
      depthMm: z.number().min(0.05).max(5),
      bevelDeg: z.number().min(0).max(75).default(30), // draft angle of the side wall
      edgeRadiusMm: z.number().min(0).max(1).default(0.05),
      inkMaterialKey: z.string().optional(), // absent = blind (same as part)
    }),
    z.object({
      kind: z.literal('print'),
      inkMaterialKey: z.string(),
      tintHex: HexColor.optional(),
      opacity: z.number().min(0).max(1).default(1),
    }),
  ]),

  order: z.number().int().default(0),
});

export const Camera = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), presetKey: z.string() }),
  z.object({
    kind: z.literal('custom'),
    positionMm: Vec3,
    targetMm: Vec3,
    upMm: Vec3.default([0, 1, 0]),
    focalMm: z.number().min(8).max(400).default(85),
    sensorMm: z.number().min(4).max(70).default(36),
    fStop: z.number().min(0.7).max(32).optional(), // absent = pinhole
    focusDistanceMm: z.number().positive().optional(),
  }),
]);
```

**Invariants** (checked by `validateDesign(doc, packContext)`, shared by UI and API):

- every `zoneKey` exists on the variant; every `materialKey` is allowed for its slot;
- `finish.kind` is in the zone's `constraints.finishes`; `depthMm ≤ constraints.maxDepthMm`;
- the transformed artwork bbox lies within the zone bounds (safe-margin violations are warnings);
- `sizeMm` ratio matches the artwork's natural aspect when `lockAspect` is true.

### Artwork library edits (built)

`ArtworkEdit` in `packages/design-schema/src/artwork.ts` validates the browser and API contract
for `PUT /api/artworks/:id`: expected `versionId` (UUID), trimmed `name` (1–200 characters),
finite `widthMm` and `heightMm` (0.01–1000), finite `rotationDeg` (−360–360), and boolean
`flipX`/`flipY`. Dimensions describe visible artwork before rotation. Aspect lock is local editor
state; the API receives the resulting dimensions. Shape edits create immutable versions and do
not change the artwork references pinned in `DesignDocument`.

## 2. RenderSpec (immutable job input)

```ts
export const RenderSpec = z.object({
  specVersion: z.literal(1),
  document: DesignDocument, // snapshot, not a reference
  resolved: z.object({
    // digest-pinned asset resolution
    meshKey: z.string(),
    meshDigest: Digest,
    zones: z.array(
      z.object({
        zoneKey: z.string(),
        frame: ZoneFrame,
        sizeMm: ZoneSize,
        uvRect: UvRect.nullable(),
      }),
    ),
    artwork: z.array(
      z.object({
        versionId: z.string().uuid(),
        heightKey: z.string(),
        maskKey: z.string(),
        sdfKey: z.string(),
        mmPerPx: z.number(),
        digest: Digest,
      }),
    ),
    materials: z.array(
      z.object({ key: z.string(), version: z.number(), definition: MaterialDefinition }),
    ),
    environment: z.object({
      key: z.string(),
      hdriKey: z.string(),
      rotationDeg: z.number(),
      exposureEv: z.number(),
    }),
  }),

  outputs: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('image'),
          widthPx: z.number().int().min(256).max(8192),
          heightPx: z.number().int().min(256).max(8192),
          format: z.enum(['png8', 'png16', 'jpeg', 'webp']),
          alpha: z.boolean().default(false),
          camera: Camera,
        }),
        z.object({
          // v2 turntable — one shared orbit path
          kind: z.literal('video'),
          widthPx: z.number().int(),
          heightPx: z.number().int(),
          fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
          durationSec: z.number().min(3).max(20).default(8),
          orbit: z.object({
            elevationDeg: z.number().default(18),
            radiusScale: z.number().default(2.6), // × bounding-sphere radius ⇒ product-agnostic
            startAzimuthDeg: z.number().default(0),
            loop: z.boolean().default(true),
          }),
          format: z.enum(['mp4', 'webm']).default('mp4'),
        }),
      ]),
    )
    .min(1)
    .max(16),

  quality: z.object({
    preset: z.enum(['draft', 'standard', 'final']),
    samples: z.number().int().min(16).max(4096),
    maxBounces: z.number().int().min(2).max(24),
    denoiser: z.enum(['none', 'optix', 'oidn']),
    adaptiveThreshold: z.number().min(0).max(0.1),
    displacement: z.object({
      mode: z.enum(['bump', 'displacement']), // draft may fall back to bump
      dicingRate: z.number().min(0.25).max(4).default(1),
    }),
  }),

  seed: z.number().int(),
  renderer: z.object({ id: z.string(), version: z.string() }),
  limits: z.object({ maxWallClockSec: z.number().int(), maxVramMb: z.number().int() }),
});
```

`spec_hash = sha256(canonicalJson(RenderSpec))` — the idempotency key, the dedupe key, and the
proof of determinism. Any change to any input changes the hash.

## 3. Product Pack manifest (`F-GEN-01`)

```ts
export const PackManifest = z.object({
  manifestVersion: z.literal(1),
  key: z.string().regex(/^[a-z0-9.-]+$/), // 'closures.standard'
  version: SemVer,
  name: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),

  materials: z.array(MaterialDefinition).default([]), // pack may embed materials to be self-contained
  environments: z.array(z.string()).default([]), // keys it expects to exist

  products: z
    .array(
      z.object({
        key: z.string(),
        name: z.string(),
        category: z.string(),
        facets: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        variants: z
          .array(
            z.object({
              key: z.string(),
              name: z.string(),
              dimensionsMm: z.object({ bbox: z.tuple([Vec3, Vec3]) }).catchall(z.number()),
              assets: z.object({
                lod0: AssetRef,
                lod1: AssetRef.optional(),
                renderMesh: AssetRef,
                thumbnail: AssetRef.optional(),
              }),
              materialSlots: z
                .array(
                  z.object({
                    key: z.string(),
                    label: z.string(),
                    defaultMaterialKey: z.string(),
                    allowedFamilies: z.array(z.string()).default([]),
                    colorizable: z.boolean().default(true),
                  }),
                )
                .min(1),
              zones: z.array(DecorationZoneDef).default([]),
              cameraPresets: z
                .array(
                  z.object({
                    key: z.string(),
                    label: z.string(),
                    // Framing is relative to the bounding sphere, so presets are product-agnostic
                    azimuthDeg: z.number(),
                    elevationDeg: z.number(),
                    radiusScale: z.number().default(2.4),
                    focalMm: z.number().default(85),
                    targetOffsetMm: Vec3.default([0, 0, 0]),
                  }),
                )
                .default([]),
              capabilities: z
                .object({
                  transmission: z.boolean().default(false),
                  video: z.boolean().default(true),
                  deformable: z.boolean().default(false), // v2 flat-panel fold
                })
                .default({}),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export const DecorationZoneDef = z.discriminatedUnion('type', [
  z.object({
    // flat face
    type: z.literal('planar'),
    key: z.string(),
    name: z.string(),
    frame: z.object({ originMm: Vec3, normal: Vec3, tangent: Vec3 }),
    sizeMm: z.object({
      width: z.number(),
      height: z.number(),
      safeMarginMm: z.number().default(1),
    }),
    uvRect: UvRect.optional(),
    constraints: ZoneConstraints,
  }),
  z.object({
    // wrap around an axis (cap skirt, bottle body)
    type: z.literal('cylindrical'),
    key: z.string(),
    name: z.string(),
    frame: z.object({
      axisOriginMm: Vec3,
      axisDir: Vec3,
      radiusMm: z.number(),
      centerAngleDeg: z.number(),
      centerHeightMm: z.number(),
    }),
    sizeMm: z.object({
      arcWidthMm: z.number(),
      height: z.number(),
      safeMarginMm: z.number().default(1),
    }),
    constraints: ZoneConstraints,
  }),
  z.object({
    // authored UV island
    type: z.literal('uv_rect'),
    key: z.string(),
    name: z.string(),
    uvSet: z.string().default('decor'),
    uvRect: UvRect,
    sizeMm: z.object({
      width: z.number(),
      height: z.number(),
      safeMarginMm: z.number().default(1),
    }),
    constraints: ZoneConstraints,
  }),
  z.object({
    // projected onto arbitrary curvature
    type: z.literal('conformal'),
    key: z.string(),
    name: z.string(),
    frame: z.object({
      originMm: Vec3,
      normal: Vec3,
      tangent: Vec3,
      maxProjectionDepthMm: z.number(),
    }),
    sizeMm: z.object({
      width: z.number(),
      height: z.number(),
      safeMarginMm: z.number().default(1),
    }),
    constraints: ZoneConstraints,
  }),
  z.object({
    // v2: dieline panel on flat stock
    type: z.literal('flat_panel'),
    key: z.string(),
    name: z.string(),
    panelId: z.string(),
    uvRect: UvRect,
    sizeMm: z.object({
      width: z.number(),
      height: z.number(),
      safeMarginMm: z.number().default(3),
    }),
    constraints: ZoneConstraints,
  }),
]);

export const ZoneConstraints = z.object({
  finishes: z.array(z.enum(['emboss', 'deboss', 'print'])).min(1),
  maxDepthMm: z.number().default(0.6),
  minStrokeMm: z.number().default(0.25),
  maxCoverage: z.number().min(0).max(1).default(0.9), // fraction of zone area
  wrapWarnDeg: z.number().default(120), // cylindrical legibility warning
});
```

Adding a product = shipping a pack. There is no product-specific code path anywhere in the app;
the closed set of zone types is the only place geometry-awareness lives.

## 4. Material definition (neutral + mappings)

```ts
export const MaterialDefinition = z.object({
  key: z.string(),
  name: z.string(),
  version: z.number().int().default(1),
  family: z.enum(['plastic', 'metal', 'paperboard', 'glass', 'ink', 'foil', 'coating']),
  colorizable: z.boolean().default(true),

  base: z.object({
    // physically-based, renderer-neutral
    baseColorHex: HexColor.default('#cccccc'),
    roughness: z.number().min(0).max(1).default(0.4),
    metallic: z.number().min(0).max(1).default(0),
    ior: z.number().min(1).max(3).default(1.5),
    specular: z.number().min(0).max(1).default(0.5),
    clearcoat: z.number().min(0).max(1).default(0),
    clearcoatRoughness: z.number().min(0).max(1).default(0.05),
    sheen: z.number().min(0).max(1).default(0),
    transmission: z.number().min(0).max(1).default(0),
    thicknessMm: z.number().default(0),
    attenuationColorHex: HexColor.optional(),
    attenuationDistanceMm: z.number().optional(),
    emissiveHex: HexColor.optional(),
    emissiveStrength: z.number().default(0),
  }),

  maps: z
    .object({
      // KTX2 for web, PNG/EXR for render
      baseColor: TextureRef.optional(),
      roughness: TextureRef.optional(),
      metallic: TextureRef.optional(),
      normal: TextureRef.optional(),
      ao: TextureRef.optional(),
      height: TextureRef.optional(),
      tilingMm: z.number().default(50),
    })
    .default({}),

  mapping: z
    .object({
      // renderer-specific fine-tuning only
      three: z.record(z.string(), z.unknown()).default({}),
      cycles: z.record(z.string(), z.unknown()).default({}),
    })
    .default({}),
});
```

Rule: `base` is authoritative. `mapping` may only _refine_ (e.g. Cycles-specific subsurface for
soft-touch), never contradict — the parity test in [20](20-testing-ci.md) enforces this empirically.

## 5. Artwork processing report

```ts
export const ArtworkReport = z.object({
  pipelineVersion: z.string(),
  status: z.enum(['ready', 'rejected']),
  errors: z.array(
    z.object({ code: ArtworkErrorCode, message: z.string(), hint: z.string().optional() }),
  ),
  warnings: z.array(
    z.object({
      code: ArtworkWarnCode,
      message: z.string(),
      detail: z.record(z.unknown()).optional(),
    }),
  ),
  stats: z.object({
    pathCount: z.number(),
    nodeCount: z.number(),
    naturalSizeMm: z.object({ w: z.number(), h: z.number() }),
    contentBbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    minStrokeMm: z.number().nullable(),
    coverage: z.number(),
    hasText: z.boolean(),
    hasGradients: z.boolean(),
    hasClipPaths: z.boolean(),
  }),
});

export type ArtworkErrorCode =
  | 'not_svg'
  | 'too_large'
  | 'parse_failed'
  | 'contains_external_reference'
  | 'text_not_outlined'
  | 'empty_after_normalize'
  | 'complexity_exceeded'
  | 'unsupported_units';

export type ArtworkWarnCode =
  | 'open_paths'
  | 'thin_strokes'
  | 'gradients_flattened'
  | 'filters_dropped'
  | 'self_intersections'
  | 'aspect_extreme'
  | 'low_contrast_for_emboss';
```

Error codes are stable identifiers; user-facing copy lives in the UI so it can be reworded or
localized without changing pipeline behavior.

## 6. Versioning & migration

```ts
// packages/design-schema/src/migrate.ts
const migrations: Record<number, (doc: any) => any> = {
  // 1 → 2 example: placements gained `flipX/flipY`
  1: (d) => ({
    ...d,
    schemaVersion: 2,
    placements: d.placements.map((p) => ({
      ...p,
      transform: { flipX: false, flipY: false, ...p.transform },
    })),
  }),
};

export function migrateDesign(raw: unknown): DesignDocument {
  let doc = raw as any;
  while (doc.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = migrations[doc.schemaVersion];
    if (!step) throw new SchemaMigrationError(doc.schemaVersion);
    doc = step(doc);
  }
  return DesignDocument.parse(doc); // fail loudly rather than render something wrong
}
```

Rules:

1. Stored documents are **never** rewritten in place; migration happens on read.
2. A migration must be pure and total — no I/O, no defaults that change an existing look.
3. If a migration would change rendered output, it is not a migration: it's a new design version
   created explicitly by a user action.
4. `RenderSpec` embeds the migrated document, so a re-render of an old job reproduces the old look
   only when the renderer version is also pinned — both are recorded in provenance.

## Artwork preparation recipe (F-ART-12)

The implemented contract is `packages/design-schema/src/artwork-preparation.ts`. Strict Zod
objects reject unknown client fields, including supplied derived SVG/mask content. The server
recomputes output from the authorized source and recipe.

| Field                             | Meaning and limit                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sourceDigest`, `analyzerVersion` | SHA-256 of exact UTF-8 original bytes and the stable manifest algorithm version                          |
| `selected`                        | Up to 5,000 unique object/instance IDs, each retaining `both`, `fill` or `stroke`                        |
| `repairs`                         | Ordered, at most 200 explicit `close`, compatible endpoint `join`, or positive `stroke-width` operations |
| `acknowledged`                    | IDs of accepted current review issues; blocking errors cannot be acknowledged away                       |
| `transforms`                      | At most 50 ordered whole-artwork size/rotation/flip edits; dimensions 0.01–1,000 mm                      |

Close records one object/subpath ID. Join records two object/subpath IDs and their chosen
`start`/`end` endpoints; it does not request snapping. Width is positive and at most 100 mm.
Selection and acknowledgement order is canonicalized for caching; repair and transform order
is preserved because it changes the result. Object/subpath IDs are scoped to the source digest
and analyzer version, not portable identities across arbitrary re-exports.

Requests accept a new UTF-8 `source` (5 MB byte ceiling), or an authorized `artworkId` and
expected current `versionId`; supplying both supports explicit original reupload for a legacy
version. The optional name has a 200-character ceiling. JSON intake has an 8 MB streaming limit.
The manifest/report remains an analysis DTO in `packages/svg`, rather than a renderer contract:
workers consume the immutable canonical artwork version through the existing design reference.
No DesignDocument schema change or migration of pinned design references is required.

## Orientation frame contract

`OrientationFrame` is `{version: 1, frontSource: [x,y,z], upSource: [x,y,z]}`. Both vectors must be finite, normalized and perpendicular. Front is the outward normal of the reference plane; Up is tangent. Right = Up × Front. `PresentationOrientation` adds `confirmed: boolean` for catalog drafts.

The optional fields are variant `presentationOrientation`, design scene `presentationOrientationOverride`, and render resolved `presentationOrientation`. Existing schema versions remain unchanged because the fields are additive. Absence keeps legacy behavior and canonical hashes. A present override wins over the pinned variant's confirmed default. Source geometry, bounds, physical zone frames and artwork coordinates are untouched. Old immutable job inputs are never rewritten.

### Optional decoration part target

Every `DecorationZoneDef` supports `materialSlotKey?: Key`. It references one of the containing
variant's declared material slots; pack validation rejects unknown keys. Catalog reads recover the
field from the authoritative manifest, so no database migration is required. The resolved zones
capture it in RenderSpec. Existing zones without the field retain legacy target resolution.
