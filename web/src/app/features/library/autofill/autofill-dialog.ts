import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LangService } from '../../../core/lang.service';
import { ViewportService } from '../../../core/viewport.service';
import { LibraryStore, type FillCounts } from '../../../core/library-store';
import { fmtEta } from '../../../core/format';
import type { CoverRegion } from '../../../core/cover-region';
import type { FillCategory, FillMode, FillPlan } from '../../../core/models';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { REGION_FLAGS } from '../../../lib/regions.js';
import { Icon, type IconName } from '../../../ui/icon/icon';

interface Row { key: FillCategory; labelKey: string; summaryKey: string; icon: IconName; color: string; }
const ROWS: readonly Row[] = [
  { key: 'capa', labelKey: 'autofill.rowCover', summaryKey: 'autofill.summaryCover', icon: 'image', color: 'var(--accent)' },
  { key: 'tela', labelKey: 'autofill.rowSnapshot', summaryKey: 'autofill.summarySnapshot', icon: 'monitor', color: 'var(--info)' },
  { key: 'previa', labelKey: 'autofill.rowPreview', summaryKey: 'autofill.summaryPreview', icon: 'film', color: '#ff5c8a' },
  { key: 'info', labelKey: 'autofill.rowInfo', summaryKey: 'autofill.summaryInfo', icon: 'info', color: 'var(--tx-mid)' },
  { key: 'cheats', labelKey: 'autofill.rowCheats', summaryKey: 'autofill.summaryCheats', icon: 'cheats', color: 'var(--ok)' },
  // Official GameDB manual (`.man`, ready w/ zoom) → written to card slot 0. Distinct from the
  // user-supplied guides (slots 2..8, GuidesEditor). Those are never touched by auto-fill.
  { key: 'manual', labelKey: 'autofill.rowManual', summaryKey: 'autofill.summaryManual', icon: 'book', color: '#c98cff' },
];
/** The modes are a ladder, each covers everything the previous one does, plus more (see FillMode):
 *  off ⊂ complete (missing) ⊂ update (missing + outdated) ⊂ replace (every game with a source). */
const MODES: readonly { v: FillMode; lKey: string; hKey: string }[] = [
  { v: 'off', lKey: 'autofill.modeOff', hKey: 'autofill.modeOffHint' },
  { v: 'complete', lKey: 'autofill.modeComplete', hKey: 'autofill.modeCompleteHint' },
  { v: 'update', lKey: 'autofill.modeUpdate', hKey: 'autofill.modeUpdateHint' },
  { v: 'replace', lKey: 'autofill.modeReplace', hKey: 'autofill.modeReplaceHint' },
];

/** Which region's cover a World dump gets. Only the cover follows this: the ROM's own region still
 *  decides the title, the snapshot, the clip and the manuals. `null` is "no preference", i.e. exactly
 *  what the GameDB's own package already carries. */
const COVER_REGIONS: readonly { v: CoverRegion; flag: string; lKey: string }[] = [
  { v: null, flag: '🌍', lKey: 'autofill.coverRegionAuto' },
  { v: 'U', flag: REGION_FLAGS['U'], lKey: 'autofill.coverRegionU' },
  { v: 'E', flag: REGION_FLAGS['E'], lKey: 'autofill.coverRegionE' },
  { v: 'J', flag: REGION_FLAGS['J'], lKey: 'autofill.coverRegionJ' },
];

/** "Preencher automaticamente", analisa o que já existe na seleção e deixa escolher, por categoria,
 *  entre Não mexer / Completar (só faltantes) / Substituir (todos). Dispara `lib.runAutoFill(plan)`. */
@Component({
  selector: 'app-autofill-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let st = lib.autoFill();
    @if (st) {
      <div class="scrim" (click)="lib.closeAutoFill()"></div>
      <div class="card">
        <div class="head">
          <h3>{{ 'autofill.title' | transloco }}</h3>
          <p class="sub">{{ (st.total === 1 ? 'autofill.subOne' : 'autofill.subMany') | transloco: { count: st.total } }}</p>
        </div>

        @if (st.analyzing || !st.counts) {
          @let r = lib.autoFillRate();
          <div class="analyzing">
            <div class="azhead"><span class="spin"></span> {{ 'autofill.analyzing' | transloco }}
              @if (st.analyzeTotal) { <span class="azcount">{{ st.done ?? 0 }} / {{ st.analyzeTotal }}</span> }
            </div>
            @if (st.analyzeTotal) {
              <div class="azbar"><div class="azfill" [style.width.%]="azPct(st.done ?? 0, st.analyzeTotal)"></div></div>
              @if (r) { <span class="azeta">{{ 'bulkbar.rate' | transloco: { perSec: r.perSec.toFixed(1), eta: fmtEta(r.etaSec) } }}</span> }
            }
          </div>
        } @else {
          <div class="body">
          <div class="rows">
            @for (r of rows; track r.key) {
              <div class="row">
                <span class="ico" [style.color]="r.color"><app-icon [name]="r.icon" [size]="16" /></span>
                <span class="lbl">{{ r.labelKey | transloco }}
                  @if (rowEst(r.key); as e) { <small class="est">{{ e }}</small> }
                </span>
                <span class="cnt">[{{ st.counts.present[r.key] }}/{{ st.total }}]@if (st.counts.stale[r.key] > 0) {<span class="stale" [title]="'autofill.staleHint' | transloco">· {{ st.counts.stale[r.key] }}⟳</span>}</span>
                <!-- Four segments per row, six rows: on a phone that is a 2x2 grid per category and the
                     dialog stops fitting the screen. The native picker collapses each one to a single
                     line, and on Android it opens the system list, which is a better target than an
                     11px segment anyway. -->
                @if (vp.phone()) {
                  <!-- selected on the option, not value on the select: the options are created by the
                       @for AFTER the select's own bindings run, so a value binding lands on an empty
                       list and the control silently falls back to showing the first option. -->
                  <select class="jump" [attr.aria-label]="r.labelKey | transloco"
                          (change)="setMode(r.key, $any($event.target).value)">
                    @for (m of modes; track m.v) {
                      <option [value]="m.v" [selected]="plan()[r.key] === m.v" [disabled]="modeDisabled(r.key, m.v)">{{ m.lKey | transloco }}</option>
                    }
                  </select>
                } @else {
                  <div class="seg">
                    @for (m of modes; track m.v) {
                      <button
                        type="button" [class.on]="plan()[r.key] === m.v" [title]="m.hKey | transloco"
                        [disabled]="modeDisabled(r.key, m.v)"
                        (click)="setMode(r.key, m.v)">{{ m.lKey | transloco }}</button>
                    }
                  </div>
                }
              </div>
            }
          </div>

          <!-- Cover region: only a ROM with more than one legitimate region can be moved, so a library
               without one never sees this.
               Deliberately NOT gated on the Capas mode: with every cover already in sync that row
               sits at "Não mexer", and hiding the control there would hide it exactly when someone
               wants to change their mind about the region. Picking one re-tallies, the covers read as
               stale, and the Capas row lights up on its own. -->
          @if (st.counts.coverChoice > 0) {
            <div class="opt">
              <span class="ico" style="color: var(--accent)"><app-icon name="image" [size]="16" /></span>
              <span class="lbl">{{ 'autofill.coverRegion' | transloco }}
                <small class="est">{{ coverRegionHint(st.counts) }}</small>
              </span>
              @if (vp.phone()) {
                <select class="jump" [attr.aria-label]="'autofill.coverRegion' | transloco"
                        (change)="pickCoverRegion($any($event.target).value)">
                  @for (c of coverRegions; track c.lKey) {
                    <option [value]="c.v ?? ''" [selected]="lib.coverRegion() === c.v">{{ c.flag }} {{ c.lKey | transloco }}</option>
                  }
                </select>
              } @else {
                <div class="seg">
                  @for (c of coverRegions; track c.lKey) {
                    <button
                      type="button" [class.on]="lib.coverRegion() === c.v" [title]="'autofill.coverRegionOnlyCover' | transloco"
                      (click)="lib.setCoverRegion(c.v)">{{ c.flag }} {{ c.lKey | transloco }}</button>
                  }
                </div>
              }
            </div>
          }

          @if (plan().previa !== 'off') {
            <label class="audio">
              <input type="checkbox" [checked]="previaAudio()" (change)="previaAudio.set($any($event.target).checked)" />
              <span>{{ 'autofill.audioInclude' | transloco }}</span>
            </label>
            @if (previaAudio()) { <p class="disclaimer">⚠ {{ 'autofill.audioDisclaimer' | transloco }}</p> }
          }
          @if (plan().manual !== 'off') { <p class="disclaimer">⚠ {{ 'autofill.manualDisclaimer' | transloco }}</p> }
          </div>

          <div class="foot">
            <p class="plan">{{ planSummary() }}
              @if (totalEst(); as t) { <span class="total">≈ {{ t }}</span> }
            </p>
            <div class="actions">
              <button class="btn" type="button" (click)="lib.closeAutoFill()">{{ 'autofill.cancel' | transloco }}</button>
              <button class="btn primary" type="button" [disabled]="nothing()" (click)="run()">{{ 'autofill.fill' | transloco }}</button>
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 70; animation: fade 0.15s ease; }
    @keyframes fade { from { opacity: 0; } }
    /* A column with a scrolling middle, the same shape identify-dialog uses. Without it a six-category
       plan plus the region control and two disclaimers simply ran off a short screen: the title went
       above the viewport and Preencher below it, with no way to reach either. Head and foot stay put
       so the estimate and the buttons are always on screen. */
    .card {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(600px, 94vw); max-height: 88dvh; display: flex; flex-direction: column; overflow: hidden;
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); animation: pop 0.16s ease;
    }
    .head { padding: 22px 22px 0; }
    .body { overflow-y: auto; padding: 16px 22px 0; }
    .foot { padding: 0 22px 22px; }
    @keyframes pop { from { transform: translate(-50%, -46%); opacity: 0; } }
    h3 { margin: 0 0 2px; font-size: 16px; letter-spacing: -0.2px; }
    .sub { margin: 0; color: var(--tx-low); font-size: 12px; font-family: var(--mono); }
    .analyzing { display: flex; flex-direction: column; gap: 10px; color: var(--tx-mid); font-size: 13px; padding: 18px 22px 22px; }
    .azhead { display: flex; align-items: center; gap: 10px; }
    .azcount { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
    .azbar { height: 6px; border-radius: 4px; background: var(--line); overflow: hidden; }
    .azfill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.2s ease; }
    .azeta { font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
    .spin { width: 15px; height: 15px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: sp 0.7s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .rows { display: flex; flex-direction: column; gap: 8px; }
    /* Same three-column shape as .row, but set apart: it is not a category with a mode, it qualifies
       the Capas row above it. */
    .opt { display: grid; grid-template-columns: 20px 1fr auto; align-items: center; gap: 8px;
           margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
    .opt .lbl { font-size: 13px; color: var(--tx); }
    .row { display: grid; grid-template-columns: 20px 1fr auto auto; align-items: center; gap: 8px; }
    .ico { display: inline-grid; place-items: center; }
    .lbl { font-size: 13px; color: var(--tx); }
    .lbl .est { display: block; font-size: 11px; color: var(--tx-low); font-family: var(--mono); margin-top: 1px; }
    .plan .total { display: block; margin-top: 5px; font-family: var(--mono); font-size: 12px; color: var(--tx-mid); }
    .audio { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 12px; color: var(--tx-mid); cursor: pointer; user-select: none; }
    .audio input { accent-color: var(--accent); width: 14px; height: 14px; }
    .disclaimer { margin: 8px 0 0; padding: 8px 10px; font-size: 11.5px; line-height: 1.45; color: #e6a23c; background: rgba(230, 162, 60, 0.1); border: 1px solid rgba(230, 162, 60, 0.3); border-radius: 8px; }
    .cnt { font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
    .cnt .stale { margin-left: 4px; color: #e6a23c; cursor: help; }
    .seg { display: flex; gap: 2px; flex-wrap: wrap; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 2px; }
    .seg button {
      border: 0; background: transparent; color: var(--tx-mid); font-size: 11px; padding: 4px 8px;
      border-radius: 7px; cursor: pointer; transition: 0.12s; white-space: nowrap;
    }
    .seg button.on { background: var(--elevated); color: var(--tx); }
    .seg button:disabled { opacity: 0.3; cursor: default; }
    /* Phone-only replacement for .seg. Same box language as the config dialog's fields. */
    .jump {
      box-sizing: border-box; max-width: 100%; padding: 6px 8px; color: var(--tx); background: var(--bg);
      border: 1px solid var(--line); border-radius: 8px; font: 12px var(--sans);
    }

    /* Phone: icon + label + count + a four-way segmented control on one 338px row left the segments
       wrapping into a ragged 2x2 that no longer read as one control, and the rows stopped lining up
       with each other. The control gets a line of its own, indented under the label it belongs to. */
    /* The picker replaces the segmented control here (see the template), which is what lets a row stay
       one line again: the four modes used to wrap into a 2x2 grid that needed a line of its own under
       the label, and six of those did not fit a phone screen. The columns get tighter margins so the
       label still has room next to the count and the picker. */
    @media (max-width: 640px) {
      .head { padding: 16px 14px 0; }
      .body { padding: 12px 14px 0; }
      .foot { padding: 0 14px 16px; }
      .analyzing { padding: 18px 14px 16px; }
      .row, .opt { gap: 6px; }
      .lbl, .opt .lbl { font-size: 12px; min-width: 0; }
      .cnt { font-size: 11px; }
      /* The picker may shrink, the label yields first. Without a min-width the longest option
         ("Substituir") would set the column and squeeze the label to nothing. */
      .jump { min-width: 8.5em; }
      .opt { grid-template-columns: 20px 1fr auto; align-items: start; }
      .opt .lbl { padding-top: 1px; }
    }
    .plan { margin: 16px 0 14px; font-size: 12px; color: var(--tx-mid); line-height: 1.5; min-height: 1.2em; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  `,
})
export class AutoFillDialog {
  protected readonly lib = inject(LibraryStore);
  private readonly lang = inject(LangService);
  /** Phone or not. The segmented controls become native pickers below 640px, which is a decision the
   *  CSS cannot make on its own (it is a different control, not a different layout). */
  protected readonly vp = inject(ViewportService);
  private readonly i18n = inject(TranslocoService);
  protected readonly rows = ROWS;
  protected readonly modes = MODES; // always the four modes; each is per-row disabled when it has nothing to do
  protected readonly coverRegions = COVER_REGIONS;

  /** Categories the user has explicitly set. The plan re-derives its defaults whenever the analysis
   *  changes, and switching the cover region is now one of those changes (it moves `stale.capa`), so
   *  re-deriving must not silently undo a choice already made: turn "Prévias" off, pick a region, and
   *  the previews would come back on. A plain Set, not a signal: it is only ever read inside the
   *  computation below, and reading it as a dependency would make setMode and the linkedSignal fight
   *  over the same value. */
  private readonly touched = new Set<FillCategory>();

  /** Plano local, re-inicializado a cada análise concluída. Como "Atualizar" é cumulativo (faltantes +
   *  desatualizados), ele é o padrão sempre que houver algo desatualizado; havendo só faltantes, o padrão
   *  é "Completar"; sem nada a fazer, "Não mexer". */
  protected readonly plan = linkedSignal<FillCounts | null | undefined, FillPlan>({
    source: () => this.lib.autoFill()?.counts,
    computation: (c, prev) => {
      const def = (k: FillCategory): FillMode =>
        this.touched.has(k) && prev ? prev.value[k]
        : !c ? 'off' : c.stale[k] > 0 ? 'update' : c.missing[k] > 0 ? 'complete' : 'off';
      return {
        capa: def('capa'), tela: def('tela'), previa: def('previa'), info: def('info'), cheats: def('cheats'),
        manual: def('manual'),
      };
    },
  });

  /** The picker's empty option is "Automática": `<option [value]="null">` would serialise to the
   *  string "null", so the round trip goes through '' on both sides. */
  protected pickCoverRegion(v: string): void {
    this.lib.setCoverRegion((v || null) as CoverRegion);
  }

  protected setMode(cat: FillCategory, mode: FillMode): void {
    this.plan.update((p) => ({ ...p, [cat]: mode }));
    this.touched.add(cat);
  }

  /** How many games this mode would actually write in `cat`, the one definition behind the summary,
   *  the disabled state and the Fill button, so the dialog can't offer a choice that does nothing.
   *  Mirrors fillNeeds/fillModeActs: complete = missing, update = missing + stale, replace = available. */
  private modeCount(cat: FillCategory, mode: FillMode): number {
    const c = this.lib.autoFill()?.counts;
    if (!c || mode === 'off') return 0;
    return mode === 'replace' ? c.available[cat] : mode === 'update' ? c.missing[cat] + c.stale[cat] : c.missing[cat];
  }

  /** A mode button is disabled when it adds nothing over the mode before it on the ladder.
   *
   *  For 'complete'/'replace' that means "would write nothing". Note this is not "has no GameDB
   *  source": a category whose games are all already on the card has a source for every one of them,
   *  yet "Completar" has nothing left to complete, and offering it ended runs in "nada a fazer".
   *
   *  'update' is the subtler one: it's cumulative, so with nothing stale it writes exactly the same
   *  games as "Completar". Two buttons with identical effect read as a bug ("why is Atualizar
   *  available if the row shows no ⟳?"), so it's only offered when something is outdated. */
  protected modeDisabled(cat: FillCategory, mode: FillMode): boolean {
    if (mode === 'off') return false;
    const c = this.lib.autoFill()?.counts;
    if (mode === 'update') return !c || c.stale[cat] === 0;
    return this.modeCount(cat, mode) === 0;
  }

  /** Include the (big) audio track in previews. Off by default → previews download/write without
   *  the .pcm (small + fast); turning it on shows a slow-download disclaimer. */
  protected readonly previaAudio = signal(false);

  /** Nothing to run: every category is off, or the chosen modes add up to zero games. */
  protected readonly nothing = computed(() => {
    const p = this.plan();
    return ROWS.every((r) => this.modeCount(r.key, p[r.key]) === 0);
  });

  /** Estimativa do que será gerado (Completar = faltantes; Atualizar = faltantes + desatualizados;
   *  Substituir = todos c/ fonte). */
  protected readonly planSummary = computed(() => {
    this.lang.ready();
    const st = this.lib.autoFill();
    if (!st?.counts) return '';
    const p = this.plan();
    const parts: string[] = [];
    for (const r of ROWS) {
      const n = this.modeCount(r.key, p[r.key]);
      if (n > 0) parts.push(this.i18n.translate(r.summaryKey, { count: n }));
    }
    return parts.length
      ? this.i18n.translate('autofill.willGenerate', { items: parts.join(' · ') })
      : this.i18n.translate('autofill.nothingToGenerate');
  });

  /** Live size/time estimate for the current plan (re-runs when a mode toggles). */
  protected readonly est = computed(() => this.lib.fillEstimate(this.plan(), this.previaAudio()));
  /** Per-category "~size · ~time" (empty when that category is off / has nothing to do). */
  protected rowEst(cat: FillCategory): string {
    const e = this.est()?.rows[cat];
    return e ? `${this.fmtSize(e.bytes)} · ~${this.fmtDur(e.sec)}` : '';
  }
  /** Grand-total: download size (the per-game .s2pkg bundles) + write size + total time. */
  protected totalEst(): string {
    const e = this.est();
    if (!e || (!e.writeBytes && !e.downloadBytes)) return '';
    return this.i18n.translate('autofill.estTotal', {
      dl: this.fmtSize(e.downloadBytes), wr: this.fmtSize(e.writeBytes), t: this.fmtDur(e.totalSec),
    });
  }
  private fmtSize(bytes: number): string {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }
  private fmtDur(sec: number): string {
    const s = Math.round(sec);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  /** "N ROMs aceitam mais de uma capa · N capas mudariam de região", each half pluralised on its own.
   *  Two counts in one sentence, so a single `{{count}}` string cannot do it: with a one-game scope
   *  (the detail panel's "Preencher tudo") it read "1 ROMs ... 1 capas". Same one/many pair the
   *  dialog's own subOne / subMany already use. */
  protected coverRegionHint(counts: FillCounts): string {
    this.lang.ready();
    const t = (base: string, n: number): string =>
      this.i18n.translate(`autofill.${base}${n === 1 ? 'One' : 'Many'}`, { count: n });
    return `${t('coverRegionScope', counts.coverChoice)} · ${t('coverRegionMoved', counts.coverMoved)}`;
  }

  /** Analyze progress as a 0..100 width. */
  protected azPct(done: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  /** Human ETA: "45s" / "2m 05s", literally the bulk bar's (core/format). */
  protected readonly fmtEta = fmtEta;

  /** Confirming hands the run to the store, which raises the progress modal itself (see runAutoFill).
   * This dialog is already gone by then: `runAutoFill` clears `autoFill()` on its first line. */
  protected run(): void {
    this.lib.runAutoFill(this.plan(), this.previaAudio());
  }
}
