// The cover-region preference, applied. Pure and deliberately outside LibraryStore: everything here
// is a function of what Identify already put on the entry, which is exactly what makes switching the
// preference a synchronous re-tally instead of a re-resolve of the whole library.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { pickCoverBucket } from '../lib/regions.js';
import type { Entry } from './models';

/** A cover-region preference: one bucket letter, or null for "no preference" (today's behaviour). */
export type CoverRegion = 'U' | 'E' | 'J' | null;

/** The slice of an Entry the preference reads. Narrow on purpose, so the specs can build one by hand
 *  and so nothing here can start depending on card state. */
export type CoverEntry = Pick<Entry, 'bucket' | 'coverChoices' | 'coverUrls' | 'coverUrl'>;

/**
 * Which cover `g` should get under preference `pref`, and where it comes from.
 *
 * Pure, synchronous and total: every ingredient is already on the entry (set at Identify), so
 * switching the preference costs no lookup, no IndexedDB read and no re-resolve. That is the whole
 * reason resolveMatch exports the per-bucket URLs instead of applying the preference itself.
 */
export function coverPick(g: CoverEntry, pref: CoverRegion): { bucket: string | null; url: string | null } {
  const general = { bucket: g.bucket ?? null, url: g.coverUrl ?? null };
  const choices = g.coverChoices, urls = g.coverUrls;
  if (!pref || !choices || !urls) return general;
  const b = pickCoverBucket(general.bucket, choices, pref) as string | null;
  if (!b || b === general.bucket) return general;
  return { bucket: b, url: urls[b] ?? general.url };
}

/**
 * Does the preference move this game's cover off the bucket the rest of its match rides on?
 *
 * The one test behind three decisions, which is exactly why it is one function: ignore the `.s2pkg`'s
 * `cov`/`gcv` (the server builds the package per CRC with the ROM's own region baked in, and the API
 * has no way to ask for another), route that write to the main thread (the encoder is wasm plus
 * canvas, see lib/covwasm.js and lib/fmv.js: neither exists in the write worker), and stamp
 * `cover_region` on the card so a later run can tell the art apart from what the package holds.
 */
export function coverDiverges(g: CoverEntry, pref: CoverRegion): boolean {
  const p = coverPick(g, pref);
  return !!p.bucket && p.bucket !== (g.bucket ?? null);
}
