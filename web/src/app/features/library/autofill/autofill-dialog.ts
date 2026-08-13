import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LangService } from '../../../core/lang.service';
import { LibraryStore } from '../../../core/library-store';
import { fmtEta } from '../../../core/format';
import type { FillCategory, FillMode, FillPlan } from '../../../core/models';
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
        <h3>{{ 'autofill.title' | transloco }}</h3>
        <p class="sub">{{ (st.total === 1 ? 'autofill.subOne' : 'autofill.subMany') | transloco: { count: st.total } }}</p>

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
          <div class="rows">
            @for (r of rows; track r.key) {
              <div class="row">
                <span class="ico" [style.color]="r.color"><app-icon [name]="r.icon" [size]="16" /></span>
                <span class="lbl">{{ r.labelKey | transloco }}
                  @if (rowEst(r.key); as e) { <small class="est">{{ e }}</small> }
                </span>
                <span class="cnt">[{{ st.counts.present[r.key] }}/{{ st.total }}]@if (st.counts.stale[r.key] > 0) {<span class="stale" [title]="'autofill.staleHint' | transloco">· {{ st.counts.stale[r.key] }}⟳</span>}</span>
                <div class="seg">
                  @for (m of modes; track m.v) {
                    <button
                      type="button" [class.on]="plan()[r.key] === m.v" [title]="m.hKey | transloco"
                      [disabled]="modeDisabled(r.key, m.v)"
                      (click)="setMode(r.key, m.v)">{{ m.lKey | transloco }}</button>
                  }
                </div>
              </div>
            }
          </div>

          @if (plan().previa !== 'off') {
            <label class="audio">
              <input type="checkbox" [checked]="previaAudio()" (change)="previaAudio.set($any($event.target).checked)" />
              <span>{{ 'autofill.audioInclude' | transloco }}</span>
            </label>
            @if (previaAudio()) { <p class="disclaimer">⚠ {{ 'autofill.audioDisclaimer' | transloco }}</p> }
          }
          @if (plan().manual !== 'off') { <p class="disclaimer">⚠ {{ 'autofill.manualDisclaimer' | transloco }}</p> }

          <p class="plan">{{ planSummary() }}
            @if (totalEst(); as t) { <span class="total">≈ {{ t }}</span> }
          </p>
          <div class="actions">
            <button class="btn" type="button" (click)="lib.closeAutoFill()">{{ 'autofill.cancel' | transloco }}</button>
            <button class="btn primary" type="button" [disabled]="nothing()" (click)="run()">{{ 'autofill.fill' | transloco }}</button>
          </div>
        }
      </div>
    }
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 70; animation: fade 0.15s ease; }
    @keyframes fade { from { opacity: 0; } }
    .card {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 71;
      width: min(600px, 94vw); background: var(--panel); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); padding: 22px; animation: pop 0.16s ease;
    }
    @keyframes pop { from { transform: translate(-50%, -46%); opacity: 0; } }
    h3 { margin: 0 0 2px; font-size: 16px; letter-spacing: -0.2px; }
    .sub { margin: 0 0 16px; color: var(--tx-low); font-size: 12px; font-family: var(--mono); }
    .analyzing { display: flex; flex-direction: column; gap: 10px; color: var(--tx-mid); font-size: 13px; padding: 18px 2px; }
    .azhead { display: flex; align-items: center; gap: 10px; }
    .azcount { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
    .azbar { height: 6px; border-radius: 4px; background: var(--line); overflow: hidden; }
    .azfill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.2s ease; }
    .azeta { font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
    .spin { width: 15px; height: 15px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: sp 0.7s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .rows { display: flex; flex-direction: column; gap: 8px; }
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
    .plan { margin: 16px 0 14px; font-size: 12px; color: var(--tx-mid); line-height: 1.5; min-height: 1.2em; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  `,
})
export class AutoFillDialog {
  protected readonly lib = inject(LibraryStore);
  private readonly lang = inject(LangService);
  private readonly i18n = inject(TranslocoService);
  protected readonly rows = ROWS;
  protected readonly modes = MODES; // always the four modes; each is per-row disabled when it has nothing to do

  /** Plano local, re-inicializado a cada análise concluída. Como "Atualizar" é cumulativo (faltantes +
   *  desatualizados), ele é o padrão sempre que houver algo desatualizado; havendo só faltantes, o padrão
   *  é "Completar"; sem nada a fazer, "Não mexer". */
  protected readonly plan = linkedSignal<FillPlan>(() => {
    const st = this.lib.autoFill();
    const c = st?.counts;
    const def = (k: FillCategory): FillMode => (!c ? 'off' : c.stale[k] > 0 ? 'update' : c.missing[k] > 0 ? 'complete' : 'off');
    return {
      capa: def('capa'), tela: def('tela'), previa: def('previa'), info: def('info'), cheats: def('cheats'),
      manual: def('manual'),
    };
  });

  protected setMode(cat: FillCategory, mode: FillMode): void {
    this.plan.update((p) => ({ ...p, [cat]: mode }));
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
