import { z } from 'zod';

const PreparationId = z.string().min(1).max(160);
export const ArtworkEndpoint = z
  .object({
    objectId: PreparationId,
    subpathId: PreparationId,
    end: z.enum(['start', 'end']),
  })
  .strict();
export type ArtworkEndpoint = z.infer<typeof ArtworkEndpoint>;

export const ArtworkRepair = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('close'), objectId: PreparationId, subpathId: PreparationId })
    .strict(),
  z.object({ kind: z.literal('join'), a: ArtworkEndpoint, b: ArtworkEndpoint }).strict(),
  z
    .object({
      kind: z.literal('stroke-width'),
      objectId: PreparationId,
      widthMm: z.number().finite().positive().max(100),
    })
    .strict(),
]);
export type ArtworkRepair = z.infer<typeof ArtworkRepair>;

export const ArtworkPreparationTransform = z
  .object({
    widthMm: z.number().finite().min(0.01).max(1000),
    heightMm: z.number().finite().min(0.01).max(1000),
    rotationDeg: z.number().finite().min(-360).max(360),
    flipX: z.boolean(),
    flipY: z.boolean(),
  })
  .strict();

export const ArtworkPreparationRecipe = z
  .object({
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    analyzerVersion: z.string().min(1).max(30),
    selected: z
      .array(
        z.object({ objectId: PreparationId, paint: z.enum(['both', 'fill', 'stroke']) }).strict(),
      )
      .max(5000)
      .refine(
        (items) => new Set(items.map((item) => item.objectId)).size === items.length,
        'An object can only be selected once.',
      ),
    repairs: z.array(ArtworkRepair).max(200),
    acknowledged: z.array(PreparationId).max(5000),
    transforms: z.array(ArtworkPreparationTransform).max(50),
  })
  .strict();
export type ArtworkPreparationRecipe = z.infer<typeof ArtworkPreparationRecipe>;

export function canonicalArtworkPreparationRecipe(
  input: ArtworkPreparationRecipe,
): ArtworkPreparationRecipe {
  const recipe = ArtworkPreparationRecipe.parse(input);
  recipe.selected.sort((a, b) => a.objectId.localeCompare(b.objectId, 'en'));
  recipe.acknowledged = [...new Set(recipe.acknowledged)].sort();
  return recipe;
}

export const ArtworkPreparationRequest = z
  .object({
    source: z
      .string()
      .max(5 * 1024 * 1024)
      .optional(),
    artworkId: z.string().uuid().optional(),
    versionId: z.string().uuid().optional(),
    recipe: ArtworkPreparationRecipe.optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.source) || Boolean(value.artworkId),
    'Choose a file or an existing artwork.',
  )
  .refine(
    (value) => !value.artworkId || Boolean(value.versionId),
    'The artwork version is required.',
  );
export type ArtworkPreparationRequest = z.infer<typeof ArtworkPreparationRequest>;
