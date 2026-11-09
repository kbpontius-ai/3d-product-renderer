import 'server-only';
import { ArtworkPreparationRequest } from '@pr/design-schema';
import { DEFAULT_MAX_BYTES } from '@pr/svg';
import { HttpError } from './http';

export async function readArtworkPreparationRequest(
  request: Request,
): Promise<ArtworkPreparationRequest> {
  const limit = 8 * 1024 * 1024;
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new HttpError(
      413,
      'too_large',
      'The preparation request exceeds 8 MB. Export a simpler SVG.',
    );
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(422, 'invalid', 'A preparation request is required.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'too_large', 'The preparation request exceeds 8 MB.');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(422, 'invalid', 'The preparation request must be valid UTF-8 JSON.');
  }
  const parsed = ArtworkPreparationRequest.safeParse(body);
  if (!parsed.success)
    throw new HttpError(
      422,
      'invalid',
      'Check the source, expected version, name, and selection recipe.',
    );
  if (
    parsed.data.source !== undefined &&
    Buffer.byteLength(parsed.data.source, 'utf8') > DEFAULT_MAX_BYTES
  )
    throw new HttpError(413, 'too_large', 'The SVG exceeds the 5 MB limit.');
  return parsed.data;
}
