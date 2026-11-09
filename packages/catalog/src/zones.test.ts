import { describe, expect, it } from 'vitest';
import { nextDraftVersion } from './import.js';
import { describeZoneEditError, ZoneEditError, zoneKeyFrom } from './zones.js';

describe('zoneKeyFrom', () => {
  it('makes a key from the name a person gave the zone', () => {
    expect(zoneKeyFrom('Top face', [])).toBe('top-face');
    expect(zoneKeyFrom('  Skirt — front (logo) ', [])).toBe('skirt-front-logo');
  });

  it('keeps two zones with the same name apart', () => {
    expect(zoneKeyFrom('Logo', ['logo'])).toBe('logo-2');
    expect(zoneKeyFrom('Logo', ['logo', 'logo-2'])).toBe('logo-3');
  });

  it('still makes a valid key from a name with nothing usable in it', () => {
    expect(zoneKeyFrom('★★★', [])).toBe('zone');
  });
});

describe('nextDraftVersion', () => {
  it('steps the minor version and resets the patch', () => {
    expect(nextDraftVersion('0.1.0')).toBe('0.2.0');
    expect(nextDraftVersion('1.4.7')).toBe('1.5.0');
    expect(nextDraftVersion('2.0.0-rc.1')).toBe('2.1.0');
  });

  it('skips versions that already exist', () => {
    expect(nextDraftVersion('0.1.0', ['0.1.0', '0.2.0', '0.3.0'])).toBe('0.4.0');
  });
});

describe('describeZoneEditError', () => {
  it('says what is wrong without the pack path an author never sees', () => {
    const error = new ZoneEditError('that change would make the pack invalid', [
      {
        severity: 'error',
        code: 'safe_margin_too_large',
        path: 'products.qa-ribbed-cap.89mm.top-logo',
        message: 'Safe margin 20 mm leaves no usable area in a 40 x 30 mm zone.',
      },
    ]);
    expect(describeZoneEditError(error)).toBe(
      'that change would make the pack invalid: Safe margin 20 mm leaves no usable area in a 40 x 30 mm zone.',
    );
  });

  it('keeps a field path, which does say something', () => {
    const error = new ZoneEditError('that zone is not complete', [
      { severity: 'error', code: 'schema_invalid', path: 'frame.tangent', message: 'Invalid input' },
    ]);
    expect(describeZoneEditError(error)).toBe('that zone is not complete: frame.tangent Invalid input');
  });
});
