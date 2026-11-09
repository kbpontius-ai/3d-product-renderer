import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { parseStepHeader, schemaSupported, sniffFormat } from '@pr/cad';
import { listIngestions, submitIngestion } from '@pr/cad-jobs';
import { currentLog } from '@pr/observability';
import { assertSameOrigin } from '@/lib/server/auth';
import { requireStaff } from '@/lib/server/admin';
import { getSql } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { enforceLimit } from '@/lib/server/limits';
import { route } from '@/lib/server/observability';
import { getStorage } from '@/lib/server/storage';
import { PIPELINE_VERSION } from '@/lib/server/cad';

/**
 * CAD ingestion through the browser (F-ADM-01, F-GEN-02, docs/23-cad-ingestion.md).
 *
 * Staff only, and that is a decision rather than an oversight: this endpoint's job is to hand a
 * stranger's file to a large native parser, which is the most dangerous thing in the product.
 * Customer upload is its own project with its own review.
 *
 * Nothing is parsed here. The file is sniffed for what it actually is, refused if it is not
 * something an importer reads, written to a prefix no client can ever read back, and queued. The
 * parsing happens in a container with no network, which is where it belongs.
 */
export const runtime = 'nodejs';

/** Enough for a real assembly, bounded enough that the request cannot exhaust the web process. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

async function handleGet() {
  const principal = await requireStaff();
  const ctx = { orgId: principal.orgId, userId: principal.userId };
  return NextResponse.json({ jobs: await listIngestions(getSql(), ctx, 50) });
}

async function handlePost(request: Request) {
  assertSameOrigin(request);
  const principal = await requireStaff();
  await enforceLimit('cadUpload', principal.userId);

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'that file is too big');

  const fileName = sanitizeName(request.headers.get('x-file-name') ?? 'upload');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) throw new HttpError(422, 'invalid', 'the upload was empty');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'that file is too big');

  // By content, never by extension. The extension is a hint from whoever named the file.
  const sniffed = sniffFormat(bytes, fileName);
  if (!sniffed.format) {
    throw new HttpError(422, 'unsupported_format', 'that file is not a CAD format this platform reads');
  }

  // A STEP file that claims a protocol with no solids in it can be refused now, in a millisecond,
  // rather than after a minute of a kernel's time.
  if (sniffed.format === 'step') {
    const header = parseStepHeader(Buffer.from(bytes.subarray(0, 128 * 1024)).toString('latin1'));
    if (header.schemas.length > 0 && !schemaSupported(header)) {
      throw new HttpError(
        422,
        'unsupported_schema',
        `this file declares ${header.schemas[0]}, which is not an application protocol we import`,
      );
    }
  }

  const digest = createHash('sha256').update(bytes).digest();
  // Under cad-source/, which the asset route denies by name: source CAD never leaves the server.
  const sourceKey = `cad-source/${principal.orgId}/${digest.toString('hex').slice(0, 32)}-${fileName}`;
  await getStorage().put(sourceKey, bytes, 'application/octet-stream');

  // A QueueError from here — over quota, too many in flight — is shaped by `handleRouteError`,
  // which already knows the queue's vocabulary because the render queue speaks the same one.
  const { job, deduped } = await submitIngestion(
    getSql(),
    { orgId: principal.orgId, userId: principal.userId },
    {
      sourceKey,
      sourceName: fileName,
      sourceBytes: bytes.byteLength,
      sourceDigest: digest,
      format: sniffed.format,
      pipelineVersion: PIPELINE_VERSION,
      profile: profileFor(bytes.byteLength),
    },
  );

  currentLog().info('cad ingestion queued', {
    jobId: job.id,
    format: job.format,
    bytes: job.sourceBytes,
    deduped,
    extensionMismatch: sniffed.extensionMismatch,
  });

  return NextResponse.json(
    {
      job,
      deduped,
      sniffed: { format: sniffed.format, label: sniffed.label, extensionMismatch: sniffed.extensionMismatch },
    },
    { status: deduped ? 200 : 201 },
  );
}

/**
 * Which worker class this file will need, from the only thing knowable before parsing.
 *
 * Crude on purpose: size is a poor proxy for shape count, and the worker refuses what it cannot
 * handle anyway. What this buys is that a 200 MB assembly does not sit in the queue behind a
 * closure on a machine sized for closures.
 */
const profileFor = (bytes: number): 'standard' | 'heavy' => (bytes > 64 * 1024 * 1024 ? 'heavy' : 'standard');

/** A file name that is only ever a name: it becomes part of a storage key. */
function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'upload';
}

export const GET = route('admin/cad', handleGet);
export const POST = route('admin/cad', handlePost);
