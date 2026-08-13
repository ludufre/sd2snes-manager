import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { fmtEta, fmtRate } from '../../../core/format';
import { Icon } from '../../../ui/icon/icon';

/**
 * Detailed view of the running bulk operation, the same `lib.bulk()` the bar shows, given room to
 * name the phase, the counter, the throughput and the ETA.
 *
 * Lives beside the bar (rather than in a folder of its own) because the two are one feature: a long
 * run watched up close, and the same run watched out of the corner of the eye. Neither owns the
 * state, both read the store.
 *
 * Dismissing it is not cancelling. The X, Esc and the scrim only lower `progressOpen`; the run keeps
 * going and the bulk bar keeps reporting it, and the bar reopens this. Only the Cancel button, the
 * bar's own, or the one below when the phase is cancelable, stops anything.
 */
@Component({
  selector: 'app-bulk-progress',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Esc closes the details. Only this component listens, and only while it is on screen (the host
  // renders it under `@if (lib.progressOpen())`), so the binding dies with the modal.
  host: { '(document:keydown.escape)': 'lib.closeProgress()' },
  template: `
    @let bulk = lib.bulk();
    @let rate = lib.bulkRate();
    @if (bulk) {
      <div class="scrim" (click)="lib.closeProgress()"></div>
      <div class="card" role="dialog" aria-modal="true" [attr.aria-label]="'progress.title' | transloco">
        <div class="head">
          <span class="spin"></span>
          <h3>{{ 'progress.title' | transloco }}</h3>
          <div class="grow"></div>
          <button
            #closer class="btn ghost sm icon" type="button"
            [title]="'progress.close' | transloco" [attr.aria-label]="'progress.close' | transloco"
            (click)="lib.closeProgress()">
            <app-icon name="x" [size]="16" />
          </button>
        </div>

        <p class="phase" id="bulk-phase">{{ bulk.label }}</p>
        <div
          class="bar" [class.indet]="!bulk.total"
          role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="bulk-phase"
          [attr.aria-valuenow]="bulk.total ? pct(bulk.done, bulk.total) : null">
          <i [style.width.%]="bulk.total ? (bulk.done / bulk.total) * 100 : 40"></i>
        </div>
        <!-- hidden when there is neither a count nor a rate: some phases have both unknown, and an
             empty flex row still eats its margin (a dead 12px gap under the bar). -->
        @if (bulk.total || rate) {
        <div class="meta">
          @if (bulk.total) {
            <span class="n">{{ bulk.done }} / {{ bulk.total }}</span>
            <span class="pct">{{ pct(bulk.done, bulk.total) }}%</span>
          }
          <div class="grow"></div>
          @if (rate) {
            <span class="rate">{{ 'bulkbar.rate' | transloco: { perSec: rate.perSec.toFixed(1), bps: rate.bytesPerSec ? ' · ' + fmtRate(rate.bytesPerSec) : '', eta: fmtEta(rate.etaSec) } }}</span>
          }
        </div>
        }

        <p class="hint">{{ 'progress.hint' | transloco }}</p>

        <div class="actions">
          @if (bulk.cancelable) {
            <button class="btn danger" type="button" (click)="lib.cancelBulk()">
              <app-icon name="x" [size]="14" />{{ 'bulkbar.cancel' | transloco }}
            </button>
          }
          <div class="grow"></div>
          <button class="btn primary" type="button" (click)="lib.closeProgress()">{{ 'progress.close' | transloco }}</button>
        </div>
      </div>
    }
  `,
  styles: `
    /* Deliberately BELOW app-dialog's 70/71: a move/copy run can raise a real conflict prompt while
       this is open, and that prompt must own the scrim (and the Esc) — not sit next to an
       undimmed progress card with live buttons. */
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 68; animation: fade 0.15s ease; }
    @keyframes fade { from { opacity: 0; } }
    .card {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 69;
      width: min(480px, 94vw); background: var(--panel); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); padding: 22px; animation: pop 0.16s ease;
    }
    @keyframes pop { from { transform: translate(-50%, -46%); opacity: 0; } }
    .head { display: flex; align-items: center; gap: 10px; }
    .head h3 { margin: 0; font-size: 16px; letter-spacing: -0.2px; }
    .grow { flex: 1; }
    .spin { width: 15px; height: 15px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: sp 0.7s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .phase { margin: 16px 0 8px; font-size: 13px; color: var(--tx); }
    .bar { height: 8px; background: var(--elevated); border-radius: 99px; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width 0.25s; }
    /* indeterminate (download phase, total unknown) — same sliding stripe the bar uses */
    .bar.indet > i { transition: none; animation: indet 1.15s ease-in-out infinite; }
    @keyframes indet { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
    .meta { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-family: var(--mono); font-size: 12px; }
    .meta .n { color: var(--tx-mid); }
    .meta .pct { color: var(--tx-low); }
    .meta .rate { color: var(--tx-low); text-align: right; }
    .hint { margin: 16px 0 14px; padding: 9px 11px; font-size: 11.5px; line-height: 1.45; color: var(--tx-mid); background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; }
    .actions { display: flex; align-items: center; gap: 8px; }
  `,
})
export class BulkProgress {
  protected readonly lib = inject(LibraryStore);
  /** Shared with the bar so the two views can never print the same number differently. */
  protected readonly fmtEta = fmtEta;
  protected readonly fmtRate = fmtRate;

  private readonly closer = viewChild<ElementRef<HTMLButtonElement>>('closer');

  constructor() {
    // Focus the close button on open, so the keyboard lands on the way out (the modal is optional.
    // it never has to be interacted with). The component is created fresh each time it opens, so
    // this fires exactly once per opening.
    effect(() => this.closer()?.nativeElement.focus());
  }

  /** Progress as a rounded 0..100, for the counter and aria-valuenow. */
  protected pct(done: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }
}
