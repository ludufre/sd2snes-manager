import { describe, it, expect } from 'vitest';
import { isCurrent, isFresh, needsRestamp, SCHEMA_V, POSITIVE_TTL_MS, NEGATIVE_TTL_MS } from './gamedb-cache.js';

/** Only the pure freshness rule is covered here, the store I/O around it is best-effort by design
 *  (every failure path returns an empty map / no-ops), so it has nothing to assert that a real
 *  IndexedDB wouldn't be asserting about the browser. */
describe('isFresh', () => {
  const NOW = 1_800_000_000_000;
  const rec = (over: Record<string, unknown> = {}) => ({ v: SCHEMA_V, game: { id: 'g1' }, fetchedAt: NOW, ...over });

  it('accepts a match inside the positive TTL and rejects it after', () => {
    expect(isFresh(rec({ fetchedAt: NOW - 1000 }), NOW)).toBe(true);
    expect(isFresh(rec({ fetchedAt: NOW - POSITIVE_TTL_MS + 1 }), NOW)).toBe(true);
    expect(isFresh(rec({ fetchedAt: NOW - POSITIVE_TTL_MS }), NOW)).toBe(false);
  });

  it('expires a cached NO-MATCH sooner than a match (the GameDB gains games continuously)', () => {
    const neg = { v: SCHEMA_V, game: null, fetchedAt: NOW - NEGATIVE_TTL_MS + 1 };
    expect(isFresh(neg, NOW)).toBe(true);
    expect(isFresh({ ...neg, fetchedAt: NOW - NEGATIVE_TTL_MS }, NOW)).toBe(false);
    // ...and the same age that keeps a match fresh does not keep a no-match fresh
    const age = NOW - (NEGATIVE_TTL_MS + 1000);
    expect(isFresh(rec({ fetchedAt: age }), NOW)).toBe(true);
    expect(isFresh({ v: SCHEMA_V, game: null, fetchedAt: age }, NOW)).toBe(false);
  });

  it('treats a record written by another schema version as a miss (the kill-switch)', () => {
    expect(isFresh(rec({ v: SCHEMA_V + 1 }), NOW)).toBe(false);
    expect(isFresh(rec({ v: SCHEMA_V - 1 }), NOW)).toBe(false);
    expect(isFresh({ game: { id: 'g1' }, fetchedAt: NOW }, NOW)).toBe(false); // pre-versioning record
  });

  it('honours a caller-supplied freshness cap: the limit is min(TTL, maxAge)', () => {
    const fiveMin = 5 * 60 * 1000;
    const r = rec({ fetchedAt: NOW - fiveMin - 1 });
    expect(isFresh(r, NOW)).toBe(true);                 // well inside the positive TTL
    expect(isFresh(r, NOW, 10 * 60 * 1000)).toBe(true); // ...and inside a 10-minute cap
    expect(isFresh(r, NOW, fiveMin)).toBe(false);       // ...but not a 5-minute one
    // 0 is the total bypass the explicit "Identificar"/"Atualizar dados" actions pass: nothing, not
    // even a record written this instant, can satisfy it.
    expect(isFresh(rec({ fetchedAt: NOW }), NOW, 0)).toBe(false);
    // a cap looser than the TTL never extends it
    expect(isFresh(rec({ fetchedAt: NOW - POSITIVE_TTL_MS }), NOW, 10 * POSITIVE_TTL_MS)).toBe(false);
  });

  it('rejects nothing-at-all and unusable timestamps (incl. a record from the future)', () => {
    expect(isFresh(null, NOW)).toBe(false);
    expect(isFresh(undefined, NOW)).toBe(false);
    expect(isFresh(rec({ fetchedAt: undefined }), NOW)).toBe(false);
    expect(isFresh(rec({ fetchedAt: NaN }), NOW)).toBe(false);
    expect(isFresh(rec({ fetchedAt: NOW + 60_000 }), NOW)).toBe(false); // clock moved backwards
  });
});

/** The revision rule is what the reports were about: a cached answer that said "no cover" kept being
 *  served for a week after the GameDB gained one. With a revision in hand, age stops mattering. */
describe('isCurrent', () => {
  const NOW = 1_800_000_000_000;
  const rec = (over: Record<string, unknown> = {}) => ({ v: SCHEMA_V, game: { id: 'g1' }, rev: 'aaaa', fetchedAt: NOW, ...over });

  it('serves a match whose revision is still the server\'s, however old the record is', () => {
    expect(isCurrent(rec({ fetchedAt: NOW - 10 * POSITIVE_TTL_MS }), 'aaaa', NOW)).toBe(true);
  });

  it('refuses a match whose revision moved, however recent the record is', () => {
    // A cover added upstream a minute after this answer was cached.
    expect(isCurrent(rec({ fetchedAt: NOW - 1000 }), 'bbbb', NOW)).toBe(false);
  });

  it('refuses a record from before revisions existed once the server gives one', () => {
    const legacy = { v: SCHEMA_V, game: { id: 'g1' }, fetchedAt: NOW };
    expect(isCurrent(legacy, 'aaaa', NOW)).toBe(false);
    expect(isCurrent({ ...legacy, rev: null }, 'aaaa', NOW)).toBe(false);
  });

  it('keeps a no-match only while the server still has no game for the CRC', () => {
    const neg = rec({ game: null, rev: null, fetchedAt: NOW - 10 * NEGATIVE_TTL_MS });
    expect(isCurrent(neg, null, NOW)).toBe(true);    // still unknown upstream, age is irrelevant
    expect(isCurrent(neg, 'cccc', NOW)).toBe(false); // the GameDB gained the game
    expect(isCurrent(rec(), null, NOW)).toBe(false); // the game is gone upstream, ask for the real answer
  });

  it('falls back to the TTLs when the revision is unknown', () => {
    const old = rec({ fetchedAt: NOW - POSITIVE_TTL_MS });
    expect(isCurrent(old, undefined, NOW)).toBe(isFresh(old, NOW));
    const recent = rec({ fetchedAt: NOW - 1000 });
    expect(isCurrent(recent, undefined, NOW, 10 * 60 * 1000)).toBe(isFresh(recent, NOW, 10 * 60 * 1000));
  });

  it('still refuses everything on an explicit refresh (maxAge 0), revision or not', () => {
    expect(isCurrent(rec(), 'aaaa', NOW, 0)).toBe(false);
    expect(isCurrent(rec({ game: null, rev: null }), null, NOW, 0)).toBe(false);
  });

  it('ignores any other freshness cap once the revision is known', () => {
    // Auto-fill's 10-minute window only exists to trust sync tokens; a matching revision is stronger.
    expect(isCurrent(rec({ fetchedAt: NOW - 60 * 60 * 1000 }), 'aaaa', NOW, 10 * 60 * 1000)).toBe(true);
  });

  it('treats another schema version and missing records as a miss', () => {
    expect(isCurrent(rec({ v: SCHEMA_V + 1 }), 'aaaa', NOW)).toBe(false);
    expect(isCurrent(null, 'aaaa', NOW)).toBe(false);
    expect(isCurrent(undefined, null, NOW)).toBe(false);
  });
});

describe('needsRestamp', () => {
  const NOW = 1_800_000_000_000;

  it('re-stamps a confirmed record once it is a positive TTL old, not before', () => {
    expect(needsRestamp({ fetchedAt: NOW - POSITIVE_TTL_MS + 1 }, NOW)).toBe(false);
    expect(needsRestamp({ fetchedAt: NOW - POSITIVE_TTL_MS }, NOW)).toBe(true);
  });

  it('never re-stamps nothing, a record without a timestamp, or one from the future', () => {
    expect(needsRestamp(null, NOW)).toBe(false);
    expect(needsRestamp({}, NOW)).toBe(false);
    expect(needsRestamp({ fetchedAt: NOW + 60_000 }, NOW)).toBe(false);
  });
});
