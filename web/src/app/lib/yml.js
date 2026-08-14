// `.yml` game-info writer + filename addressing, faithful port of the gamedb
// yml-writer.ts (build_gameinfo_yml.py) and export.engine.ts naming.

export const YML_COMMENT = '# sd2snes game info — gerado pelo sd2snes-covers-web';

/** Mirrors Python yfield: falsy -> omitted; `"`->`'`; CR/LF->space; trimmed; quoted. */
export function yfield(key, val) {
  if (!val) return null;
  const s = String(val).replace(/"/g, "'").replace(/\r/g, ' ').replace(/\n/g, ' ').trim();
  return s ? `${key}: "${s}"` : null;
}

const FIELD_ORDER = ['title', 'developer', 'publisher', 'release_year', 'players', 'genre', 'special_chip', 'description', 'rom', 'region', 'crc', 'gamedb_id'];

// Per-language descriptions. `description` stays the canonical English text; each translation the
// GameDB has rides a sibling `description_<lang>` key. The firmware (gameinfo.c gi_desc_lang_key)
// reads the key for the console's menu language and falls back to English when it is missing or
// empty -- so one file serves every console language and changing the language needs no re-sync.
// Codes + order mirror the gamedb translationLangSchema (and the backend's yml-writer.ts).
export const DESC_LANGS = ['fr', 'pt', 'es', 'de', 'it'];
export const DESC_LANG_KEYS = DESC_LANGS.map((l) => `description_${l}`);

/** `{ [lang]: text }` → the `.yml` field set. Unknown codes and empty texts are dropped. */
export function descLangFields(descriptions) {
  const out = {};
  for (const lang of DESC_LANGS) {
    const v = descriptions && descriptions[lang];
    if (v) out[`description_${lang}`] = v;
  }
  return out;
}

// Sync bookkeeping keys, not firmware metadata; the Manager writes them so a later lookup can tell
// what's stale (see startAutoFill/fillStale) without re-downloading. The firmware yaml.c ignores
// unknown keys, so they ride harmlessly in the same `<rom>.yml`. Emitted after the metadata + fmv flag.
//   sync_pkg, content-hash (sha16, from the .s2pkg URL) of the package that fed capa/tela/prévia/cheats
//   sync_pcm, content-hash of the separated `.pcm.zst` (audio), when written
//   sync_man, compact digest of the region's manuals (each manSha256[:16], joined), changes on any
//               add/remove/reorder/content change
//   sync_meta, the server's `metaRev` for this ROM's `.yml` metadata (info staleness token)
export const SYNC_KEYS = ['sync_pkg', 'sync_pcm', 'sync_man', 'sync_meta'];

// Slot→document map, bookkeeping like the sync_* keys, but recording card state instead of a server
// version, which is why it is deliberately not in SYNC_KEYS (persistSyncTokens resolves every key in
// that list against syncTokensFromMatch and deletes the ones it can't derive; man_slots would be wiped
// on the first token rewrite).
//
// It exists because a guide slot on the card is just `<stem>.NN.man`, the file name carries no mark of
// Which document is in it. The only identity autofill had was the sha256 of the bytes, so when the
// GameDB re-encoded all 3664 `.man` files (2026-08-08: double-page split + pre-quantization sharpening)
// every manSha256 changed, every extra manual read as "not on this card", each one took another free
// slot next to the copy it was meant to replace, and games with 4 extras (Zelda ALTTP, Super Metroid)
// ran out of slots and reported `slotsfull` without owning a single duplicate.
//   man_slots, `slot:groupUuid[:8]` pairs (`0:h5y4tn5i,2:ahtd2trh,3:quhu9t87`). `groupUuid` is the
//               GameDB's identity for the document and is stable across versions (the per-version
//               `uuid` is not), so a re-encode now resolves to "rewrite the slot it is already in".
export const MAN_SLOTS_KEY = 'man_slots';
/** Chars of the groupUuid kept per pair. The tag only has to separate one game's ≤8 documents, never
 *  anything global, so 8 is ample, and it keeps the whole line (≤8 pairs) around 90 chars, well inside
 *  the firmware reader's 256-byte line cap (sd2snes-next yaml.h YAML_BUFLEN). */
export const MAN_GROUP_TAG_LEN = 8;

/** The one tag that is not a document: the slot holds a guide the user added (see addGuide). It marks
 *  the slot as theirs, never adopted as an old copy of anything, never swept, never overwritten. A
 *  single letter cannot come out of a real `groupUuid` (uuids/cuids fold to 8 chars), and manGroupTag
 *  refuses it outright below, so the two namespaces cannot collide. */
export const MAN_USER_TAG = 'u';

/** GameDB `groupUuid` → the tag stored in `man_slots`: lowercased, non-alphanumerics dropped (so a
 *  dashed uuid can never smuggle the `:`/`,` separators into the value), truncated. Null when the
 *  GameDB gave no group. There is then nothing to record, and the caller falls back to sha dedup,
 *  and null too for anything that would collide with the reserved user marker. */
export function manGroupTag(groupUuid) {
  const s = String(groupUuid ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s || s === MAN_USER_TAG) return null;
  return s.slice(0, MAN_GROUP_TAG_LEN);
}

/* The grammar of the value, which is what makes "the line always fits" an invariant by construction
   rather than a hope: a slot is one digit and a tag is at most MAN_GROUP_TAG_LEN chars, so ten pairs
   is the absolute ceiling, 10 * (1 + 1 + 8) + 9 commas = 109 chars, against YAML_BUFLEN's 256. Both
   ends clamp, so nothing a hand-edited (or future) game info carries can push the line past the firmware
   reader's cap. Which digits are real guide slots stays man.js's business (GUIDE_SLOTS), this module
   only decides what the field may look like, exactly as it does for every other key. */
const MAN_SLOT_PAIR = /^\s*(\d)\s*:\s*([a-z0-9]{1,8})\s*$/i;

/** `"0:h5y4tn5i,2:ahtd2trh"` → `Map<slot, tag>`. Tolerant in the same spirit as parseInfoYml: an
 *  unreadable pair is dropped rather than thrown over (the game info file may be hand-edited, and a bad byte
 *  there must not take a whole run down). A tag repeated across two slots is kept. That duplicate is
 *  precisely what the cleanup pass is looking for.
 *  @returns {Map<number, string>} */
export function parseManSlots(value) {
  /** @type {Map<number, string>} */
  const out = new Map();
  for (const part of String(value ?? '').split(',')) {
    const m = MAN_SLOT_PAIR.exec(part);
    if (m) out.set(Number(m[1]), m[2].toLowerCase());
  }
  return out;
}

/** The inverse. Null for an empty map, so yfield omits the key entirely instead of writing `""`.
 *  Pairs go out in ascending slot order: an unchanged map must serialize byte-identically, or every
 *  game info rewrite would look like a change and cost a needless card write. Clamped to the same grammar
 *  parseManSlots accepts, so serialize(parse(x)) can never grow the line.
 *  @param {ReadonlyMap<number, string> | null | undefined} map */
export function serializeManSlots(map) {
  if (!map || !map.size) return null;
  const pairs = [...map.entries()]
    // the reserved user marker rides through as-is; manGroupTag rejects it on purpose (see MAN_USER_TAG)
    .map(([slot, tag]) => [slot, tag === MAN_USER_TAG ? MAN_USER_TAG : manGroupTag(tag)])
    .filter(([slot, tag]) => Number.isInteger(slot) && slot >= 0 && slot <= 9 && !!tag)
    .sort((a, b) => a[0] - b[0])
    .map(([slot, tag]) => `${slot}:${tag}`);
  return pairs.length ? pairs.join(',') : null;
}

export function buildYml(fields, comment = YML_COMMENT) {
  const lines = ['---', comment];
  for (const key of FIELD_ORDER) {
    const line = yfield(key, fields[key]);
    if (line) lines.push(line);
  }
  if (fields.fmv) lines.push('fmv: 1'); // unquoted flag; key-presence gates the .fmv probe
  for (const key of SYNC_KEYS) {
    const line = yfield(key, fields[key]);
    if (line) lines.push(line);
  }
  // Rides with the bookkeeping, but see MAN_SLOTS_KEY: it is card state, not a server token, and must
  // never be folded into the SYNC_KEYS loop above.
  { const line = yfield(MAN_SLOTS_KEY, fields[MAN_SLOTS_KEY]); if (line) lines.push(line); }
  // The localized descriptions go last, after every short field. The firmware's YAML reader rewinds
  // and re-scans the file once per key it wants, stopping at the hit -- keeping the bulk at the end
  // leaves every other lookup cheap, and only the one localized description costs a full scan.
  for (const key of DESC_LANG_KEYS) {
    const line = yfield(key, fields[key]);
    if (line) lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/** Extract the content-hash (sha16) from a package/pcm CDN URL: `<CRC>.<sha16>.s2pkg` or
 *  `<CRC>.<sha16>.pcm.zst` → the 2nd dotted segment of the filename. Null for the local
 *  fallback URL (`/api/packages/<CRC>`, no hash) or anything unrecognized. */
export function shaFromAssetUrl(url) {
  if (!url) return null;
  const base = String(url).split('?')[0].split('#')[0].split('/').pop() || '';
  const parts = base.split('.');
  return parts.length >= 3 && /^[0-9a-f]{6,}$/i.test(parts[1]) ? parts[1] : null;
}

/** Build the four sync tokens from a resolved GameDB match. `null`/absent members yield null tokens
 *  (a missing token is treated as "unknown → stale" by the reader). */
export function syncTokensFromMatch(match) {
  if (!match) return { sync_pkg: null, sync_pcm: null, sync_man: null, sync_meta: null };
  // Only manuals the GameDB can actually serve count toward the digest. One it merely lists (no
  // `.man` published yet → `manualUrl` null) would make the token unreachable: the category would read
  // as outdated forever, since auto-fill has nothing to download and so never stamps the new value.
  const mans = (match.manuals || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((m) => (m && m.sha256 && m.manualUrl ? String(m.sha256).slice(0, 16) : ''))
    .filter(Boolean);
  return {
    sync_pkg: shaFromAssetUrl(match.packageUrl),
    sync_pcm: shaFromAssetUrl(match.pcmUrl),
    sync_man: mans.length ? mans.join('.') : null,
    sync_meta: match.metaRev ?? null,
  };
}

/** Build the firmware field set from a resolved GameDB match + the local ROM. */
export function ymlFieldsFromMatch(match, rom) {
  return {
    title: match.title,
    developer: match.developer,
    publisher: match.publisher,
    release_year: match.releaseYear != null ? String(match.releaseYear) : null,
    players: match.players,
    genre: match.genre,
    special_chip: match.specialChip,
    description: match.description, // canonical English (the console's fallback for every language)
    rom: rom.romName || rom.name,
    region: rom.region ?? null,
    crc: rom.crc,
    fmv: match.videoUrl ? 1 : null,
    ...descLangFields(match.descriptions),
  };
}

/** Parse a game-info `.yml` (the `key: "value"` lines buildYml writes) back into a fields object.
 *  Tolerant: ignores `---`, comments, and unknown lines; `fmv: 1` → fmv:'1'. */
export function parseInfoYml(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === '---' || line.startsWith('#')) continue;
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/* ---------- output addressing (beta3 rom-bucketed: <C>/<stem>.{yml,gd,fmv,cov}) ---------- */

/** ROM filename stem (strip last extension), as the firmware does (strrchr '.'). */
export function romStem(romName) {
  const i = romName.lastIndexOf('.');
  return i > 0 ? romName.slice(0, i) : romName;
}

/* bucketChar/outBase moved to core/sd-layout.ts when the card went to two-letter buckets
   (firmware 2.15+). That module is the single definition of the rule and is pinned against the
   firmware by sd-layout.spec.ts -- do not reintroduce a copy here. */
