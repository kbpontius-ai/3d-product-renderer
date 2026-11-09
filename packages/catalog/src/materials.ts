import { recordAudit, uuidv7, withStaff, type Sql } from '@pr/db';
import { MaterialDefinition } from '@pr/design-schema';

/**
 * The material library (F-ADM-04).
 *
 * Materials arrive with packs, and then need adjusting: a plastic that reads too glossy on screen,
 * a board that wants a different tint. Editing them is a catalog-wide act — a design names a
 * material by key, so changing one changes every design that uses it, which is the point and also
 * the risk. Hence: staff only, audited, and the count of designs affected is shown before the edit.
 *
 * Textures are stored like any other asset. The definition holds their storage keys, which is what
 * both renderers resolve, so a texture uploaded here is one the worker can already fetch.
 */

export interface MaterialRecord {
  id: string;
  key: string;
  name: string;
  family: string;
  status: 'draft' | 'published' | 'deprecated';
  definition: MaterialDefinition;
  /** Where it came from: a pack's manifest, or created here. */
  origin: 'pack' | 'library';
  /** Designs whose material assignments name this key. */
  usedByDesigns: number;
}

export class MaterialError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'MaterialError';
  }
}

export async function listMaterialsForStaff(sql: Sql): Promise<MaterialRecord[]> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select m.id, m.key, m.name, m.family, m.status, m.definition, m.org_id,
        (select count(*) from designs d
          join design_versions dv on dv.id = d.current_version_id
         where d.deleted_at is null
           and exists (
             select 1
             from jsonb_each(coalesce(dv.document -> 'materials', '{}'::jsonb)) as slot(slot_key, slot_value)
             where slot_value ->> 'materialKey' = m.key
           )) as used_by
      from materials m
      order by m.family, m.key`;

    return rows.map((row) => ({
      id: row['id'] as string,
      key: row['key'] as string,
      name: row['name'] as string,
      family: row['family'] as string,
      status: row['status'] as MaterialRecord['status'],
      definition: row['definition'] as MaterialDefinition,
      // Pack materials are global (no org); a material created in the console is too. The
      // difference that matters to an operator is whether a re-import would overwrite it.
      origin: (row['definition'] as { origin?: string }).origin === 'library' ? 'library' : 'pack',
      usedByDesigns: Number(row['used_by'] ?? 0),
    }));
  });
}

export async function getMaterial(sql: Sql, id: string): Promise<MaterialRecord> {
  const material = (await listMaterialsForStaff(sql)).find((candidate) => candidate.id === id);
  if (!material) throw new MaterialError('not_found', 'no such material');
  return material;
}

export interface MaterialInput {
  key: string;
  name: string;
  family: MaterialDefinition['family'];
  definition: unknown;
  status?: MaterialRecord['status'];
}

export async function createMaterial(
  sql: Sql,
  input: MaterialInput,
  actorId: string | null,
): Promise<MaterialRecord> {
  const definition = parseDefinition({ ...(input.definition as object), key: input.key, name: input.name, family: input.family });

  const id = uuidv7();
  await withStaff(sql, async (tx) => {
    const [existing] = await tx`select id from materials where key = ${input.key} and org_id is null`;
    if (existing) throw new MaterialError('conflict', `a material called "${input.key}" already exists`);

    await tx`
      insert into materials (id, org_id, key, name, family, definition, status)
      values (${id}, null, ${input.key}, ${input.name}, ${input.family},
              ${tx.json({ ...definition, origin: 'library' } as never)},
              ${input.status ?? 'published'})`;

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'material.created',
      targetType: 'material',
      targetId: input.key,
      metadata: { family: input.family },
    });
  });

  return getMaterial(sql, id);
}

export async function updateMaterial(
  sql: Sql,
  id: string,
  patch: { name?: string; status?: MaterialRecord['status']; definition?: unknown },
  actorId: string | null,
): Promise<MaterialRecord> {
  await withStaff(sql, async (tx) => {
    const [row] = await tx`select key, name, family, definition, status from materials where id = ${id}`;
    if (!row) throw new MaterialError('not_found', 'no such material');

    const current = row['definition'] as MaterialDefinition & { origin?: string };
    const merged = patch.definition
      ? parseDefinition({
          ...(patch.definition as object),
          key: row['key'],
          name: patch.name ?? row['name'],
          family: row['family'],
        })
      : current;

    await tx`
      update materials
      set name = ${patch.name ?? row['name']},
          status = ${patch.status ?? row['status']},
          definition = ${tx.json({ ...merged, origin: current.origin ?? 'pack' } as never)},
          version = version + 1
      where id = ${id}`;

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: 'material.updated',
      targetType: 'material',
      targetId: row['key'] as string,
      metadata: { fields: Object.keys(patch) },
    });
  });

  return getMaterial(sql, id);
}

/** Points one of a material's texture slots at a stored asset. */
export async function setMaterialTexture(
  sql: Sql,
  id: string,
  slot: 'baseColor' | 'roughness' | 'metallic' | 'normal' | 'ao' | 'height',
  storageKey: string | null,
  actorId: string | null,
): Promise<MaterialRecord> {
  await withStaff(sql, async (tx) => {
    const [row] = await tx`select key, definition from materials where id = ${id}`;
    if (!row) throw new MaterialError('not_found', 'no such material');

    const definition = structuredClone(row['definition']) as MaterialDefinition & { origin?: string };
    const maps = { ...definition.maps } as Record<string, unknown>;
    if (storageKey) {
      // Colour maps are authored in sRGB and everything else is linear data; getting this wrong is
      // the difference between a texture that looks right and one that looks washed out.
      maps[slot] = { path: storageKey, colorSpace: slot === 'baseColor' ? 'srgb' : 'linear' };
    } else {
      delete maps[slot];
    }

    await tx`
      update materials
      set definition = ${tx.json({ ...definition, maps } as never)}, version = version + 1
      where id = ${id}`;

    await recordAudit(tx, {
      orgId: null,
      actorUserId: actorId,
      action: storageKey ? 'material.texture_set' : 'material.texture_cleared',
      targetType: 'material',
      targetId: row['key'] as string,
      metadata: { slot },
    });
  });

  return getMaterial(sql, id);
}

function parseDefinition(raw: unknown): MaterialDefinition {
  const parsed = MaterialDefinition.safeParse(raw);
  if (!parsed.success) {
    throw new MaterialError('invalid', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return parsed.data;
}
