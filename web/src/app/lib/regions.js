// Region buckets, ported 1:1 from @gamedb/shared (regions.ts) so the web app
// picks the same region card the database fans out into.

export const REGION_LABELS = { J: 'Japan', U: 'USA', E: 'Europe', W: 'World', O: 'Other' };
export const REGION_FLAGS = { J: '🇯🇵', U: '🇺🇸', E: '🇪🇺', W: '🌍', O: '🌐' };
export const REGION_ORDER = ['U', 'E', 'J', 'W', 'O'];

/** Map a No-Intro region string to one or more buckets (a "USA, Europe" dump → [U, E]). */
export function bucketsOfRegion(region) {
  if (!region) return ['O'];
  const r = region.toLowerCase();
  const out = new Set();
  if (/\b(japan|asia|korea|china|hong kong|taiwan)\b/.test(r)) out.add('J');
  if (/\b(usa|canada|brazil|mexico|latin)\b/.test(r)) out.add('U');
  if (/\b(europe|uk|england|germany|france|spain|italy|sweden|netherlands|australia|scandinav|russia|poland|finland|denmark|norway|greece|portugal)\b/.test(r)) out.add('E');
  if (/\bworld\b/.test(r)) out.add('W');
  if (!out.size) out.add('O');
  return [...out];
}

/** Pick the best matching bucket for a ROM's region against the buckets a game actually has. */
export function pickBucket(romRegion, availableBuckets) {
  const wanted = bucketsOfRegion(romRegion);
  for (const b of wanted) if (availableBuckets.includes(b)) return b;
  for (const b of REGION_ORDER) if (availableBuckets.includes(b)) return b; // sensible fallback
  return availableBuckets[0] ?? null;
}


/** The buckets a cover-region preference may name. Deliberately not REGION_ORDER: 'O' (Other) is a
 *  catch-all the GameDB fans nothing into on purpose, and 'W' is already what "no preference"
 *  resolves to for a World ROM. Neither is a choice worth offering. */
export const COVER_REGION_CHOICES = ['U', 'E', 'J'];

/**
 * Which regions' art a ROM may legitimately wear, out of the ones this game actually has a cover for.
 *
 * More than one is the common case, not an edge case: a No-Intro region string is a list, so
 * `Super Metroid (Japan, USA)` is genuinely both, and today the bucket it lands on is decided by the
 * order the tests happen to appear in bucketsOfRegion (Japan before USA before Europe). That is a
 * coin toss the user never got to call, and it is the whole reason a preference exists.
 *
 * A World dump is the one that stands for every region at once, so any card's art fits it. Every
 * other ROM may only wear the art of a region it actually claims: a `(Japan)` dump under the USA box
 * would show a cartridge that is not the one on the card.
 *
 * @param {string|null|undefined} romRegion the No-Intro region string
 * @param {string[]} coverBuckets buckets this game actually has cover art for
 * @returns {string[]} in coverBuckets order; one entry (or none) means there is nothing to choose
 */
export function coverChoicesFor(romRegion, coverBuckets) {
  const wanted = bucketsOfRegion(romRegion);
  const eligible = wanted.includes('W') ? coverBuckets : wanted;
  return coverBuckets.filter((b) => eligible.includes(b));
}

/**
 * The cover bucket a preference resolves to, deliberately separate from pickBucket.
 *
 * Only the cover follows it. Title, screenshot, video and manuals keep riding the bucket pickBucket
 * chose, so a preference can never move the text on the game-info screen or swap a manual for another
 * region's. A preference the ROM cannot legitimately wear (not among `choices`) simply does not
 * apply, and the bucket the rest of the match rides on stands.
 *
 * @param {string|null} generalBucket
 * @param {string[]} choices see coverChoicesFor
 * @param {string|null} [prefer]
 * @returns {string|null}
 */
export function pickCoverBucket(generalBucket, choices, prefer = null) {
  return prefer && choices.includes(prefer) ? prefer : generalBucket;
}
