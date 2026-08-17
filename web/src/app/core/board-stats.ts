// Asset presence + the per-system board tally. Pure functions, deliberately outside LibraryStore:
// the store is a 4k-line service with a card, a network client and a worker behind it, and none of
// that is needed to answer "does this game have its cover yet".

import { MAN_USER_TAG } from '../lib/yml.js';
import { BOARD_COLS, SYSTEM_ORDER } from './models';
import type { BoardCell, BoardCol, BoardRow, Entry, FillCategory, FillMode, FillPlan, StatusFilter, System } from './models';

/** Every category an auto-fill plan can act on, in dialog order. Here rather than inline in the store
 *  so the predicates below and the run itself can't disagree about what "every category" means. */
export const FILL_CATS: readonly FillCategory[] = ['capa', 'tela', 'previa', 'info', 'cheats', 'manual'];

/**
 * Does a fill mode act on a game in this state? The four modes form a ladder, each covers everything
 * the one before it does, plus more:
 *
 *   off ⊂ complete (missing) ⊂ update (missing + outdated) ⊂ replace (every game with a source)
 *
 * `update` includes the missing ones on purpose: the modes are a single-choice segmented control, so
 * if it only rewrote the outdated ones, "leave this category in sync" would take two runs (Complete,
 * then Update), and the one mode that covered both, Replace, also rewrites what's already current,
 * doubling the download and the (slow) card writes for nothing.
 */
export function fillModeActs(mode: FillMode, state: { available: boolean; present: boolean; stale: boolean }): boolean {
  if (mode === 'off' || !state.available) return false;
  if (mode === 'replace') return true;
  if (mode === 'update') return !state.present || state.stale;
  return !state.present;
}

/**
 * Is asset `cat` already on the card for `g`? The single source of truth for "present", shared by
 * auto-fill and the statbar board, so the board's "20 missing" and what auto-fill would write are
 * the same 20 games.
 *
 * Two subtleties worth keeping straight:
 * - `capa` needs both the browser `.cov` and the game info `.gcv`. A `.cov` alone still needs filling
 *   (the game-info screen wants the paletted cover, else the firmware falls back to a
 *   tile-quantised OBJ render).
 * - `manual` is the whole served set, not just slot 0, see `servedManualCount`. `guias` is the
 *   board's broader question: any `.man` on the card, including the user's slots 2..8.
 */
export function assetPresent(g: Entry, cat: FillCategory | 'guias'): boolean {
  return cat === 'capa' ? (g.cover === 'has' || g.cover === 'custom') && g.gcv === 'has'
    : cat === 'tela' ? g.snapshot === 'has'
    : cat === 'previa' ? g.fmv === 'has'
    : cat === 'info' ? g.info === 'has'
    : cat === 'manual' ? g.manual === 'has' && officialGuideCount(g) >= servedManualCount(g)
    : cat === 'guias' ? (g.guides ?? 0) > 0
    : g.cheats === 'has';
}

/**
 * How many documents the "Guias/Manuais" category promises for `g`. Every manual the GameDB can
 * actually serve. A row with no `.man` published can never land, so it is not part of the promise
 * (the same rule `assetAvailable` applies).
 *
 * This is what "present" has to be measured against. `manual === 'has'` alone is slot 0, and slot 0
 * is one document of up to five (Zelda ALTTP, Super Metroid). Auto-fill's write worker only ever
 * writes the primary; the extras come from a second pass, whose games are picked by re-asking
 * `fillNeeds`. After the worker has already flipped `manual` to 'has'. With presence meaning slot 0,
 * that answer was "nothing missing here", the second pass got an empty list, and Completar/Atualizar
 * installed exactly one manual per game while the dialog promised (and estimated) the whole set.
 * Replace was unaffected, it acts on every game with a source, so it never asked the question.
 */
export function servedManualCount(g: Pick<Entry, 'manuals' | 'manualUrl'>): number {
  const n = g.manuals?.filter((m) => !!m.manualUrl).length ?? 0;
  return n || (g.manualUrl ? 1 : 0);
}

/**
 * How many of those documents the card can be proven to hold. Deliberately the lower of the two
 * things we know, because each is blind in the opposite direction:
 *   · `guides` counts `.man` files for the stem, it cannot tell auto-fill's documents from the
 *     user's own guides in slots 2..8, so on its own it overstates a card whose slots are the user's;
 *   · the game info file's `man_slots` names which document is in each slot (`u` = the user's), but it only
 *     exists once a run has written it, and it can name a slot the card no longer holds.
 * Taking the minimum means an unproven document reads as missing, never as installed: the cost of
 * being wrong is one skipped write (offered again next run), against a document silently never
 * installed at all, the failure this whole function exists to end.
 */
export function officialGuideCount(g: Pick<Entry, 'guides' | 'manSlots'>): number {
  const files = g.guides ?? 0;
  const map = g.manSlots;
  if (!map || !map.size) return files;
  let official = 0;
  for (const tag of map.values()) if (tag !== MAN_USER_TAG) official++;
  return Math.min(files, official);
}

/**
 * The twin of `assetPresent`: can the GameDB (and what is already on the card) supply asset `cat` for
 * `g`? The auto-fill dialog counts exactly this as "available", so it is also the promise the run has
 * to keep, anything counted here and not deliverable leaves a category permanently "to complete".
 *
 * - `capa` is available when a `.cov` already sits on the card too (no GameDB cover image needed):
 *   the `.gcv` is derived from it (buildGcvFromCov). So "absent" = neither `.cov` nor `.gcv`.
 * - `tela` is its own paletted `.gss` now. It just needs a screenshot source (no cover compositing).
 * - `previa` needs a ready `.fmv` inside the game's `.s2pkg`: auto-fill never encodes video (no
 *   ffmpeg, no mp4 download, that belongs to the explicit per-game actions on the game info file). A game the
 *   GameDB has a video for but no package built yet is therefore not available. Whether an existing
 *   package actually carries the `fmv` member can only be known once it is downloaded. Those few are
 *   skipped and named in the post-run report.
 * - `manual`: a manual the GameDB lists but can't serve (no `.man` published → manualUrl null) is not
 *   available, for the same "never satisfiable" reason.
 */
export function assetAvailable(g: Entry, cat: FillCategory): boolean {
  return cat === 'capa' ? !!g.coverUrl || g.cover === 'has' || g.cover === 'custom'
    : cat === 'tela' ? !!g.screenshotUrl
    : cat === 'previa' ? !!g.videoUrl && !!g.packageUrl
    : cat === 'info' ? g.matched
    : cat === 'manual' ? (g.manuals?.some((m) => !!m.manualUrl) ?? false) || !!g.manualUrl
    : g.cheats === 'available' || g.cheats === 'has';
}

/**
 * Must `g` be re-asked to the GameDB before an auto-fill run with this plan?
 *
 * "Atualizar"/"Substituir" decide what to rewrite by comparing the card's `sync_*`/`metaRev` tokens
 * against the ones the match carries, and a match resolved from the local cache carries whatever the
 * server had when it was cached. Against a stale cache "Atualizar" compares yesterday's card to
 * yesterday's server and finds nothing, a silent no-op on the one mode meant to find something. The
 * pre-run refresh in `runAutoFill` closes that, and this is the set it has to cover: for each category
 * the plan puts in `update`/`replace`, the games where a fresher answer can change the outcome.
 *
 * - `assetPresent`  → the asset is on the card, so this is where the token compare runs;
 * - `assetAvailable`→ the GameDB has a source, so the run may actually write it.
 *
 * The rest is left out on purpose. A game with neither the asset on card nor a source for it cannot
 * have its outcome changed by a fresher token, only by a source that appeared upstream since the lookup
 * was cached. That does happen, but catching it belongs to the gamedb cache's TTL and to the explicit
 * "Atualizar dados do GameDB" button, not to a pass whose cost scales with the whole library on every
 * Atualizar. What forced this: a 6392-game card with everything on "Não mexer" except Cheats=Atualizar,
 * a dialog promising "3 cheats · 859 KB", and thousands of card reads and lookups
 * ("Identificando... 3301/6392") before three small files were written.
 */
export function needsGamedbRefresh(g: Entry, plan: FillPlan): boolean {
  return FILL_CATS.some(
    (c) => (plan[c] === 'update' || plan[c] === 'replace') && (assetPresent(g, c) || assetAvailable(g, c)),
  );
}

/** Which asset a `missing-X` / `has-X` status filter is about. */
const STATUS_ASSET: Record<string, BoardCol> = {
  cover: 'capa', snapshot: 'tela', preview: 'previa',
  info: 'info', cheats: 'cheats', guides: 'guias',
};

/**
 * Does `g` belong in the list under status filter `status`?
 *
 * Every `has-X` is the exact negation of its `missing-X`, derived here rather than written twice,
 * the board shows both sides of the same number, so any drift between the two predicates would show
 * up immediately as a cell whose halves don't add up to the row total.
 */
export function matchesStatus(g: Entry, status: StatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'unmatched') return !g.matched;

  const [kind, asset] = status.split('-');
  const col = STATUS_ASSET[asset];
  if (!col) return true; // unknown filter → don't hide anything
  const present = assetPresent(g, col);
  return kind === 'has' ? present : !present;
}

/**
 * Whole-list asset tally broken down by platform: one row per system present (in SYSTEM_ORDER),
 * plus an aggregate total row (`system: null`) whenever there's more than one system to add up.
 *
 * Single pass on purpose. The naive shape, one `filter().length` per number, as `tally()` does for
 * the flat statbar. Would be 48 full walks of the list here (8 systems x 6 columns).
 */
export function tallyBoard(entries: readonly Entry[]): BoardRow[] {
  const cols = BOARD_COLS.map((c) => c.key);
  const blank = (): Record<BoardCol, number> =>
    ({ capa: 0, tela: 0, previa: 0, info: 0, cheats: 0, guias: 0 });

  const acc = new Map<System, { total: number; have: Record<BoardCol, number> }>();
  const grand = { total: 0, have: blank() };

  for (const g of entries) {
    let row = acc.get(g.system);
    if (!row) { row = { total: 0, have: blank() }; acc.set(g.system, row); }
    row.total++;
    grand.total++;
    for (const c of cols) {
      if (!assetPresent(g, c)) continue;
      row.have[c]++;
      grand.have[c]++;
    }
  }

  const toRow = (system: System | null, src: { total: number; have: Record<BoardCol, number> }): BoardRow => {
    const cells = {} as Record<BoardCol, BoardCell>;
    for (const c of cols) {
      const have = src.have[c];
      cells[c] = { have, missing: src.total - have, pct: src.total ? Math.round((have / src.total) * 100) : 0 };
    }
    return { system, total: src.total, cells };
  };

  const rows = SYSTEM_ORDER.filter((s) => acc.has(s)).map((s) => toRow(s, acc.get(s)!));
  if (rows.length > 1) rows.push(toRow(null, grand));
  return rows;
}
