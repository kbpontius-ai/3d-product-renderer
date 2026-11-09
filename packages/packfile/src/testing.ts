import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Building a zip, for tests.
 *
 * Assembled byte by byte rather than with a library so the reader is exercised against the format
 * itself — and so the end-to-end suite can upload a real archive without a fixture file that would
 * drift away from the pack it is supposed to contain.
 */

export interface ZipInput {
  path: string;
  bytes: Uint8Array;
  /** Store uncompressed. Deflate is the default, as every zip tool would produce. */
  store?: boolean;
}

export function makeZip(files: ZipInput[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const raw = Buffer.from(file.bytes);
    const compressed = file.store ? raw : deflateRawSync(raw);
    const method = file.store ? 0 : 8;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + compressed.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);

  return new Uint8Array(Buffer.concat([body, directory, end]));
}
