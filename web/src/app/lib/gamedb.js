// Client for the sd2snes-gamedb read API. All these endpoints are public (no auth).
// NOTE: cross-origin requests need the gamedb to allow this app's origin via CORS.
import { pickBucket } from './regions.js';
import { apiFetch } from './net.js';
import { DESC_LANGS } from './yml.js';

const DEFAULT_BASE = 'https://gamedb.sd2snes.ludufre.com';

export class GameDb {
  constructor(baseUrl = DEFAULT_BASE) {
    this.setBase(baseUrl);
  }
  setBase(baseUrl) {
    // Allow an explicit '' (same-origin, e.g. behind a dev proxy); only fall
    // back to the default when no base was provided at all.
    this.base = (baseUrl == null ? DEFAULT_BASE : baseUrl).replace(/\/+$/, '');
  }

  /** Absolute URL for an asset (asset.url is like "/api/assets/<uuid>/file"). */
  assetUrl(asset) {
    if (!asset) return null;
    const u = typeof asset === 'string' ? asset : asset.url;
    if (!u) return null;
    return /^https?:\/\//.test(u) ? u : this.base + u;
  }

  async #json(path, { signal } = {}) {
    const res = await apiFetch(this.base + path, { credentials: 'omit', signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gamedb ${res.status} ${res.statusText}`);
    return res.json();
  }

  /** GET /api/games/lookup/by-crc/:crc[?lang=...] → GameWithRelations | null (404).
   *  `opts.lang` (fr|pt|es|de) asks the server for a localized `description` (+`descriptionLang`),
   *  En fallback done server-side. Omit for en. */
  lookupByCrc(crc, opts = {}) {
    const { lang, ...rest } = opts;
    const q = lang ? `?lang=${encodeURIComponent(lang)}` : '';
    return this.#json(`/api/games/lookup/by-crc/${encodeURIComponent(crc)}${q}`, rest);
  }

  /** Post /api/games/lookup/by-crcs { crcs:[...], lang? } → { [crcUpper]: GameWithRelations } (only matches).
   *  One request per batch instead of one per ROM. Post so the CRC list goes in the body.
   *  `opts.lang` (fr|pt|es|de) localizes `description` server-side (en fallback); omit for en. */
  async lookupByCrcs(crcs, { signal, lang } = {}) {
    if (!crcs?.length) return {};
    const body = lang ? { crcs, lang } : { crcs };
    const res = await apiFetch(this.base + '/api/games/lookup/by-crcs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`gamedb ${res.status} ${res.statusText}`);
    return res.json();
  }

  /** GET /api/games?... → Paged<GameSummary>. */
  search(params = {}, opts) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
    return this.#json(`/api/games?${q.toString()}`, opts);
  }

  /** GET /api/games/:id → GameWithRelations. */
  getGame(id, opts) {
    return this.#json(`/api/games/${encodeURIComponent(id)}`, opts);
  }
}

/** The GameDB's stored translations (`[{lang, description}]`) → `{ [lang]: description }`, keeping
 *  only the languages the card format knows (DESC_LANGS) and dropping empty texts. */
export function descriptionsByLang(translations) {
  const out = {};
  for (const t of translations || []) {
    if (!t || !t.description || !DESC_LANGS.includes(t.lang)) continue;
    out[t.lang] = t.description;
  }
  return out;
}

/** Active asset of a type for a bucket (region-specific; no generic). */
export function activeAsset(game, type, bucket) {
  const ofType = (game.assets || []).filter((a) => a.type === type && a.isActive);
  return bucket ? ofType.find((a) => a.regionBucket === bucket) || null : ofType[0] || null;
}

/** Resolve a ROM (by its region) against a looked-up game into a flat, render-ready match.
 *  Returns null when the game is null. `romCrc` (optional) sets `cheatsAvailable` straight from the
 *  game's cheats blocks (one per CRC), so callers don't need a separate per-CRC cheats probe. */
export function resolveMatch(db, game, romRegion, romCrc) {
  if (!game) return null;
  const buckets = (game.regions || []).map((r) => r.bucket);
  const bucket = pickBucket(romRegion, buckets);
  const region = (game.regions || []).find((r) => r.bucket === bucket) || null;

  const coverAsset = activeAsset(game, 'cover', bucket);
  const shotAsset = activeAsset(game, 'screenshot', bucket);
  const videoAsset = activeAsset(game, 'video', bucket);
  // the official manual (`.man`, ready with zoom) rides on the dto's top-level `manualUrl`, which the
  // server resolves (region→generic) to the derived `.man` object via publicManUrl. The `game_assets`
  // 'manual' entry's own url is the reduced PDF (source-of-truth), not the `.man`, so autofill must
  // Never read it (it would write a PDF into slot 0 and the firmware won't render it). Kept only for
  // presence/pageCount if needed; the downloadable `.man` is `game.manualUrl`.

  // the matching per-CRC cheat block rides along in the lookup response, reserve it (mapped to the
  // device Cheat shape) so callers can write the catalog without re-fetching <CRC>.yml (see dlCheats).
  const cheatBlock = romCrc ? (game.cheats || []).find((c) => c.crc32 && c.crc32.toUpperCase() === romCrc.toUpperCase()) : null;

  // the pre-built `.s2pkg` bundle URL (cover/gcv/gss/fmv/pcm/cheats) for this CRC's ROM, when the
  // gamedb has one, auto-fill prefers it over fetching+encoding the raw media (see library-store).
  const romRow = romCrc ? (game.roms || []).find((r) => r.crc32 && r.crc32.toUpperCase() === romCrc.toUpperCase()) : null;
  const packageUrl = romRow && romRow.packageUrl ? db.assetUrl(romRow.packageUrl) : null;
  const packageBytes = romRow && romRow.packageBytes != null ? romRow.packageBytes : null; // .s2pkg download size
  const packageNoAudioUrl = romRow && romRow.packageNoAudioUrl ? db.assetUrl(romRow.packageNoAudioUrl) : null; // legacy no-pcm variant
  const packageNoAudioBytes = romRow && romRow.packageNoAudioBytes != null ? romRow.packageNoAudioBytes : null;
  // separated, zstd-compressed audio (new packages); null when the .s2pkg still embeds the .pcm (legacy)
  const pcmUrl = romRow && romRow.pcmUrl ? db.assetUrl(romRow.pcmUrl) : null;
  const pcmBytes = romRow && romRow.pcmBytes != null ? romRow.pcmBytes : null;
  // metadata staleness token, digest of the fields that land in this ROM's `<rom>.yml` (server-computed)
  const metaRev = romRow && romRow.metaRev != null ? romRow.metaRev : null;

  return {
    id: game.id,
    title: (region && region.title) || game.title,
    platform: game.platform,
    developer: game.developer ?? null,
    publisher: game.publisher ?? null,
    releaseYear: game.releaseYear ?? null,
    players: game.players ?? null,
    genre: game.genre ?? null,
    specialChip: game.specialChip ?? null,
    description: game.description ?? null,
    // Every stored translation, keyed by language code. The lookup is made without `?lang=` so
    // `description` stays the canonical English one: the `.yml` carries English plus one
    // `description_<lang>` per translation and the console picks by its own menu language, so the
    // card must not be pinned to whatever language this app happens to be in.
    descriptions: descriptionsByLang(game.translations),
    completeness: game.completeness,
    reviewStatus: game.reviewStatus,
    bucket,
    coverUrl: db.assetUrl(coverAsset) || (region && region.coverUrl ? db.assetUrl(region.coverUrl) : null),
    screenshotUrl: db.assetUrl(shotAsset) || (region && region.screenshotUrl ? db.assetUrl(region.screenshotUrl) : null),
    videoUrl: db.assetUrl(videoAsset),
    // All manuals of this region (no generic), each a ready `.man` (with zoom) to write to a card slot.
    // Autofill writes these, never the reduced PDF. Ordered by sortOrder.
    manuals: (game.manuals || [])
      .filter((m) => m.regionBucket === bucket)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((m) => ({
        uuid: m.uuid,
        groupUuid: m.groupUuid,
        type: m.type,
        author: m.author ?? null,
        regionBucket: m.regionBucket ?? null,
        manualUrl: m.manualUrl ? db.assetUrl(m.manualUrl) : null,
        manBytes: m.manBytes ?? null,
        manRawBytes: m.manRawBytes ?? null,
        manualPdfUrl: m.manualPdfUrl ? db.assetUrl(m.manualPdfUrl) : null,
        sha256: m.manSha256 ?? null,
        sizeBytes: m.sizeBytes ?? null,
        pageCount: m.pageCount ?? null,
      })),
    // @deprecated use `manuals`. Primary manual's ready `.man` (with zoom), never the manual asset (PDF).
    manualUrl: game.manualUrl ? db.assetUrl(game.manualUrl) : null,
    // the reduced PDF, exposed separately for a future in-app viewer. Must not feed autofill.
    manualPdfUrl: game.manualPdfUrl ? db.assetUrl(game.manualPdfUrl) : null,
    packageUrl,
    packageBytes,
    packageNoAudioUrl,
    packageNoAudioBytes,
    pcmUrl,
    pcmBytes,
    metaRev,
    cheatsAvailable: !!cheatBlock,
    cheats: cheatBlock ? (cheatBlock.entries || []).map((e) => ({ name: e.name, on: !!e.enabled, codes: e.codes || [] })) : null,
    roms: game.roms || [],
  };
}
