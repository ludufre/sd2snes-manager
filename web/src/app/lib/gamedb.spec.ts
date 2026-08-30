import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { GameDb, resolveMatch, coverUrlsByBucket } from './gamedb.js';

const db = new GameDb('https://gamedb.test');

/** A game with three region cards, each with its own art, plus one ROM row. */
function game(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g1',
    title: 'Super Game',
    platform: 'snes',
    regions: [
      { id: 1, bucket: 'J', title: 'Super Game (J)', coverUrl: '/api/assets/j-cov/file', screenshotUrl: '/api/assets/j-shot/file' },
      { id: 2, bucket: 'U', title: 'Super Game (U)', coverUrl: '/api/assets/u-cov/file', screenshotUrl: '/api/assets/u-shot/file' },
      { id: 3, bucket: 'W', title: 'Super Game (W)', coverUrl: '/api/assets/w-cov/file', screenshotUrl: '/api/assets/w-shot/file' },
    ],
    assets: [
      { type: 'video', isActive: true, regionBucket: 'J', url: '/api/assets/j-vid/file' },
    ],
    manuals: [
      { uuid: 'm-j', groupUuid: 'gj', regionBucket: 'J', manualUrl: '/api/assets/j-man/file', sortOrder: 0 },
      { uuid: 'm-u', groupUuid: 'gu', regionBucket: 'U', manualUrl: '/api/assets/u-man/file', sortOrder: 0 },
    ],
    roms: [{ crc32: 'AABBCCDD', region: 'World', packageUrl: '/api/assets/pkg.s2pkg', packageBytes: 4242, metaRev: 'rev1' }],
    cheats: [],
    translations: [],
    ...overrides,
  };
}

describe('coverUrlsByBucket', () => {
  it('maps every bucket that has art, and only those', () => {
    expect(coverUrlsByBucket(db, game())).toEqual({
      J: 'https://gamedb.test/api/assets/j-cov/file',
      U: 'https://gamedb.test/api/assets/u-cov/file',
      W: 'https://gamedb.test/api/assets/w-cov/file',
    });
    const bare = game({ regions: [{ id: 1, bucket: 'J', title: 'x', coverUrl: null, screenshotUrl: null }] });
    expect(coverUrlsByBucket(db, bare)).toEqual({});
  });

  it('prefers the active cover asset over the region row url, like resolveMatch does', () => {
    const g = game({ assets: [{ type: 'cover', isActive: true, regionBucket: 'U', url: '/api/assets/u-active/file' }] });
    expect(coverUrlsByBucket(db, g)['U']).toBe('https://gamedb.test/api/assets/u-active/file');
  });
});

describe('resolveMatch: which covers this ROM may wear', () => {
  it('takes the region from the GameDB ROM row, not the file name', () => {
    // the file was renamed and lost its "(World)" tag: the row still knows.
    expect(resolveMatch(db, game(), 'USA', 'AABBCCDD').coverChoices).toEqual(['J', 'U', 'W']);
  });

  it('falls back to the file name when the row carries no region', () => {
    const g = game({ roms: [{ crc32: 'AABBCCDD', region: null }] });
    expect(resolveMatch(db, g, 'World', 'AABBCCDD').coverChoices).toEqual(['J', 'U', 'W']);
    expect(resolveMatch(db, g, 'Japan', 'AABBCCDD').coverChoices).toBeNull();
  });

  /* Super Metroid's real card: `(Japan, USA)` is two regions at once, and before this the cover was
     decided by the order the tests sit in inside bucketsOfRegion. */
  it('offers both regions of a multi-region dump', () => {
    const g = game({ roms: [{ crc32: 'AABBCCDD', region: 'Japan, USA' }] });
    const m = resolveMatch(db, g, 'Japan, USA', 'AABBCCDD');
    expect(m.coverChoices).toEqual(['J', 'U']);
    expect(m.bucket).toBe('J'); // the rest of the match still rides the region it always did
    expect(m.coverUrls).toMatchObject({ J: expect.any(String), U: expect.any(String) });
  });

  it('gives a single-region dump no choice at all', () => {
    const g = game({ roms: [{ crc32: 'AABBCCDD', region: 'Japan' }] });
    const m = resolveMatch(db, g, 'Japan', 'AABBCCDD');
    expect(m.coverChoices).toBeNull();
    // and nothing to move it with: a (Japan) cartridge must not end up under the USA box
    expect(m.coverUrls).toBeNull();
  });

  it('drops a choice the game has no art for', () => {
    const bare = game({
      regions: [{ id: 1, bucket: 'J', title: 'x', coverUrl: '/api/assets/j-cov/file', screenshotUrl: null }],
      roms: [{ crc32: 'AABBCCDD', region: 'Japan, USA' }],
    });
    expect(resolveMatch(db, bare, 'Japan, USA', 'AABBCCDD').coverChoices).toBeNull();
  });
});

/* The whole promise of the cover-region feature: it touches the cover and nothing else. Hoisting
   romRow and adding the World flag must leave every other field byte for byte as it was. */
describe('resolveMatch: nothing but the cover moved', () => {
  it('keeps bucket, title, screenshot, video, manuals and package as they were', () => {
    const m = resolveMatch(db, game(), 'Japan', 'AABBCCDD');
    expect(m.bucket).toBe('J');
    expect(m.title).toBe('Super Game (J)');
    expect(m.screenshotUrl).toBe('https://gamedb.test/api/assets/j-shot/file');
    expect(m.videoUrl).toBe('https://gamedb.test/api/assets/j-vid/file');
    expect(m.manuals.map((x: { uuid: string }) => x.uuid)).toEqual(['m-j']);
    expect(m.packageUrl).toBe('https://gamedb.test/api/assets/pkg.s2pkg');
    expect(m.packageBytes).toBe(4242);
    expect(m.metaRev).toBe('rev1');
    // the cover itself still resolves to the general bucket: the preference is applied later, in
    // core/cover-region.ts, never here.
    expect(m.coverUrl).toBe('https://gamedb.test/api/assets/j-cov/file');
  });

  it('resolves the package by CRC even when the ROM row is not the first', () => {
    const g = game({ roms: [{ crc32: '11111111', region: 'USA' }, { crc32: 'AABBCCDD', region: 'World', packageUrl: '/api/assets/pkg.s2pkg' }] });
    expect(resolveMatch(db, g, 'World', 'aabbccdd').packageUrl).toBe('https://gamedb.test/api/assets/pkg.s2pkg');
  });
});
