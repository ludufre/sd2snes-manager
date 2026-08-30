import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { bucketsOfRegion, pickBucket, coverChoicesFor, pickCoverBucket, COVER_REGION_CHOICES, REGION_ORDER } from './regions.js';

/* The cover-region preference is built on the promise that nothing but the cover moves, and that
   promise rests on these two staying exactly as they are. Pinned here on purpose: a well-meaning
   tweak to the fallback order would silently re-point titles, screenshots and manuals on every card
   that has ever been filled. */
describe('bucketsOfRegion / pickBucket (unchanged behaviour)', () => {
  it('maps a No-Intro region string to its buckets', () => {
    expect(bucketsOfRegion('World')).toEqual(['W']);
    expect(bucketsOfRegion('USA')).toEqual(['U']);
    expect(bucketsOfRegion('USA, Europe')).toEqual(['U', 'E']);
    expect(bucketsOfRegion('Japan')).toEqual(['J']);
    expect(bucketsOfRegion('Brazil')).toEqual(['U']);
    expect(bucketsOfRegion('Unknown Land')).toEqual(['O']);
    expect(bucketsOfRegion(null)).toEqual(['O']);
  });

  it('prefers a bucket the game has, then falls back through REGION_ORDER', () => {
    expect(REGION_ORDER).toEqual(['U', 'E', 'J', 'W', 'O']);
    expect(pickBucket('World', ['W', 'U'])).toBe('W');
    // the whole complaint: a World dump whose game has no World card lands wherever the fixed order
    // happens to point, which is why the preference exists.
    expect(pickBucket('World', ['J', 'U'])).toBe('U');
    expect(pickBucket('World', ['J'])).toBe('J');
    expect(pickBucket(null, ['J', 'E'])).toBe('E');
    expect(pickBucket('World', [])).toBeNull();
  });
});

describe('coverChoicesFor', () => {
  // Super Metroid, a real GameDB card: three regions with art, four dumps, two of them multi-region.
  const cards = ['J', 'U', 'E'];

  it('offers every region a multi-region dump legitimately claims', () => {
    // the ordering inside bucketsOfRegion (Japan before USA) used to decide this on its own
    expect(coverChoicesFor('Japan, USA', cards)).toEqual(['J', 'U']);
    expect(coverChoicesFor('USA, Europe', cards)).toEqual(['U', 'E']);
  });

  it('offers nothing to choose for a single-region dump', () => {
    // one entry = no choice. A (Japan) cartridge must never end up under the USA box.
    expect(coverChoicesFor('Japan', cards)).toEqual(['J']);
    expect(coverChoicesFor('Europe', cards)).toEqual(['E']);
  });

  it('lets a World dump wear any region, since it stands for all of them', () => {
    expect(coverChoicesFor('World', cards)).toEqual(['J', 'U', 'E']);
    expect(coverChoicesFor('World', ['U', 'W'])).toEqual(['U', 'W']);
  });

  it('keeps only regions the game actually has art for', () => {
    expect(coverChoicesFor('Japan, USA', ['J'])).toEqual(['J']);
    expect(coverChoicesFor('Japan, USA', [])).toEqual([]);
  });

  it('gives an untagged ROM nothing to choose', () => {
    // no region in the name resolves to 'O', which no game is ever fanned out into
    expect(coverChoicesFor(null, cards)).toEqual([]);
  });
});

describe('pickCoverBucket', () => {
  it('applies a preference the ROM may legitimately wear', () => {
    expect(pickCoverBucket('J', ['J', 'U'], 'U')).toBe('U');
    expect(pickCoverBucket('U', ['U', 'E'], 'E')).toBe('E');
  });

  it('leaves the general bucket alone when the preference does not apply', () => {
    // (Japan, USA) with a European preference: the ROM is not a European dump
    expect(pickCoverBucket('J', ['J', 'U'], 'E')).toBe('J');
    // a single-region dump has nothing to swap to
    expect(pickCoverBucket('J', ['J'], 'U')).toBe('J');
    expect(pickCoverBucket('J', [], 'U')).toBe('J');
  });

  it('is a no-op without a preference (today’s behaviour)', () => {
    expect(pickCoverBucket('J', ['J', 'U'], null)).toBe('J');
    expect(pickCoverBucket('J', ['J', 'U'])).toBe('J');
  });

  it('offers only the three geographic regions worth choosing', () => {
    expect(COVER_REGION_CHOICES).toEqual(['U', 'E', 'J']);
  });
});
