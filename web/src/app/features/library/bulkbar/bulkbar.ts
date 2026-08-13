import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { fmtEta, fmtRate } from '../../../core/format';
import { Icon } from '../../../ui/icon/icon';

/** Bulk actions bar, three modes: in-progress, selection-scoped, default. */
@Component({
  selector: 'app-bulkbar',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let bulk = lib.bulk();
    @let sel = lib.selStats();
    @let s = lib.stats();

    @let rate = lib.bulkRate();
    @if (bulk) {
      <div class="bulkbar">
        <!-- The whole progress area reopens the detailed modal (which the user can dismiss and get
             back to at any time). A real <button> so it is reachable by keyboard, and everything
             inside it is phrasing content for the same reason. NOT the Cancel button beside it —
             that one has to stay a click of its own. -->
        <!-- title only, NO aria-label: role=button makes children presentational, and an aria-label
             would REPLACE the computed name — a screen reader would lose the phase, the count and the
             rate that this very bar exists to announce. The label rides along as extra text instead. -->
        <button
          class="prog" type="button"
          [title]="'progress.reopen' | transloco"
          (click)="lib.openProgress()">
          <span class="ptxt">{{ bulk.label }}</span>
          <span class="bar" [class.indet]="!bulk.total"><i [style.width.%]="bulk.total ? (bulk.done / bulk.total) * 100 : 40"></i></span>
          @if (bulk.total) { <span class="ptxt">{{ bulk.done }} / {{ bulk.total }}</span> }
          @if (rate) {
            <span class="ptxt rate">{{ 'bulkbar.rate' | transloco: { perSec: rate.perSec.toFixed(1), bps: rate.bytesPerSec ? ' · ' + fmtRate(rate.bytesPerSec) : '', eta: fmtEta(rate.etaSec) } }}</span>
          }
          <span class="sr">{{ 'progress.reopen' | transloco }}</span>
        </button>
        @if (bulk.cancelable) {
          <button class="btn ghost sm" type="button" (click)="lib.cancelBulk()">
            <app-icon name="x" [size]="13" />{{ 'bulkbar.cancel' | transloco }}
          </button>
        }
      </div>
    } @else if (sel.count > 0) {
      <div class="bulkbar sel">
        <span class="selcount">{{ 'bulkbar.selectedCount' | transloco: { count: sel.count } }}</span>
        <button class="btn sm primary" (click)="lib.startAutoFill(lib.selected())">
          <app-icon name="spark" [size]="13" />{{ 'bulkbar.autoFill' | transloco }}
        </button>
        <button class="btn sm" (click)="lib.openPicker('move', lib.selected())">
          <app-icon name="move" [size]="13" />{{ 'bulkbar.moveTo' | transloco }}
        </button>
        <button class="btn sm" (click)="lib.openPicker('copy', lib.selected())">
          <app-icon name="plus" [size]="13" />{{ 'bulkbar.copyTo' | transloco }}
        </button>
        <button class="btn sm danger" (click)="lib.bulkDelete(lib.selected())">
          <app-icon name="trash" [size]="13" />{{ 'bulkbar.delete' | transloco: { count: sel.count } }}
        </button>
        <div class="grow"></div>
        <button class="btn ghost sm" (click)="lib.clearSel()"><app-icon name="x" [size]="13" />{{ 'bulkbar.clearSelection' | transloco }}</button>
      </div>
    } @else {
      <div class="bulkbar">
        <!-- Says "filtrados" when a filter is on, so it's clear the button follows the visible list
             and not the folder it happens to be sitting in. -->
        <span class="selcount">{{ (lib.flat() ? 'bulkbar.filteredCount' : 'bulkbar.folderCount') | transloco: { count: lib.folderFillCount() } }}</span>
        <button class="btn sm primary" [disabled]="!lib.folderFillCount()" (click)="lib.startAutoFillFolder()">
          <app-icon name="spark" [size]="13" />{{ 'bulkbar.autoFill' | transloco }}
        </button>
        <div class="grow"></div>
        <span class="tip">{{ 'bulkbar.tip' | transloco: { covers: s.covers, previews: s.previews, cheats: s.cheats, total: s.total } }}</span>
      </div>
    }
  `,
  styles: `
    .bulkbar {
      display: flex; align-items: center; gap: 14px; padding: 10px 20px; flex: 0 0 auto;
      min-height: 49px; box-sizing: border-box; flex-wrap: wrap;
      border-bottom: 1px solid var(--line); background: var(--panel-2);
    }
    .grow { flex: 1; }
    .bulkbar.sel { background: var(--accent-soft); border-bottom-color: var(--accent-line); }
    .selcount { font-family: var(--mono); font-size: 12px; font-weight: 700; color: var(--accent); padding-right: 4px; }
    .kicker { font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
    .tip { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    /* a <button>, so the browser chrome (background/border/padding/font) has to be undone */
    .prog {
      display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;
      appearance: none; background: none; border: 0; padding: 0; margin: 0;
      font: inherit; color: inherit; text-align: left; cursor: pointer; border-radius: 8px;
    }
    .prog:hover .ptxt { color: var(--tx); }
    .prog:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    /* visually hidden, still announced: appends "open details" to the live progress text above */
    .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .prog .bar { flex: 1; max-width: 360px; }
    .prog .ptxt { font-family: var(--mono); font-size: 12px; color: var(--tx-mid); white-space: nowrap; transition: color 0.12s; }
    .prog .ptxt.rate { color: var(--tx-low); }
    .bar { display: block; height: 6px; background: var(--elevated); border-radius: 99px; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width 0.25s; }
    /* indeterminate (download phase, total unknown): a sliding stripe instead of a stuck "0 / 0" bar */
    .bar.indet > i { transition: none; animation: indet 1.15s ease-in-out infinite; }
    @keyframes indet { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
  `,
})
export class BulkBar {
  protected readonly lib = inject(LibraryStore);
  /** Shared with the progress modal (core/format), the two render the same numbers. */
  protected readonly fmtEta = fmtEta;
  protected readonly fmtRate = fmtRate;
}
