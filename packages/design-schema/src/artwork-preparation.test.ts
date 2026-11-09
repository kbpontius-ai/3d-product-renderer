import { describe, expect, it } from 'vitest';
import {
  ArtworkPreparationRecipe,
  ArtworkPreparationRequest,
  canonicalArtworkPreparationRecipe,
} from './artwork-preparation.js';

const recipe = {
  sourceDigest: 'a'.repeat(64),
  analyzerVersion: '1',
  selected: [{ objectId: 'o1', paint: 'both' }],
  repairs: [],
  acknowledged: [],
  transforms: [],
};

describe('artwork preparation intake boundary', () => {
  it('rejects duplicate inclusion and unbounded geometry operations', () => {
    expect(
      ArtworkPreparationRecipe.safeParse({
        ...recipe,
        selected: [...recipe.selected, ...recipe.selected],
      }).success,
    ).toBe(false);
    expect(
      ArtworkPreparationRecipe.safeParse({
        ...recipe,
        repairs: [{ kind: 'stroke-width', objectId: 'o1', widthMm: Infinity }],
      }).success,
    ).toBe(false);
    expect(
      ArtworkPreparationRecipe.safeParse({ ...recipe, repairs: [{ kind: 'close-all' }] }).success,
    ).toBe(false);
    expect(
      ArtworkPreparationRecipe.safeParse({
        ...recipe,
        repairs: Array.from({ length: 201 }, () => ({
          kind: 'close',
          objectId: 'o1',
          subpathId: 'o1:s0',
        })),
      }).success,
    ).toBe(false);
  });
  it('requires a source and protects existing artwork updates with an expected version', () => {
    const artworkId = '11111111-1111-4111-8111-111111111111';
    expect(ArtworkPreparationRequest.safeParse({ source: '<svg/>', recipe }).success).toBe(true);
    expect(ArtworkPreparationRequest.safeParse({ artworkId }).success).toBe(false);
    expect(ArtworkPreparationRequest.safeParse({ artworkId, versionId: artworkId }).success).toBe(
      true,
    );
    expect(
      ArtworkPreparationRequest.safeParse({ artworkId, versionId: artworkId, source: '<svg/>' })
        .success,
    ).toBe(true);
    expect(ArtworkPreparationRequest.safeParse({}).success).toBe(false);
    expect(
      ArtworkPreparationRequest.safeParse({ source: '<svg/>', derivedSvg: '<svg/>' }).success,
    ).toBe(false);
  });
  it('canonicalizes set-like choices without reordering repairs or changing the draft', () => {
    const draft = ArtworkPreparationRecipe.parse({
      ...recipe,
      selected: [{ objectId: 'o2', paint: 'stroke' }, ...recipe.selected],
      acknowledged: ['b', 'a', 'b'],
      repairs: [
        { kind: 'stroke-width', objectId: 'o1', widthMm: 1 },
        { kind: 'close', objectId: 'o1', subpathId: 'o1:s0' },
      ],
    });
    const result = canonicalArtworkPreparationRecipe(draft);
    expect(result.selected.map((item) => item.objectId)).toEqual(['o1', 'o2']);
    expect(result.acknowledged).toEqual(['a', 'b']);
    expect(result.repairs).toEqual(draft.repairs);
    expect(draft.selected[0]!.objectId).toBe('o2');
    expect(draft.acknowledged).toEqual(['b', 'a', 'b']);
  });
});
