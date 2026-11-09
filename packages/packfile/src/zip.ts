import { inflateRawSync } from 'node:zlib';

/**
 * Reading a zip archive.
 *
 * A Product Pack that arrives over HTTP is a manifest plus its meshes and textures, and the format
 * everyone already has a way to make is a zip. This reads one — from the central directory rather
 * than by scanning for local headers, because the central directory is the authoritative index and
 * a scanner can be fooled by bytes that merely look like a header.
 *
 * Deliberately small: store and deflate only (what every zip tool produces), no encryption, no
 * zip64, and paths are checked rather than trusted. It is fed by strangers.
 */

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/** Total uncompressed bytes we will produce, however small the archive claims to be. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export function readZip(input: Uint8Array, maxTotalBytes = MAX_TOTAL_BYTES): ZipEntry[] {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const end = findEndOfCentralDirectory(buffer);

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let total = 0;

  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError('the archive index is damaged');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const path = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    // Directory entries carry no data; they are implied by the paths of the files inside them.
    if (path.endsWith('/')) continue;

    total += uncompressedSize;
    if (total > maxTotalBytes) throw new ZipError('the archive expands to more than we will accept');

    entries.push({
      path: safePath(path),
      bytes: readEntry(buffer, localOffset, method, compressedSize, uncompressedSize),
    });
  }

  return entries;
}

function readEntry(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    throw new ZipError('an entry points outside the archive');
  }

  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const slice = buffer.subarray(start, start + compressedSize);
  if (slice.length !== compressedSize) throw new ZipError('an entry is truncated');

  if (method === 0) return new Uint8Array(slice);
  if (method !== 8) throw new ZipError(`unsupported compression method ${method}`);

  // maxOutputLength is the defence against a zip bomb: a few kilobytes claiming to be a few
  // gigabytes stop at the declared size instead of taking the process with them.
  const inflated = inflateRawSync(slice, { maxOutputLength: Math.max(uncompressedSize, 1) });
  return new Uint8Array(inflated);
}

/**
 * A path that cannot escape wherever it is being written.
 *
 * `../` in an archive is the oldest trick there is, and the pack importer turns these into storage
 * keys — so they are rejected rather than sanitised: a pack containing one is not a pack anyone
 * should be importing.
 */
function safePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '..') ||
    /^[a-zA-Z]:/.test(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ZipError(`refusing the path "${path}"`);
  }
  return normalized;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record sits at the end, after a comment of up to 64 KiB, so it is searched for backwards.
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= earliest; at--) {
    if (buffer.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new ZipError('this is not a zip archive');
}
