import { NextResponse } from 'next/server';
import { ObjectNotFound } from '@pr/storage';
import { requireTenant } from '@/lib/server/auth';
import { handleRouteError } from '@/lib/server/http';
import { route } from '@/lib/server/observability';
import { assetSignatureValid, isDeniedAsset, isSharedAsset, readAsset } from '@/lib/server/storage';
import { currentLog } from '@pr/observability';
import { recordAudit, withTenant } from '@pr/db';
import { getSql } from '@/lib/server/db';

/**
 * Assets, by storage key.
 *
 * Behind the session, and behind the tenant: every key a tenant owns names the owning organisation
 * in its second segment — `artwork/{orgId}/…`, `renders/{orgId}/…`, `designs/{orgId}/…` — so
 * serving it is a comparison rather than a lookup.
 *
 * The list below is of what is *shared*, not of what is protected, and that direction matters. It
 * used to be the other way round: one prefix was checked and everything else was served to any
 * signed-in account, which meant another organisation's finished renders and dashboard thumbnails
 * were readable by key. Unguessable identifiers were the only thing standing in the way, and an
 * identifier is not an access control. Written this way, a prefix nobody remembered to classify is
 * refused rather than exposed.
 *
 * Production issues short-lived signed URLs from object storage instead of proxying bytes.
 */

async function handleGet(request: Request, context: { params: Promise<{ key: string[] }> }) {
  try {
    const ctx = await requireTenant();
    const { key } = await context.params;
    const storageKey = key.join('/');

    // Some things are not served to anybody: source CAD, whoever is asking and however well signed
    // the link is (F-PLAT-04). Checked first, so no later rule can accidentally permit it.
    if (isDeniedAsset(storageKey)) {
      currentLog().warn('asset refused by prefix', { key: storageKey });
      return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
    }

    // 404 rather than 403 throughout: whether another organisation has an asset at this key is
    // itself something they are not entitled to learn.
    if (!isSharedAsset(storageKey)) {
      if (key[1] !== ctx.orgId) {
        return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
      }

      // And the signature the URL was issued with (F-PLAT-04). The two checks answer different
      // questions: the one above is whether this organisation owns the asset, this one is whether
      // this person was given this URL and whether it is still good.
      const url = new URL(request.url);
      const signed = assetSignatureValid(storageKey, ctx.userId ?? ctx.orgId, {
        expiresAt: Number(url.searchParams.get('e')),
        signature: url.searchParams.get('s') ?? '',
      });

      if (!signed) {
        currentLog().warn('asset url rejected', { key: storageKey });
        return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
      }
    }

    const asset = await readAsset(key);
    await recordDownload(ctx, storageKey);
    return new NextResponse(asset.bytes as BodyInit, {
      headers: {
        'content-type': asset.contentType,
        // Thumbnails overwrite one key; versioned artwork and render assets remain immutable.
        'cache-control': key[0] === 'designs' && key.at(-1) === 'thumb.png'
          ? 'private, no-store'
          : 'private, max-age=31536000, immutable',
        // But these are private per tenant: without this, a second person signing in on the same
        // browser would be served the first one's artwork out of the cache, never reaching the
        // check above.
        vary: 'Cookie',
      },
    });
  } catch (error) {
    if (error instanceof ObjectNotFound || (error instanceof Error && /invalid storage key/.test(error.message))) {
      return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
    }
    return handleRouteError(error);
  }
}

/**
 * Records that somebody took a render away (docs/05-security.md: audit covering asset-access).
 *
 * Only the full-resolution original of a render, and deliberately not every asset read. A gallery
 * page fetches a thumbnail per tile and the editor fetches a mesh and half a dozen textures for one
 * product; auditing those would write thousands of rows a day that nobody will ever read, and an
 * audit log nobody reads is not an audit log. The event worth keeping is the one where the artefact
 * left: the file a customer downloads is the file that ends up with their printer.
 *
 * Failure here never fails the download. The alternative is refusing to hand over a render because
 * a log write did not go through, which trades a real capability for a record of nothing happening.
 */
async function recordDownload(ctx: { orgId: string; userId: string | null }, storageKey: string) {
  if (!storageKey.startsWith('renders/') || storageKey.endsWith('.web.png')) return;

  try {
    await withTenant(getSql(), ctx, (tx) =>
      recordAudit(tx, {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: 'asset.downloaded',
        targetType: 'render_output',
        targetId: storageKey,
      }),
    );
  } catch (error) {
    currentLog().warn('could not record an asset download', { key: storageKey, error: String(error) });
  }
}

export const GET = route('assets/:key', handleGet);
