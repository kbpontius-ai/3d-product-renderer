import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readPackArchive } from './archive.js';
import { makeZip as zip } from './testing.js';
import { readZip, ZipError } from './zip.js';

/**
 * Reading a pack someone uploaded.
 *
 * The archives here are built byte by byte rather than by a library, so the reader is tested
 * against the format rather than against whatever a helper happens to produce — including the
 * archives nobody should accept.
 */

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../fixtures/packs/cap-basic/manifest.json', import.meta.url)), 'utf8'),
) as { products: { variants: { assets: Record<string, { path: string }> }[] }[] };

const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf8'));
const declared = (): string[] =>
  manifest.products.flatMap((product) =>
    product.variants.flatMap((variant) => Object.values(variant.assets).map((asset) => asset.path)),
  );

describe('readZip', () => {
  it('reads deflated and stored entries alike', () => {
    const entries = readZip(
      zip([
        { path: 'a.txt', bytes: text('hello '.repeat(50)) },
        { path: 'b.bin', bytes: text('stored'), store: true },
      ]),
    );

    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'b.bin']);
    expect(Buffer.from(entries[0]!.bytes).toString()).toBe('hello '.repeat(50));
    expect(Buffer.from(entries[1]!.bytes).toString()).toBe('stored');
  });

  it('refuses a path that would escape where it is written', () => {
    expect(() => readZip(zip([{ path: '../escape.txt', bytes: text('no') }]))).toThrow(ZipError);
    expect(() => readZip(zip([{ path: '/absolute.txt', bytes: text('no') }]))).toThrow(ZipError);
  });

  it('refuses something that is not a zip at all', () => {
    expect(() => readZip(text('PK not really'))).toThrow(/not a zip/);
  });
});

describe('readPackArchive', () => {
  const packFiles = () => [
    { path: 'manifest.json', bytes: text(JSON.stringify(manifest)) },
    ...declared().map((path) => ({ path, bytes: text(`fake ${path}`) })),
  ];

  it('reads a pack the importer can then take', () => {
    const archive = readPackArchive(zip(packFiles()));

    expect(archive.publishable).toBe(true);
    expect(archive.manifest?.key).toBe('cap-basic');
    expect(archive.missing).toEqual([]);
    expect(archive.files.get('manifest.json')).toBeDefined();
  });

  it('accepts the folder a zip tool wraps everything in', () => {
    const archive = readPackArchive(
      zip(packFiles().map((file) => ({ ...file, path: `cap-basic/${file.path}` }))),
    );

    expect(archive.publishable).toBe(true);
    expect(archive.missing).toEqual([]);
  });

  it('says which declared files are absent, before anything is imported', () => {
    const [, ...withoutOneAsset] = packFiles();
    const archive = readPackArchive(
      zip([{ path: 'manifest.json', bytes: text(JSON.stringify(manifest)) }, ...withoutOneAsset.slice(1)]),
    );

    expect(archive.missing.length).toBeGreaterThan(0);
  });

  it('lists files nothing refers to, which is usually a typo in a path', () => {
    const archive = readPackArchive(zip([...packFiles(), { path: 'notes.txt', bytes: text('hi') }]));

    expect(archive.unused).toContain('notes.txt');
  });

  it('ignores the noise archive tools add', () => {
    const archive = readPackArchive(
      zip([...packFiles(), { path: '__MACOSX/._manifest.json', bytes: text('junk') }]),
    );

    expect(archive.unused).toEqual([]);
  });

  it('refuses an archive with no manifest', () => {
    expect(() => readPackArchive(zip([{ path: 'mesh.glb', bytes: text('x') }]))).toThrow(/no manifest/);
  });

  it('refuses a manifest that is not JSON', () => {
    expect(() => readPackArchive(zip([{ path: 'manifest.json', bytes: text('{oops') }]))).toThrow(
      /not valid JSON/,
    );
  });

  it('reports a manifest that is JSON but not a pack, rather than throwing', () => {
    const archive = readPackArchive(zip([{ path: 'manifest.json', bytes: text('{"key":"x"}') }]));

    expect(archive.publishable).toBe(false);
    expect(archive.issues.length).toBeGreaterThan(0);
  });
});
