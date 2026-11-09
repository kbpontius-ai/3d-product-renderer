import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ingestArtwork } from '@pr/artworks';
import { getVariant } from '@pr/catalog';
import { createDesign } from '@pr/designs';
import { initialTransform, testPatternSvg } from '@pr/placement';
import { zoneExtentMm, type FinishKind, type Placement } from '@pr/design-schema';
import { currentLog } from '@pr/observability';
import { assertSameOrigin, requireTenant } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';

/**
 * Checking a zone with the test pattern (F-ADM-02).
 *
 * This does not draw its own preview. It makes a real design, on the real variant, with the test
 * pattern placed in the zone through the real artwork pipeline, and hands back its id — so the
 * operator verifies the zone in the editor customers use, and can render it if the preview leaves
 * any doubt.
 *
 * A zone that is upside down, mirrored, or stretched shows up immediately: the pattern's arrow
 * points one way and its four corner marks are four different shapes.
 */
export const runtime = 'nodejs';

async function handlePost(request: Request) {
  assertSameOrigin(request);
  await requireStaff();
  // The design belongs to the staff member's own organisation: it is scratch work, and it should
  // land where they can find it and delete it, not in a customer's list.
  const ctx = await requireTenant();

  const body = (await request.json()) as { variantId?: string; zoneKey?: string };
  if (!body.variantId || !body.zoneKey) throw new HttpError(422, 'invalid', 'a variant and a zone are needed');

  const sql = getSql();
  const variant = await getVariant(sql, ctx, body.variantId);
  if (!variant) throw new HttpError(404, 'not_found', 'no such variant');

  const zone = variant.zones.find((candidate) => candidate.key === body.zoneKey);
  if (!zone) throw new HttpError(404, 'not_found', 'no such zone on that variant');

  const extent = zoneExtentMm(zone);
  const ingest = await ingestArtwork(sql, getStorage(), ctx, {
    name: `Zone check — ${zone.name}`,
    source: testPatternSvg({ widthMm: extent.w, heightMm: extent.h }),
  });
  if (ingest.status !== 'ready' || !ingest.artwork) {
    throw new HttpError(500, 'pattern_rejected', 'the test pattern did not survive the artwork pipeline');
  }

  const inkKey = variant.materialSlots[0]?.defaultMaterialKey ?? 'ink-black';
  // Created with the pattern already placed, so a refused placement leaves nothing behind.
  const design = await createDesign(sql, ctx, {
    variantId: body.variantId,
    name: `Zone check — ${variant.name} / ${zone.name}`,
    placements: [
      {
        id: randomUUID(),
        zoneKey: zone.key,
        artwork: { artworkId: ingest.artwork.artworkId, versionId: ingest.artwork.versionId },
        // Contained in the safe area, which is also the claim being checked: if the pattern's
        // border sits outside the printable region on the mesh, the margin is wrong.
        transform: initialTransform(ingest.artwork.naturalSizeMm, extent),
        finish: patternFinish(zone.constraints.finishes[0] ?? 'deboss', zone.constraints.maxDepthMm, inkKey),
        order: 0,
      },
    ],
  });

  currentLog().info('zone check created', { variantId: body.variantId, zoneKey: zone.key, designId: design.id });
  return NextResponse.json({ designId: design.id }, { status: 201 });
}

/**
 * The finish the pattern is shown in: the zone's first allowed one.
 *
 * Built per kind because the kinds are different shapes — a print has an opacity and no depth — and
 * a single literal for both used to produce a "print" the schema refused, so the check never worked
 * on a print-only zone.
 */
function patternFinish(kind: FinishKind, maxDepthMm: number, inkMaterialKey: string): Placement['finish'] {
  if (kind === 'print') return { kind: 'print', inkMaterialKey, opacity: 1 };
  return { kind, depthMm: Math.min(0.3, maxDepthMm), bevelDeg: 30, edgeRadiusMm: 0.05, inkMaterialKey };
}

export const POST = route('admin/zone-check', handlePost);
