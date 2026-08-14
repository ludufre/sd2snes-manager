import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { LangService } from '../../../core/lang.service';
import type { DescLang, Descriptions, Entry } from '../../../core/models';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { DESC_LANGS } from '../../../lib/yml.js';
/** yml.js is untyped JS: pin its language list to the DescLang union here. */
const DESC_LANG_LIST = DESC_LANGS as readonly DescLang[];
import { GAMEDB_WEB } from '../../../core/env';
import { fmtSize } from '../../../core/format';
import { Icon } from '../../../ui/icon/icon';
import { CoverArt } from '../../../ui/cover-art/cover-art';
import { Toggle } from '../../../ui/toggle/toggle';
import { SnesComboEditor } from '../../../ui/snes-combo-editor/snes-combo-editor';
import { FmvPlayer } from '../../../ui/fmv-player/fmv-player';
import { decodeGdRegions } from '../../../lib/gd.js';
import { decodeFmvFrame, composeCgram } from '../../../lib/bandpal.js';

/** Game-info fields (mirrors the `.yml` keys buildYml writes). Read-only here. `description` is the
 *  canonical English text; `descriptions` holds the per-language translations the console picks from. */
interface Ficha {
  title: string;
  developer: string;
  release_year: string;
  players: string;
  genre: string;
  special_chip: string;
  description: string;
  descriptions: Descriptions;
  gamedb_id: string;
}
const EMPTY_FICHA: Ficha = { title: '', developer: '', release_year: '', players: '', genre: '', special_chip: '', description: '', descriptions: {}, gamedb_id: '' };

/** Right-hand detail panel: on-card media (cover/snapshot/video), ficha editor, cheats, danger zone.
 *  Rendered inline in split view, or as a slide-over drawer in list/gallery. */
@Component({
  selector: 'app-detail-panel',
  imports: [Icon, CoverArt, Toggle, FmvPlayer, SnesComboEditor, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './detail-panel.html',
  styleUrl: './detail-panel.scss',
})
export class DetailPanel {
  protected readonly lib = inject(LibraryStore);
  private readonly i18n = inject(TranslocoService);
  private readonly langs = inject(LangService);
  readonly drawer = input(false);
  protected readonly fmtSize = fmtSize;

  protected readonly canRename = computed(() => {
    const g = this.lib.sel();
    if (!g) return false;
    return g.matched && g.file !== g.title + '.' + g.file.split('.').pop();
  });

  /** Friendly console name for the header/preview (no "SNES" jargon). */
  protected readonly systemName = computed(() => {
    switch (this.lib.sel()?.system) {
      case 'SNES': return 'Super Nintendo';
      case 'GBC': return 'Game Boy Color';
      case 'SGB': return 'Super Game Boy';
      case 'GB': return 'Game Boy';
      case 'NES': return 'Nintendo Entertainment System';
      case 'SMS': return 'Master System';
      default: return '';
    }
  });

  /** "Produtora · Ano · Gênero" line under the console preview (falls back to the console name). */
  // On-card .fmv/.pcm bytes for the preview player.
  protected readonly fmvBytes = signal<Uint8Array | null>(null);
  protected readonly pcmBytes = signal<Uint8Array | null>(null);
  // On-card snapshot (the SHOT_BOX region of the .gd), decoded for display; null when blank.
  protected readonly cardSnapshot = signal<string | null>(null);
  // The real cover image (decoded .cov thumbnail), shown at its natural aspect in the showcase.
  protected readonly coverSrc = computed(() => this.lib.sel()?.thumbUrl ?? null);
  // Ficha (.yml), read-only here; editing happens in the InfoEditor modal.
  protected readonly ficha = signal<Ficha>(EMPTY_FICHA);
  protected readonly stateInputs = signal<{ checksum: string; save: string; load: string } | null>(null);
  protected readonly stateInputsLoading = signal(false);
  protected readonly stateInputsSaving = signal(false);
  protected readonly stateInputsStatus = signal<'saved' | 'error' | null>(null);
  protected readonly editingStateInput = signal<'save' | 'load' | null>(null);
  private stateInputsKey = '';

  /** Only one of the two combos filled in. The firmware's strtok(";, \t") skips leading
   *  delimiters, so an entry written as ",SL" is read back as the SAVE combo: block the write
   *  instead of storing something that means the opposite on the card. */
  protected readonly stateInputsPartial = computed(() => {
    const inputs = this.stateInputs();
    return !!inputs && (inputs.save === '') !== (inputs.load === '');
  });

  /** A one-button combo is held constantly during normal play, so it fires on its own. */
  protected readonly stateInputsShort = computed(() => {
    const inputs = this.stateInputs();
    return !!inputs && [inputs.save, inputs.load].some((combo) => combo.length === 1);
  });

  /** Filled metadata fields for the read-only summary (empties dropped). */
  protected readonly infoRows = computed(() => {
    this.langs.ready(); // translate() is not a signal, see LangService.ready
    const f = this.ficha();
    return [
      { k: this.i18n.translate('detail.fieldPublisher'), v: f.developer },
      { k: this.i18n.translate('detail.fieldYear'), v: f.release_year },
      { k: this.i18n.translate('detail.fieldPlayers'), v: f.players },
      { k: this.i18n.translate('detail.fieldGenre'), v: f.genre },
      { k: this.i18n.translate('detail.fieldSpecialChip'), v: f.special_chip },
    ].filter((r) => (r.v ?? '').trim());
  });
  /** The description as this app's language would read it, the translation when the ficha carries one,
   *  English otherwise. Exactly the choice the console makes for its own menu language (gameinfo.c
   *  gi_desc_lang_key), so the panel previews what a console set to this language will show. */
  protected readonly descText = computed(() => {
    const f = this.ficha();
    return (f.descriptions[this.langs.lang() as DescLang] || f.description || '').trim();
  });
  protected readonly hasInfo = computed(() => this.infoRows().length > 0 || !!this.descText());
  /** GameDB id for the "Ver no GameDB" link: from the live match, else from the on-card .yml (so the
   *  link shows for games that were filled but not re-identified this session). */
  protected readonly linkGamedbId = computed(() => this.lib.sel()?.gamedbId || this.ficha().gamedb_id || null);

  // Guards so the async loads below only re-run on real changes, not on every entry mutation.
  // (During "[cov] fetch cover" the selected entry is replaced repeatedly; without these the ficha
  //  would reset to empty and flicker on each update.)
  private mediaKey = '';
  private fichaKey = '';

  constructor() {
    // Media (cover thumb + snapshot + fmv): reload only when the game or its on-card media changes.
    // infoRev is bumped after a .gd/.yml write (e.g. "Preencher tudo"), so the snapshot re-reads then.
    effect(() => {
      const g = this.lib.sel();
      const key = g ? `${g.id}#${g.cover}#${g.fmv ?? ''}#${this.lib.infoRev()}` : '';
      if (key === this.mediaKey) return;
      this.mediaKey = key;
      this.fmvBytes.set(null);
      this.pcmBytes.set(null);
      this.cardSnapshot.set(null);
      if (!g) return;
      const id = g.id;

      // Decode the .cov thumbnail so the showcase can show the real cover at its natural aspect.
      void this.lib.ensureThumb(g);

      if (g.fmv === 'has') {
        void this.lib.readFmvBytes(g).then((d) => {
          if (d && this.lib.sel()?.id === id) {
            this.fmvBytes.set(d.fmv);
            this.pcmBytes.set(d.pcm);
          }
        });
      }

      // Snapshot tile: prefer the standalone `.gss` (paletted, 1 frame, what the app writes now);
      // fall back to the legacy `.gd` shot region for cards written by older builds.
      void this.lib.readGssBytes(g).then((gss) => {
        if (this.lib.sel()?.id !== id) return;
        const url = gss ? this.gssToUrl(gss) : null;
        if (url) { this.cardSnapshot.set(url); return; }
        void this.lib.readGdBytes(g).then((gd) => {
          if (this.lib.sel()?.id !== id || !gd) return;
          try { this.cardSnapshot.set(decodeGdRegions(gd).snapshotUrl); } catch { /* leave snapshot empty */ }
        });
      });
    });

    effect(() => {
      const g = this.lib.sel();
      const key = g?.system === 'SNES' && g.fileHandle ? g.id : '';
      if (key === this.stateInputsKey) return;
      this.stateInputsKey = key;
      this.stateInputs.set(null);
      this.stateInputsStatus.set(null);
      this.editingStateInput.set(null);
      if (!key || !g) return;
      this.stateInputsLoading.set(true);
      void this.lib.readSavestateInputs(g).then((value) => {
        if (this.lib.sel()?.id === key) this.stateInputs.set(value);
      }).catch(() => {
        if (this.lib.sel()?.id === key) this.stateInputs.set(null);
      }).finally(() => {
        if (this.lib.sel()?.id === key) this.stateInputsLoading.set(false);
      });
    });

    // Ficha (.yml metadata): reload only when the selected game changes or an edit is saved (infoRev),
    // never on cover/thumb/busy updates, so the info doesn't flicker while covers are being fetched.
    effect(() => {
      const g = this.lib.sel();
      const rev = this.lib.infoRev();
      const key = g ? `${g.id}#${rev}` : '';
      if (key === this.fichaKey) return;
      this.fichaKey = key;
      this.ficha.set(EMPTY_FICHA);
      if (!g) return;
      const id = g.id;
      void this.lib.readInfoYml(g).then((yml) => {
        const cur = this.lib.sel();
        if (cur?.id === id) this.ficha.set(this.fichaFrom(cur, yml));
      });
    });
  }

  /** Decode a standalone `.gss` (paletted, 1 frame) into a data URL for the snapshot tile. Mirrors the
   *  fmv-player's frame draw: frame palette → CGRAM 168.., index plane → rgba. null on a non-`.gss`. */
  private gssToUrl(bytes: Uint8Array): string | null {
    try {
      const { h, pal, plane } = decodeFmvFrame(bytes, 0);
      const W = h.boxW * 8, H = h.boxH * 8;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      const img = ctx.createImageData(W, H);
      const d = img.data;
      const cgram = composeCgram(null, pal);
      for (let i = 0; i < W * H; i++) {
        const c = cgram[plane[i]], o = i * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return cv.toDataURL();
    } catch { return null; }
  }

  private fichaFrom(g: Entry, yml: Record<string, string> | null): Ficha {
    return {
      title: yml?.['title'] ?? g.title ?? '',
      developer: yml?.['developer'] ?? g.developer ?? '',
      release_year: yml?.['release_year'] ?? (g.releaseYear != null ? String(g.releaseYear) : ''),
      players: yml?.['players'] ?? g.players ?? '',
      genre: yml?.['genre'] ?? g.genre ?? '',
      special_chip: yml?.['special_chip'] ?? g.specialChip ?? '',
      description: yml?.['description'] ?? g.description ?? '',
      // per-language: the on-card `.yml` wins (that is what the console will actually read), the
      // GameDB match fills in for a game whose ficha has not been written yet
      descriptions: Object.fromEntries(
        DESC_LANG_LIST.map((l) => [l, yml?.[`description_${l}`] ?? g.descriptions?.[l] ?? '']).filter(([, v]) => v),
      ) as Descriptions,
      gamedb_id: g.gamedbId ?? yml?.['gamedb_id'] ?? '',
    };
  }

  protected close(): void {
    this.lib.closeDetail();
  }

  protected applyStateInput(value: string): void {
    const field = this.editingStateInput();
    if (field) this.stateInputs.update((current) => current ? { ...current, [field]: value } : current);
    this.editingStateInput.set(null);
    this.stateInputsStatus.set(null);
  }

  protected async saveStateInputs(): Promise<void> {
    const value = this.stateInputs();
    const game = this.lib.sel();
    if (!value || !game || this.stateInputsPartial()) return;
    this.stateInputsSaving.set(true);
    const saved = await this.lib.saveSavestateInputs(value.checksum, value.save, value.load, game.title || game.file).catch(() => false);
    this.stateInputsStatus.set(saved ? 'saved' : 'error');
    this.stateInputsSaving.set(false);
  }

  protected comboLabel(value: string): string {
    if (!value) return this.i18n.translate('detail.stateInputsNotSet');
    const names: Record<string, string> = { s:'select', S:'start', u:'up', d:'down', l:'left', r:'right', L:'L', R:'R', a:'A', b:'B', x:'X', y:'Y' };
    return [...value].map((key) => this.i18n.translate(`config.buttons.${names[key] ?? key}`)).join(' + ');
  }

  /** Link to the game's canonical GameDB page. */
  protected gamedbUrl(gamedbId: string): string {
    return `${GAMEDB_WEB}/games/${encodeURIComponent(gamedbId)}`;
  }
  /** Deep link to the GameDB "report inconsistency" (submit) screen, prefilled. */
  protected reportUrl(gamedbId: string, type: string): string {
    return `${GAMEDB_WEB}/submit?game=${encodeURIComponent(gamedbId)}&type=${type}`;
  }
  /** When the ROM isn't in the GameDB, report it as a missing game. */
  protected newGameUrl(): string {
    return `${GAMEDB_WEB}/submit?type=new_game`;
  }
}
