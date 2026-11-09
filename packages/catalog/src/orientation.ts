import { createHash } from 'node:crypto';
import { recordAudit, withStaff, type Sql } from '@pr/db';
import {
  PackManifest,
  PresentationOrientation,
  MaterialDefinition,
  finishOf,
  type PresentationOrientation as Frame,
} from '@pr/design-schema';

export const setupRevision = (manifest: unknown): string =>
  createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

export class OrientationEditError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

export async function updateProductSetup(
  sql: Sql,
  input: {
    packId: string;
    productKey: string;
    variantKey: string;
    revision: string;
    orientation?: Frame;
    materialDefaults?: Record<string, string>;
  },
  actorId: string | null,
) {
  return withStaff(sql, async (tx) => {
    const [row] =
      await tx`select manifest, status from product_packs where id = ${input.packId} for update`;
    if (!row) throw new OrientationEditError('This pack no longer exists.', 'not_found');
    if (row['status'] !== 'draft')
      throw new OrientationEditError(
        'Make a new draft version before changing product setup.',
        'conflict',
      );
    if (setupRevision(row['manifest']) !== input.revision)
      throw new OrientationEditError(
        'This draft changed in another window. Reload before saving.',
        'conflict',
      );
    const manifest = PackManifest.parse(row['manifest']);
    const variant = manifest.products
      .find((p) => p.key === input.productKey)
      ?.variants.find((v) => v.key === input.variantKey);
    if (!variant) throw new OrientationEditError('This variant no longer exists.', 'not_found');
    const [used] =
      await tx`select count(*)::int as count from designs d join product_variants v on v.id = d.product_variant_id join products p on p.id = v.product_id where p.pack_id = ${input.packId} and p.key = ${input.productKey} and v.key = ${input.variantKey} and d.deleted_at is null`;
    if (Number(used?.['count'] ?? 0) > 0)
      throw new OrientationEditError(
        'Designs use this variant. Make a new draft version so their presentation stays unchanged.',
        'conflict',
      );
    if (input.orientation)
      variant.presentationOrientation = PresentationOrientation.parse(input.orientation);
    if (input.materialDefaults) {
      for (const [key, materialKey] of Object.entries(input.materialDefaults)) {
        const slot = variant.materialSlots.find((s) => s.key === key);
        const [material] =
          await tx`select definition from materials where key = ${materialKey} and org_id is null and status = 'published' limit 1`;
        if (!slot || !material)
          throw new OrientationEditError(
            'Choose an existing material for each product slot.',
            'invalid',
          );
        const definition = MaterialDefinition.parse(material['definition']);
        if (slot.allowedFinishes.length && !slot.allowedFinishes.includes(finishOf(definition)))
          throw new OrientationEditError('That finish is not allowed for this slot.', 'invalid');
        if (slot.allowedFamilies.length && !slot.allowedFamilies.includes(definition.family))
          throw new OrientationEditError(
            'That material family is not allowed for this slot.',
            'invalid',
          );
        slot.defaultMaterialKey = materialKey;
        if (!manifest.materials.some((m) => m.key === definition.key))
          manifest.materials.push(definition);
      }
      await tx`update product_variants v set material_slots = ${tx.json(variant.materialSlots as never)} from products p where v.product_id = p.id and p.pack_id = ${input.packId} and p.key = ${input.productKey} and v.key = ${input.variantKey}`;
    }
    await tx`update product_packs set manifest = ${tx.json(manifest as never)} where id = ${input.packId}`;
    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'product.setup_updated',
      targetType: 'product_pack',
      targetId: input.packId,
      metadata: {
        productKey: input.productKey,
        variantKey: input.variantKey,
        orientation: input.orientation ?? null,
        materialDefaults: input.materialDefaults ?? null,
      },
    });
    // JSONB canonicalizes key order; read that representation for the next concurrency token.
    const [saved] = await tx`select manifest from product_packs where id = ${input.packId}`;
    return { revision: setupRevision(saved!['manifest']) };
  });
}
