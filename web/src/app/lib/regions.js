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
