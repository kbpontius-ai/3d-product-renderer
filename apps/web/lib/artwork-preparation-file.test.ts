import { describe, expect, it } from 'vitest';
import { readPreparationFile } from './artwork-preparation-file';

describe('preparation file intake', () => {
  it('retains exact UTF-8 bytes including a BOM for recoverable originals', async () => {
    const source = '\ufeff<svg><title>Geometric ★</title></svg>';
    const result = await readPreparationFile(
      new File([source], 'Geometric.svg', { type: 'image/svg+xml' }),
    );
    expect(result).toEqual({ name: 'Geometric', source });
    expect(new TextEncoder().encode(result.source)).toEqual(new TextEncoder().encode(source));
  });
  it('refuses invalid encoding rather than silently replacing source characters', async () => {
    await expect(
      readPreparationFile(new File([new Uint8Array([0xff, 0xfe])], 'mark.svg')),
    ).rejects.toThrow('not UTF-8');
  });
  it('refuses oversized intake and normalizes the label without changing markup', async () => {
    await expect(
      readPreparationFile(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.svg')),
    ).rejects.toThrow('5 MB');
    expect(await readPreparationFile(new File(['<svg/>'], '\u0000.svg'))).toEqual({
      name: 'Artwork',
      source: '<svg/>',
    });
  });
});
