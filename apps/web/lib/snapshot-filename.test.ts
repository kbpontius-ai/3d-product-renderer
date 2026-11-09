import { describe, expect, it } from 'vitest';
import { snapshotFilename } from './snapshot-filename';

describe('snapshotFilename', () => {
  it('includes local capture time with padded date, time and milliseconds', () => {
    expect(snapshotFilename('My cap', new Date(2026, 0, 2, 3, 4, 5, 6)))
      .toBe('My-cap-snapshot-2026-01-02_03-04-05-006.png');
  });

  it('distinguishes captures within the same second', () => {
    const first = snapshotFilename('Cap', new Date(2026, 9, 23, 18, 34, 56, 789));
    const second = snapshotFilename('Cap', new Date(2026, 9, 23, 18, 34, 56, 790));
    expect(first).not.toBe(second);
    expect(second).toBe('Cap-snapshot-2026-10-23_18-34-56-790.png');
  });

  it('keeps names filesystem-safe and bounded, with a fallback for empty names', () => {
    const at = new Date(2026, 9, 23, 18, 34, 56, 789);
    expect(snapshotFilename(' ../My: cap? ', at)).toBe('My-cap-snapshot-2026-10-23_18-34-56-789.png');
    expect(snapshotFilename('???', at)).toBe('viewer-snapshot-2026-10-23_18-34-56-789.png');
    expect(snapshotFilename('x'.repeat(200), at)).toBe(`${'x'.repeat(80)}-snapshot-2026-10-23_18-34-56-789.png`);
  });
});
