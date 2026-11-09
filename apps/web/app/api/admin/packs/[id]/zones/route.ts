import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Key } from '@pr/design-schema';
import {
  addZone,
  describeZoneEditError,
  listPackZones,
  removeZone,
  updateZone,
  ZoneEditError,
  type ZonePatch,
} from '@pr/catalog';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';

/** Reading, adding, adjusting and removing a pack's zones (F-ADM-02, F-ADM-13). */
export const runtime = 'nodejs';

const FINISHES = ['emboss', 'deboss', 'print'] as const;
const NUMBERS: (keyof ZonePatch)[] = [
  'widthMm',
  'heightMm',
  'safeMarginMm',
  'maxDepthMm',
  'minStrokeMm',
  'maxCoverage',
  'wrapWarnDeg',
];

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  return NextResponse.json({ zones: await listPackZones(getSql(), id) });
}

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as Record<string, unknown>;
  const productKey = String(body['productKey'] ?? '');
  const variantKey = String(body['variantKey'] ?? '');
  const zoneKey = String(body['zoneKey'] ?? '');
  if (!productKey || !variantKey || !zoneKey) throw new HttpError(422, 'invalid', 'which zone?');

  const patch: ZonePatch = {};
  if (body['mapping'] !== undefined) {
    const mapping = z.enum(['planar', 'conformal']).safeParse(body['mapping']);
    if (!mapping.success)
      throw new HttpError(422, 'invalid', 'Choose Flat surface or Follow surface.');
    patch.mapping = mapping.data;
  }
  if (body['materialSlotKey'] !== undefined) {
    const parsed = z.union([Key, z.null()]).safeParse(body['materialSlotKey']);
    if (!parsed.success) throw new HttpError(422, 'invalid', 'Choose a valid artwork target part.');
    patch.materialSlotKey = parsed.data;
  }
  if (typeof body['name'] === 'string' && body['name'].trim())
    patch.name = body['name'].trim().slice(0, 120);
  for (const key of NUMBERS) {
    const value = body[key];
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new HttpError(422, 'invalid', `${key} must be a number`);
    (patch as Record<string, number>)[key] = parsed;
  }
  if (Array.isArray(body['finishes'])) {
    const finishes = body['finishes'].filter((value): value is (typeof FINISHES)[number] =>
      FINISHES.includes(value as (typeof FINISHES)[number]),
    );
    if (finishes.length === 0)
      throw new HttpError(422, 'invalid', 'a zone needs at least one finish');
    patch.finishes = finishes;
  }
  // Checked whole by the schema in the catalog, against the zone's own type.
  if (body['frame'] !== undefined) {
    if (typeof body['frame'] !== 'object' || body['frame'] === null) {
      throw new HttpError(422, 'invalid', 'frame must be an object');
    }
    patch.frame = body['frame'];
  }
  if (Object.keys(patch).length === 0) throw new HttpError(422, 'invalid', 'nothing to change');

  try {
    const zones = await updateZone(
      getSql(),
      { packId: id, productKey, variantKey, zoneKey },
      patch,
      principal.userId,
    );
    return NextResponse.json({ zones });
  } catch (error) {
    throw asHttpError(error);
  }
}

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const body = (await request.json()) as Record<string, unknown>;
  const productKey = String(body['productKey'] ?? '');
  const variantKey = String(body['variantKey'] ?? '');
  const zone = body['zone'];
  if (!productKey || !variantKey) throw new HttpError(422, 'invalid', 'which variant?');
  if (!zone || typeof zone !== 'object') throw new HttpError(422, 'invalid', 'no zone to add');

  try {
    const key = await addZone(
      getSql(),
      { packId: id, productKey, variantKey },
      zone as Record<string, unknown>,
      principal.userId,
    );
    return NextResponse.json({ key, zones: await listPackZones(getSql(), id) }, { status: 201 });
  } catch (error) {
    throw asHttpError(error);
  }
}

async function handleDelete(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  const { id } = await params;

  const query = new URL(request.url).searchParams;
  const productKey = query.get('productKey') ?? '';
  const variantKey = query.get('variantKey') ?? '';
  const zoneKey = query.get('zoneKey') ?? '';
  if (!productKey || !variantKey || !zoneKey) throw new HttpError(422, 'invalid', 'which zone?');

  try {
    await removeZone(getSql(), { packId: id, productKey, variantKey, zoneKey }, principal.userId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    throw asHttpError(error);
  }
}

function asHttpError(error: unknown): unknown {
  if (!(error instanceof ZoneEditError)) return error;
  if (error.code === 'not_found') return new HttpError(404, 'not_found', error.message);
  if (error.code === 'not_draft' || error.code === 'in_use')
    return new HttpError(409, 'conflict', error.message);
  return new HttpError(422, 'zone_invalid', describeZoneEditError(error));
}

export const GET = route('admin/packs/:id/zones', handleGet);
export const PATCH = route('admin/packs/:id/zones', handlePatch);
export const POST = route('admin/packs/:id/zones', handlePost);
export const DELETE = route('admin/packs/:id/zones', handleDelete);
