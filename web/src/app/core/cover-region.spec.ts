import { describe, it, expect } from 'vitest';
import { coverPick, coverDiverges, type CoverEntry } from './cover-region';
import { sanitizeCoverRegion } from './autofill-prefs';

/** A World dump whose match rode the Japanese card: it stands for every region, so all three are on
 *  the table. */
const worldRom: CoverEntry = {
  bucket: 'J',
  coverChoices: ['J', 'U', 'W'],
  coverUrl: 'https://db/j.png',
  coverUrls: { J: 'https://db/j.png', U: 'https://db/u.png', W: 'https://db/w.png' },
};

/** Super Metroid (Japan, USA): two regions at once, and the general bucket is the Japanese one only
 *  because bucketsOfRegion happens to test Japan first. */
const multiRom: CoverEntry = {
  bucket: 'J',
  coverChoices: ['J', 'U'],
  coverUrl: 'https://db/j.png',
  coverUrls: { J: 'https://db/j.png', U: 'https://db/u.png', E: 'https://db/e.png' },
};

describe('coverPick', () => {
  it('is a no-op without a preference', () => {
    expect(coverPick(worldRom, null)).toEqual({ bucket: 'J', url: 'https://db/j.png' });
  });

  it('moves the cover to the preferred region', () => {
    expect(coverPick(worldRom, 'U')).toEqual({ bucket: 'U', url: 'https://db/u.png' });
  });

  it('leaves the general bucket standing when the preferred region is not on offer', () => {
    // Europe is not among this dump's choices, so nothing moves
    expect(coverPick(worldRom, 'E')).toEqual({ bucket: 'J', url: 'https://db/j.png' });
  });

  it('moves a multi-region dump to either region it claims', () => {
    expect(coverPick(multiRom, 'U')).toEqual({ bucket: 'U', url: 'https://db/u.png' });
  });

  it('will not dress a dump in a region it does not claim', () => {
    // (Japan, USA) is not a European release, even though the game has European art
    expect(coverPick(multiRom, 'E').bucket).toBe('J');
  });

  it('leaves a ROM with nothing to choose alone', () => {
    expect(coverPick({ ...worldRom, coverChoices: null }, 'U').bucket).toBe('J');
  });

  it('leaves an entry that was never identified alone', () => {
    const bare: CoverEntry = { bucket: undefined, coverChoices: undefined, coverUrl: undefined, coverUrls: undefined };
    expect(coverPick(bare, 'U')).toEqual({ bucket: null, url: null });
  });

  it('is a no-op when the preference already is the general bucket', () => {
    expect(coverPick(worldRom, 'J' as 'U')).toEqual({ bucket: 'J', url: 'https://db/j.png' });
  });
});

describe('coverDiverges', () => {
  it('is true exactly when the cover leaves the bucket the rest of the match rides on', () => {
    expect(coverDiverges(worldRom, null)).toBe(false);
    expect(coverDiverges(worldRom, 'U')).toBe(true);
    expect(coverDiverges(worldRom, 'E')).toBe(false); // not on offer, so the general bucket stands
    expect(coverDiverges(multiRom, 'U')).toBe(true);
    expect(coverDiverges(multiRom, 'E')).toBe(false); // the dump is not European
    expect(coverDiverges({ ...worldRom, coverChoices: null }, 'U')).toBe(false);
  });
});

describe('sanitizeCoverRegion', () => {
  it('accepts only the offered buckets', () => {
    expect(sanitizeCoverRegion('U')).toBe('U');
    expect(sanitizeCoverRegion('E')).toBe('E');
    expect(sanitizeCoverRegion('J')).toBe('J');
    // 'W' and 'O' are not choices, and neither is anything a hand-edited localStorage may hold
    expect(sanitizeCoverRegion('W')).toBeNull();
    expect(sanitizeCoverRegion('O')).toBeNull();
    expect(sanitizeCoverRegion('u')).toBeNull();
    expect(sanitizeCoverRegion(42)).toBeNull();
    expect(sanitizeCoverRegion(undefined)).toBeNull();
  });
});
