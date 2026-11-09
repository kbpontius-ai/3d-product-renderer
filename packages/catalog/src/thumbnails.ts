import { withStaff, recordAudit, uuidv7, type Sql } from '@pr/db';
import { crc32, inflateSync } from 'node:zlib';
import { decodePng } from '@pr/artwork/png';
import { MaterialDefinition, type Vec3 } from '@pr/design-schema';
import type { CameraPresetDef } from '@pr/scene';
import type { Storage } from '@pr/storage';

export class ThumbnailError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}
export interface ThumbnailVariant {
  id: string;
  key: string;
  productName: string;
  name: string;
  bboxMm: [Vec3, Vec3];
  cameraPresets: CameraPresetDef[];
  materialSlots: { key: string; defaultMaterialKey: string }[];
  meshKey: string | null;
  thumbnailKey: string | null;
}
export async function thumbnailMaterials(sql: Sql): Promise<Record<string, MaterialDefinition>> {
  return withStaff(sql, async (tx) => {
    const rows =
      await tx`select key,definition from materials where org_id is null order by key,version`;
    return Object.fromEntries(
      rows.map((row) => [row['key'] as string, MaterialDefinition.parse(row['definition'])]),
    );
  });
}
export async function listThumbnailVariants(sql: Sql, packId: string): Promise<ThumbnailVariant[]> {
  return withStaff(sql, async (tx) => {
    const rows = await tx`
      select v.id,v.key,p.name as product_name,v.name,v.dimensions_mm,v.camera_presets,v.material_slots,
        mesh.storage_key as mesh_key,coalesce(t.storage_key,a.storage_key) as thumbnail_key
      from product_variants v join products p on p.id=v.product_id
      left join catalog_thumbnails t on t.variant_id=v.id
      left join product_assets a on a.variant_id=v.id and a.kind='thumbnail'
      left join product_assets mesh on mesh.variant_id=v.id and mesh.kind='lod0'
      where p.pack_id=${packId} order by p.sort,v.key`;
    return rows.map((r) => ({
      id: r['id'] as string,
      key: r['key'] as string,
      productName: r['product_name'] as string,
      name: r['name'] as string,
      bboxMm: (r['dimensions_mm'] as { bbox: [Vec3, Vec3] }).bbox,
      cameraPresets: r['camera_presets'] as CameraPresetDef[],
      materialSlots: r['material_slots'] as ThumbnailVariant['materialSlots'],
      meshKey: r['mesh_key'] as string | null,
      thumbnailKey: r['thumbnail_key'] as string | null,
    }));
  });
}
export function validateThumbnailPng(bytes: Uint8Array): void {
  const invalid = () =>
    new ThumbnailError(
      'invalid',
      'A Catalog preview must be a valid 768 × 576 PNG, no larger than 2 MB.',
    );
  if (bytes.length < 33 || bytes.length > 2 * 1024 * 1024) throw invalid();
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => bytes[index] !== byte)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(16) !== 768 ||
    view.getUint32(20) !== 576 ||
    bytes[24] !== 8 ||
    ![2, 6].includes(bytes[25]!)
  )
    throw invalid();
  try {
    const data: Buffer[] = [];
    let offset = 8;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset);
      if (offset + size + 12 > bytes.length) throw invalid();
      const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
      if ((offset === 8 && (type !== 'IHDR' || size !== 13)) || (offset !== 8 && type === 'IHDR'))
        throw invalid();
      if (crc32(bytes.slice(offset + 4, offset + 8 + size)) !== view.getUint32(offset + 8 + size))
        throw invalid();
      if (type === 'IDAT') data.push(Buffer.from(bytes.slice(offset + 8, offset + 8 + size)));
      offset += size + 12;
      if (type === 'IEND') {
        ended = size === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended) throw invalid();
    // Bound decompression before the shared decoder allocates pixels from an uploaded file.
    const channels = bytes[25] === 6 ? 4 : 3;
    const rawSize = (768 * channels + 1) * 576;
    const raw = inflateSync(Buffer.concat(data), { maxOutputLength: rawSize });
    if (raw.length !== rawSize) throw invalid();
    const decoded = decodePng(bytes);
    if (decoded.width !== 768 || decoded.height !== 576) throw invalid();
  } catch {
    throw invalid();
  }
}
export async function saveCatalogThumbnail(
  sql: Sql,
  storage: Storage,
  input: {
    packId: string;
    variantId: string;
    png: Uint8Array;
    actorId: string | null;
  },
): Promise<string> {
  validateThumbnailPng(input.png);
  const key = await withStaff(sql, async (tx) => {
    const [row] = await tx`select pk.key,pk.version from product_packs pk
      join products p on p.pack_id=pk.id join product_variants v on v.product_id=p.id
      where pk.id=${input.packId} and v.id=${input.variantId}`;
    if (!row) throw new ThumbnailError('not_found', 'No such product variant in this pack.');
    return `packs/${row['key']}/${row['version']}/catalog-thumbnails/${input.variantId}/${uuidv7()}.png`;
  });
  try {
    await storage.put(key, input.png, 'image/png');
    await withStaff(sql, async (tx) => {
      const [variant] =
        await tx`select v.id from product_variants v join products p on p.id=v.product_id
        where v.id=${input.variantId} and p.pack_id=${input.packId} for update of v`;
      if (!variant) throw new ThumbnailError('not_found', 'This product variant no longer exists.');
      await tx`insert into catalog_thumbnails(variant_id,storage_key) values (${input.variantId},${key})
        on conflict(variant_id) do update set storage_key=excluded.storage_key,updated_at=now()`;
      await recordAudit(tx, {
        orgId: null,
        actorUserId: input.actorId,
        action: 'catalog.thumbnail_captured',
        targetType: 'product_variant',
        targetId: input.variantId,
        metadata: { storageKey: key, source: 'web-viewer' },
      });
    });
  } catch (error) {
    await storage.delete(key);
    throw error;
  }
  return key;
}
