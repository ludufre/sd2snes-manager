import { describe, it, expect } from 'vitest';
import { assetAvailable, assetPresent, FILL_CATS, fillModeActs, matchesStatus, needsGamedbRefresh, officialGuideCount, servedManualCount, tallyBoard } from './board-stats';
import { BOARD_COLS, type Entry, type FillCategory, type FillMode, type FillPlan, type System } from './models';

/** A game with nothing on the card; spread over it to set only what a case is about. */
function game(system: System, patch: Partial<Entry> = {}): Entry {
  return {
    id: Math.random().toString(36).slice(2),
    title: 't', file: 't.sfc', folder: '', system, crc: '', size: 0,
    matched: false, cover: 'none', cheats: 'none', save: false,
    ...patch,
  };
}

/** A four-document game (Zelda ALTTP / Super Mario World shape) the GameDB can serve in full. */
const FOUR_DOCS = [{ manualUrl: 'a' }, { manualUrl: 'b' }, { manualUrl: 'c' }, { manualUrl: 'd' }] as Entry['manuals'];

describe('fillModeActs', () => {
  const MISSING = { available: true, present: false, stale: false };
  const CURRENT = { available: true, present: true, stale: false };
  const OUTDATED = { available: true, present: true, stale: true };
  const acts = (mode: FillMode) => [MISSING, OUTDATED, CURRENT].map((s) => fillModeActs(mode, s));

  it('is a ladder: each mode covers everything the previous one does', () => {
    expect(acts('off')).toEqual([false, false, false]);
    expect(acts('complete')).toEqual([true, false, false]); // missing only
    expect(acts('update')).toEqual([true, true, false]);    // missing + outdated
    expect(acts('replace')).toEqual([true, true, true]);    // everything with a source
  });

  it("update fills the missing ones too — otherwise 'in sync' would need two runs", () => {
    // The old behaviour: update skipped a game with no asset at all, so a folder with both missing and
    // outdated items had to be run twice (Complete, then Update) or wholesale via Replace.
    expect(fillModeActs('update', MISSING)).toBe(true);
  });

  it('never acts without a GameDB source, whatever the mode', () => {
    for (const mode of ['complete', 'update', 'replace'] as FillMode[]) {
      expect(fillModeActs(mode, { available: false, present: false, stale: false })).toBe(false);
      expect(fillModeActs(mode, { available: false, present: true, stale: true })).toBe(false);
    }
  });
});

describe('assetPresent', () => {
  it('needs BOTH .cov and .gcv for the capa', () => {
    // The trap this guards: counting a bare .cov as done would report "0 missing" on a card where
    // every game-info screen still falls back to the firmware's tile-quantised render.
    expect(assetPresent(game('SNES', { cover: 'has' }), 'capa')).toBe(false);
    expect(assetPresent(game('SNES', { gcv: 'has' }), 'capa')).toBe(false);
    expect(assetPresent(game('SNES', { cover: 'has', gcv: 'has' }), 'capa')).toBe(true);
  });

  it('accepts a custom cover as a cover', () => {
    expect(assetPresent(game('SNES', { cover: 'custom', gcv: 'has' }), 'capa')).toBe(true);
  });

  it('separates the official manuals from guides (any slot)', () => {
    // A card with only user guides has no official manual. Auto-fill still has work to do there,
    // while the board's "guias" column is satisfied.
    const userOnly = game('SNES', { guides: 2, manual: 'none' });
    expect(assetPresent(userOnly, 'manual')).toBe(false);
    expect(assetPresent(userOnly, 'guias')).toBe(true);

    const none = game('SNES', { guides: 0 });
    expect(assetPresent(none, 'guias')).toBe(false);
  });
});

/**
 * The manual category is the whole served set, the bug this pins.
 *
 * Slot 0 is one document of up to five, and the write worker only ever writes that one; the extras
 * come from a later pass whose games are picked by asking "does this game still need manuals?". With
 * presence meaning `manual === 'has'`, the worker's own write turned that answer to "no" mid-run, the
 * extras pass got an empty list, and Completar/Atualizar installed exactly one manual per game while
 * the dialog promised the whole set (reproduced on Super Mario World: 1 file of 4, 7,6 MB against the
 * 33 MB estimated, and Substituir, which never asks the question, wrote all four).
 */
describe('assetPresent(manual) — the served SET, not just slot 0', () => {
  it('is NOT present when the card holds only the primary of a four-document game', () => {
    expect(assetPresent(game('SNES', { manual: 'has', guides: 1, manuals: FOUR_DOCS }), 'manual')).toBe(false);
  });

  it('is present once the card holds the whole set', () => {
    expect(assetPresent(game('SNES', { manual: 'has', guides: 4, manuals: FOUR_DOCS }), 'manual')).toBe(true);
  });

  it('still needs slot 0 itself, however many other slots are filled', () => {
    expect(assetPresent(game('SNES', { manual: 'none', guides: 4, manuals: FOUR_DOCS }), 'manual')).toBe(false);
  });

  it('ignores documents the GameDB cannot serve — they can never land', () => {
    const twoServed = [{ manualUrl: 'a' }, { manualUrl: null }, { manualUrl: 'c' }] as Entry['manuals'];
    expect(servedManualCount({ manuals: twoServed })).toBe(2);
    expect(assetPresent(game('SNES', { manual: 'has', guides: 2, manuals: twoServed }), 'manual')).toBe(true);
  });

  it('falls back to the deprecated scalar for a single-manual game', () => {
    expect(servedManualCount({ manualUrl: 'https://cdn/x.man' })).toBe(1);
    expect(assetPresent(game('SNES', { manual: 'has', guides: 1, manualUrl: 'https://cdn/x.man' }), 'manual')).toBe(true);
  });
});

/**
 * `officialGuideCount` takes the lower of the two things known about the card, because each is blind
 * in the opposite direction: the file count cannot tell our documents from the user's own guides, and
 * the ficha's map can name a slot the card no longer holds. Erring low costs one skipped write, which
 * the next run offers again; erring high is a document never installed at all.
 */
describe('officialGuideCount', () => {
  it('counts files when there is no map to go by', () => {
    expect(officialGuideCount({ guides: 3 })).toBe(3);
    expect(officialGuideCount({ guides: 3, manSlots: null })).toBe(3);
    expect(officialGuideCount({})).toBe(0);
  });

  it("does not let the user's own guides pass as installed documents", () => {
    // 4 `.man` on the card, but the ficha says three of them are the user's → one document of ours.
    const manSlots = new Map([[0, 'h5y4tn5i'], [2, 'u'], [3, 'u'], [4, 'u']]);
    expect(officialGuideCount({ guides: 4, manSlots })).toBe(1);
    expect(assetPresent(game('SNES', { manual: 'has', guides: 4, manSlots, manuals: FOUR_DOCS }), 'manual')).toBe(false);
  });

  it('does not let a map naming vanished slots pass either', () => {
    // The ficha claims four documents; the card only holds two files (one was deleted behind our back).
    const manSlots = new Map([[0, 'a1'], [2, 'b2'], [3, 'c3'], [4, 'd4']]);
    expect(officialGuideCount({ guides: 2, manSlots })).toBe(2);
  });

  it('reads the remaining categories off their own field', () => {
    expect(assetPresent(game('GB', { snapshot: 'has' }), 'tela')).toBe(true);
    expect(assetPresent(game('GB', { fmv: 'has' }), 'previa')).toBe(true);
    expect(assetPresent(game('GB', { info: 'has' }), 'info')).toBe(true);
    expect(assetPresent(game('GB', { cheats: 'has' }), 'cheats')).toBe(true);
    // "available on the server" is not "on the card"
    expect(assetPresent(game('GB', { cheats: 'available' }), 'cheats')).toBe(false);
  });
});

/**
 * What the auto-fill dialog counts is what the run promises, so "available" has to be exactly what the
 * run can deliver. The preview is the sharp edge: auto-fill never encodes video (no ffmpeg, no mp4
 * download, those belong to the explicit per-game actions), so its only source is a ready `.fmv`
 * inside the game's `.s2pkg`.
 */
describe('assetAvailable', () => {
  it('does NOT offer a preview for a game the GameDB has a video for but no package', () => {
    // The regression this pins: counting it would put the row at "N to complete" on every single run,
    // with nothing auto-fill is allowed to do about it.
    expect(assetAvailable(game('SNES', { videoUrl: 'https://cdn/x.mp4' }), 'previa')).toBe(false);
  });

  it('offers a preview only when there is BOTH a video and a built package', () => {
    expect(assetAvailable(game('SNES', { packageUrl: 'https://cdn/x.s2pkg' }), 'previa')).toBe(false); // no video → no clip in it
    expect(assetAvailable(game('SNES', { videoUrl: 'https://cdn/x.mp4', packageUrl: 'https://cdn/x.s2pkg' }), 'previa')).toBe(true);
  });

  it('leaves the OTHER categories on their own sources — only the preview needs a package', () => {
    expect(assetAvailable(game('SNES', { coverUrl: 'https://cdn/x.png' }), 'capa')).toBe(true);
    expect(assetAvailable(game('SNES', { cover: 'has' }), 'capa')).toBe(true);      // .gcv derived from the on-card .cov
    expect(assetAvailable(game('SNES', { screenshotUrl: 'https://cdn/x.png' }), 'tela')).toBe(true);
    expect(assetAvailable(game('SNES', { matched: true }), 'info')).toBe(true);
    expect(assetAvailable(game('SNES', { cheats: 'available' }), 'cheats')).toBe(true);
    expect(assetAvailable(game('SNES', { manualUrl: 'https://cdn/x.man' }), 'manual')).toBe(true);
  });

  it('does not count a manual the GameDB lists but cannot serve', () => {
    expect(assetAvailable(game('SNES', { manuals: [{ manualUrl: null }] as Entry['manuals'] }), 'manual')).toBe(false);
  });

  it('never says available for a game with nothing at all', () => {
    const bare = game('SNES');
    for (const c of ['capa', 'tela', 'previa', 'info', 'cheats', 'manual'] as FillCategory[]) {
      expect(assetAvailable(bare, c)).toBe(false);
    }
  });
});

/**
 * The set the auto-fill pre-run GameDB refresh is allowed to cost.
 *
 * The bug this pins: the refresh used to run over the whole scope whenever any category was on
 * Atualizar/Substituir. On a 6392-game card asked for 3 cheats, the run sat on "Identificando...
 * 3301/6392" (thousands of card reads and lookups) before writing 859 KB. A game the plan cannot
 * touch cannot have its outcome changed by a fresher token, so it has no business in that pass.
 */
describe('needsGamedbRefresh', () => {
  const OFF: FillPlan = { capa: 'off', tela: 'off', previa: 'off', info: 'off', cheats: 'off', manual: 'off' };

  /* The invariant the narrowing rests on, pinned as a matrix instead of by reading fillModeActs:
     anything the dialog promises to act on must be in the refresh. Break the ladder (say, let
     'replace' act without a source) and the run would promise games the refresh never freshened.
     the silent no-op this whole fix exists to kill. */
  it('covers every (mode × present × available) the plan would act on', () => {
    for (const mode of ['update', 'replace'] as const) {
      for (const present of [true, false]) {
        for (const available of [true, false]) {
          const g = game('SNES', { cheats: present ? 'has' : available ? 'available' : 'none' });
          // `stale` both ways: 'replace' acts on a current asset too, and that is precisely the row
          // whose outcome a fresher token can change.
          for (const stale of [true, false]) {
            if (!fillModeActs(mode, { available: available || present, present, stale })) continue;
            expect(needsGamedbRefresh(g, { ...OFF, cheats: mode })).toBe(true);
          }
        }
      }
    }
  });

  it('FILL_CATS stays exhaustive over FillPlan', () => {
    // A 7th category added to FillPlan would silently drop out of the refresh (and out of p1),
    // exactly the class of silent no-op this fix removes.
    expect([...FILL_CATS].sort()).toEqual(Object.keys(OFF).sort());
  });

  it('asks for nothing when no category is on Atualizar/Substituir', () => {
    // Completar only writes what is MISSING, it never compares tokens, so cached answers are enough.
    const rich = game('SNES', { cover: 'has', gcv: 'has', cheats: 'has', info: 'has', matched: true });
    expect(needsGamedbRefresh(rich, OFF)).toBe(false);
    expect(needsGamedbRefresh(rich, { ...OFF, capa: 'complete', cheats: 'complete' })).toBe(false);
  });

  it('takes the game whose asset is ON THE CARD — that is where the token compare runs', () => {
    // The silent no-op the pass exists to prevent: a cached match carries the token the server had when
    // it was cached, so "outdated" is judged against yesterday's server and finds nothing.
    expect(needsGamedbRefresh(game('SNES', { cheats: 'has' }), { ...OFF, cheats: 'update' })).toBe(true);
  });

  it('takes the game the GameDB can SUPPLY — the run may write it', () => {
    expect(needsGamedbRefresh(game('SNES', { cheats: 'available' }), { ...OFF, cheats: 'update' })).toBe(true);
    expect(needsGamedbRefresh(game('SNES', { coverUrl: 'https://cdn/x.png' }), { ...OFF, capa: 'replace' })).toBe(true);
  });

  it('leaves out the game with neither — that is the TTL\'s job, not this pass\'s', () => {
    // A cover that appeared upstream for a game the cache says has nothing is real, but catching it
    // belongs to the gamedb cache TTL and the explicit "Atualizar dados do GameDB" button. Paying for it
    // here is what made a 3-file run walk the whole library.
    expect(needsGamedbRefresh(game('SNES'), { ...OFF, capa: 'update' })).toBe(false);
    expect(needsGamedbRefresh(game('SNES'), { ...OFF, capa: 'replace', cheats: 'replace', manual: 'replace' })).toBe(false);
  });

  it('only looks at the categories the plan actually acts on', () => {
    // A library full of covers must not be dragged in by a plan that only touches cheats.
    const cover = game('SNES', { cover: 'has', gcv: 'has', coverUrl: 'https://cdn/x.png' });
    expect(needsGamedbRefresh(cover, { ...OFF, cheats: 'update' })).toBe(false);
    expect(needsGamedbRefresh(cover, { ...OFF, capa: 'update' })).toBe(true);
  });

  it('is the union over the acting categories — one match is enough', () => {
    const onlyInfo = game('SNES', { info: 'has', matched: true });
    expect(needsGamedbRefresh(onlyInfo, { ...OFF, capa: 'update', tela: 'update', info: 'update' })).toBe(true);
  });

  it("never takes a game for a category the plan can't satisfy anyway", () => {
    // previa needs both a video and a built package (assetAvailable), and nothing on card → skip it.
    const noPkg = game('SNES', { videoUrl: 'https://cdn/x.mp4' });
    expect(needsGamedbRefresh(noPkg, { ...OFF, previa: 'replace' })).toBe(false);
  });

  it("shrinks the user's case to the games that can actually change", () => {
    // 6392 games, Cheats=Atualizar: only the ones with cheats on card (or offered by the GameDB) are
    // candidates. The rest of the library is not read, not looked up, not counted.
    const lib = [
      ...Array.from({ length: 1220 }, () => game('SNES', { cheats: 'has' })),        // on card → token compare
      ...Array.from({ length: 40 }, () => game('SNES', { cheats: 'available' })),    // server has some → writable
      ...Array.from({ length: 5132 }, () => game('SNES', { cover: 'has', gcv: 'has' })), // nothing to do with cheats
    ];
    const plan: FillPlan = { ...OFF, cheats: 'update' };
    expect(lib.filter((g) => needsGamedbRefresh(g, plan)).length).toBe(1260);
  });
});

describe('matchesStatus', () => {
  // A game with a bit of everything, so each pair below is decided by its own field.
  const rich = game('SNES', {
    cover: 'has', gcv: 'has', snapshot: 'has', fmv: 'has',
    info: 'has', cheats: 'has', guides: 1, matched: true,
  });
  const bare = game('SNES');

  it('makes every has-X the exact negation of its missing-X', () => {
    // This is the property that keeps a cell's two halves adding up to the row total, if the two
    // predicates ever drift, the board starts lying about one of the sides.
    for (const col of BOARD_COLS) {
      for (const g of [rich, bare]) {
        expect(matchesStatus(g, col.statusHas)).toBe(!matchesStatus(g, col.status));
      }
    }
  });

  it('routes each column to its own asset', () => {
    expect(matchesStatus(rich, 'has-info')).toBe(true);
    expect(matchesStatus(bare, 'has-info')).toBe(false);
    expect(matchesStatus(bare, 'missing-info')).toBe(true);

    // guides counts any .man slot, so one user guide satisfies it
    expect(matchesStatus(game('NES', { guides: 1 }), 'has-guides')).toBe(true);
    expect(matchesStatus(game('NES', { guides: 0 }), 'has-guides')).toBe(false);
  });

  it('keeps the capa rule (.cov AND .gcv) on both sides', () => {
    const covOnly = game('SNES', { cover: 'has' });
    expect(matchesStatus(covOnly, 'has-cover')).toBe(false);
    expect(matchesStatus(covOnly, 'missing-cover')).toBe(true);
  });

  it('passes everything through for "all", and handles unmatched', () => {
    expect(matchesStatus(bare, 'all')).toBe(true);
    expect(matchesStatus(rich, 'all')).toBe(true);
    expect(matchesStatus(bare, 'unmatched')).toBe(true);
    expect(matchesStatus(rich, 'unmatched')).toBe(false);
  });
});

describe('tallyBoard', () => {
  it('counts missing per system and per column', () => {
    const rows = tallyBoard([
      game('SNES', { cover: 'has', gcv: 'has', snapshot: 'has' }),
      game('SNES', { cover: 'has', gcv: 'has' }),
      game('SNES'),
      game('NES', { snapshot: 'has' }),
    ]);

    const snes = rows.find((r) => r.system === 'SNES')!;
    expect(snes.total).toBe(3);
    expect(snes.cells.capa).toEqual({ have: 2, missing: 1, pct: 67 });
    expect(snes.cells.tela).toEqual({ have: 1, missing: 2, pct: 33 });
    expect(snes.cells.previa.missing).toBe(3);

    const nes = rows.find((r) => r.system === 'NES')!;
    expect(nes.total).toBe(1);
    expect(nes.cells.tela.missing).toBe(0);
    expect(nes.cells.capa.missing).toBe(1);
  });

  it('lists only systems present on the card, in canonical order', () => {
    const rows = tallyBoard([game('SMS'), game('SNES'), game('GB')]);
    expect(rows.filter((r) => r.system).map((r) => r.system)).toEqual(['SNES', 'GB', 'SMS']);
  });

  it('appends a TOTAL row only when there is more than one system', () => {
    const one = tallyBoard([game('SNES'), game('SNES')]);
    expect(one.some((r) => r.system === null)).toBe(false);

    const two = tallyBoard([game('SNES', { info: 'has' }), game('GB')]);
    const total = two.find((r) => r.system === null)!;
    expect(total.total).toBe(2);
    expect(total.cells.info).toEqual({ have: 1, missing: 1, pct: 50 });
  });

  it('returns nothing for an empty card', () => {
    expect(tallyBoard([])).toEqual([]);
  });
});
