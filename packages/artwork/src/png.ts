import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal grayscale PNG writer for the artwork pipeline's derived assets: 8-bit coverage masks and
 * 16-bit distance/height fields. Deliberately tiny — the pipeline only ever writes single-channel
 * images, and depending on an image library for that would be a larger attack surface than the
 * format deserves.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function ihdr(width: number, height: number, bitDepth: 8 | 16, colourType = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(bitDepth, 8);
  data.writeUInt8(colourType, 9); // 0 greyscale, 6 RGBA
  data.writeUInt8(0, 10); // deflate
  data.writeUInt8(0, 11); // adaptive filtering
  data.writeUInt8(0, 12); // no interlace
  return chunk('IHDR', data);
}

/** Optional textual metadata (mm-per-pixel, encode range) travelling with the asset. */
function tEXt(key: string, value: string): Buffer {
  return chunk(
    'tEXt',
    Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]),
  );
}

export interface PngTextEntry {
  key: string;
  value: string;
}

export function encodeGray8Png(
  data: Uint8Array,
  width: number,
  height: number,
  text: PngTextEntry[] = [],
): Buffer {
  assertSize(data.length, width * height);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width + 1);
    raw[offset] = 0; // filter: none
    for (let x = 0; x < width; x++) raw[offset + 1 + x] = data[y * width + x]!;
  }
  return assemble(width, height, 8, raw, text);
}

export function encodeGray16Png(
  data: Uint16Array,
  width: number,
  height: number,
  text: PngTextEntry[] = [],
): Buffer {
  assertSize(data.length, width * height);
  const rowBytes = width * 2;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (rowBytes + 1);
    raw[offset] = 0;
    for (let x = 0; x < width; x++) {
      raw.writeUInt16BE(data[y * width + x]!, offset + 1 + x * 2); // PNG samples are big-endian
    }
  }
  return assemble(width, height, 16, raw, text);
}

function assemble(
  width: number,
  height: number,
  bitDepth: 8 | 16,
  raw: Buffer,
  text: PngTextEntry[],
  colourType = 0,
): Buffer {
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, bitDepth, colourType),
    ...text.map((t) => tEXt(t.key, t.value)),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 8-bit RGBA, for the one thing the pipeline reads rather than writes: comparing what a renderer
 * produced. Everything derived from artwork is single-channel, so this stays out of that path.
 */
export function encodeRgbaPng(
  rgba: Uint8Array,
  width: number,
  height: number,
  text: PngTextEntry[] = [],
): Buffer {
  assertSize(rgba.length, width * height * 4);
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (rowBytes + 1);
    raw[offset] = 0; // filter: none
    for (let i = 0; i < rowBytes; i++) raw[offset + 1 + i] = rgba[y * rowBytes + i]!;
  }
  return assemble(width, height, 8, raw, text, 6);
}

/**
 * Area-averaged downscale of 8-bit RGBA.
 *
 * For making a web-sized copy of a render (F-EXP-01). Averaging over the source area each output
 * pixel covers, rather than sampling one of them: a 4096 px render sampled down to 1024 aliases the
 * edge of every letter into a staircase, and a logo's edges are the thing a customer is checking.
 *
 * Only ever downwards. Enlarging is a different problem with different right answers, and nothing
 * here needs it, so asking for a larger size returns the source rather than inventing detail.
 */
export function downscaleRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxSidePx: number,
): { rgba: Uint8Array; width: number; height: number } {
  assertSize(rgba.length, width * height * 4);

  const longest = Math.max(width, height);
  if (longest <= maxSidePx || maxSidePx < 1) return { rgba, width, height };

  const scale = maxSidePx / longest;
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outWidth * outHeight * 4);

  for (let y = 0; y < outHeight; y++) {
    // Source bounds as real numbers first, then rounded outwards, so no source row is skipped
    // between two output rows and none is counted twice.
    const y0 = Math.floor((y * height) / outHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outHeight));

    for (let x = 0; x < outWidth; x++) {
      const x0 = Math.floor((x * width) / outWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outWidth));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;

      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += rgba[i]!;
          g += rgba[i + 1]!;
          b += rgba[i + 2]!;
          a += rgba[i + 3]!;
          n++;
        }
      }

      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }

  return { rgba: out, width: outWidth, height: outHeight };
}

function assertSize(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`pixel buffer has ${actual} samples, expected ${expected}`);
  }
}

export const PNG_SIGNATURE = SIGNATURE;

// --- reading ------------------------------------------------------------------------------------

export interface DecodedPng {
  data: Uint8Array | Uint16Array;
  width: number;
  height: number;
  bitDepth: 8 | 16;
  /** 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. Samples are interleaved in `data`. */
  channels: 1 | 2 | 3 | 4;
  /** tEXt entries, so an asset still carries its millimetre scale when it is read back. */
  text: Record<string, string>;
}

export type DecodedGrayPng = DecodedPng & { channels: 1 };

const CHANNELS_FOR_COLOUR_TYPE: Record<number, 1 | 2 | 3 | 4> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Reads a non-interlaced PNG: greyscale or colour, 8 or 16 bit, all five filter types.
 *
 * The worker turns a stored distance field into a height map, which means decoding one; the tests
 * check what a renderer actually produced, which means decoding colour. The filters are implemented
 * in full rather than only the one the encoder emits, because a PNG that arrives from anywhere else
 * is still a PNG.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth: 8 | 16 = 8;
  let channels: 1 | 2 | 3 | 4 = 1;
  const text: Record<string, string> = {};
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data.readUInt8(8);
      const colourType = data.readUInt8(9);
      const found = CHANNELS_FOR_COLOUR_TYPE[colourType];
      if (!found) throw new Error(`unsupported colour type ${colourType}`);
      if (data.readUInt8(12) !== 0) throw new Error('interlaced PNGs are not supported');
      if (depth !== 8 && depth !== 16) throw new Error(`unsupported bit depth ${depth}`);
      bitDepth = depth;
      channels = found;
    } else if (type === 'tEXt') {
      const split = data.indexOf(0);
      text[data.toString('latin1', 0, split)] = data.toString('latin1', split + 1);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width === 0 || height === 0) throw new Error('PNG has no image header');

  const bytesPerPixel = (bitDepth === 16 ? 2 : 1) * channels;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const target = out.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? target[i - bytesPerPixel]! : 0;
      const up = above ? above[i]! : 0;
      const upLeft = above && i >= bytesPerPixel ? above[i - bytesPerPixel]! : 0;
      const x = line[i]!;

      target[i] =
        filter === 0
          ? x
          : filter === 1
            ? (x + left) & 0xff
            : filter === 2
              ? (x + up) & 0xff
              : filter === 3
                ? (x + ((left + up) >> 1)) & 0xff
                : (x + paeth(left, up, upLeft)) & 0xff;
    }
  }

  if (bitDepth === 8) return { data: new Uint8Array(out), width, height, bitDepth, channels, text };

  const samples = new Uint16Array(width * height * channels);
  for (let i = 0; i < samples.length; i++) samples[i] = out.readUInt16BE(i * 2);
  return { data: samples, width, height, bitDepth, channels, text };
}

/** The single-channel case, refused rather than silently averaged when the PNG has colour. */
export function decodeGrayPng(bytes: Uint8Array): DecodedGrayPng {
  const decoded = decodePng(bytes);
  if (decoded.channels !== 1) throw new Error('expected a greyscale PNG');
  return decoded as DecodedGrayPng;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
