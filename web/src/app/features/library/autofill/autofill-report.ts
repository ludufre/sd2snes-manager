import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LibraryStore, type FillError } from '../../../core/library-store';
import { Icon } from '../../../ui/icon/icon';

/** Reason code → i18n key. Codes come from the fill run (library-store: pushFillError). */
const REASON_KEYS: Record<string, string> = {
  readonly: 'fillReport.reasonReadonly',
  download: 'fillReport.reasonDownload',
  nofile: 'fillReport.reasonNoFile',
  nosha: 'fillReport.reasonNoFile',
  slotsfull: 'fillReport.reasonSlotsFull',
  nosource: 'fillReport.reasonNoSource',
  // the GameDB has no ready `.fmv` for this game: auto-fill never encodes video, so it skips it. Only
  // ever set with the package in hand. A bundle that never arrived is a plain `download`, retryable.
  noready: 'fillReport.reasonNoReadyPreview',
  writefail: 'fillReport.reasonOther', // the clip was in the package; writing it to the card failed
  // two GameDB manuals sharing a groupUuid, impossible through its unique index, so it gets the generic
  // label rather than a string of its own; it is here to say the fallback is deliberate, not an oversight
  dupdoc: 'fillReport.reasonOther',
  // Not a failure: a guide slot auto-fill itself filled at an earlier sync and has now swept. It rides in
  // this report because it is the one place that tells the user what a run did to files on their card.
  swept: 'fillReport.reasonSwept',
  // ...nor is this one: auto-fill recognized an older copy of a document by its `.man` type slug and
  // rewrote that slot in place. Nothing was deleted, but a document the user can see in the guides
  // dialog changed, so it is named here.
  adopted: 'fillReport.reasonAdopted',
  // Reported precisely because nothing was done: a slot that looks like an older copy but could not be
  // proven to be one is never touched, the user decides.
  leftover: 'fillReport.reasonLeftover',
};

/** Post-run report of games whose artifacts couldn't be written (but the run continued), typically a
 *  read-only ROM folder rejecting the `.cov`, or a manual the GameDB couldn't serve. Lists them and
 *  offers a CSV export. */
@Component({
  selector: 'app-autofill-report',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="card">
      <div class="head">
        <span class="warn"><app-icon name="info" [size]="18" /></span>
        <h3>{{ (onlySwept() ? 'fillReport.titleSwept' : 'fillReport.title') | transloco }}</h3>
        <div class="grow"></div>
        <button class="btn ghost sm icon" type="button" [title]="'fillReport.close' | transloco" (click)="close.emit()">
          <app-icon name="x" [size]="16" />
        </button>
      </div>
      <p class="sub">{{ ((onlySwept() ? 'fillReport.subSwept' : 'fillReport.sub') + (errors().length === 1 ? 'One' : 'Many')) | transloco: { count: errors().length } }}</p>
      @if (has('readonly')) { <p class="hint">{{ 'fillReport.hint' | transloco }}</p> }
      @if (hasManual()) { <p class="hint">{{ 'fillReport.hintManual' | transloco }}</p> }
      @if (has('swept')) { <p class="hint">{{ 'fillReport.hintSwept' | transloco }}</p> }
      @if (has('adopted') || has('leftover')) { <p class="hint">{{ 'fillReport.hintAdopted' | transloco }}</p> }
      @if (has('slotsfull')) { <p class="hint">{{ 'fillReport.hintSlotsFull' | transloco }}</p> }
      @if (hasAsset()) { <p class="hint">{{ 'fillReport.hintAsset' | transloco }}</p> }
      @if (hasPreview()) { <p class="hint">{{ 'fillReport.hintPreview' | transloco }}</p> }

      <div class="list scroll">
        @for (e of errors(); track e.id + e.asset) {
          <div class="row">
            <span class="g">{{ e.title }}</span>
            <span class="f">{{ e.folder || '/' }}</span>
            <span class="r">{{ reasonLabel(e.reason) }}</span>
          </div>
        }
      </div>

      <div class="foot">
        <button class="btn sm" type="button" (click)="lib.exportFillReportCsv()">
          <app-icon name="download" [size]="14" />{{ 'fillReport.exportCsv' | transloco }}
        </button>
        <div class="grow"></div>
        <button class="btn sm primary" type="button" (click)="close.emit()">{{ 'fillReport.close' | transloco }}</button>
      </div>
    </div>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; }
    .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); }
    .card {
      position: relative; width: min(680px, 92vw); max-height: 82vh; display: flex; flex-direction: column;
      background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow-lg, 0 20px 60px rgba(0,0,0,.5));
      padding: 18px 20px;
    }
    .head { display: flex; align-items: center; gap: 10px; }
    .head h3 { margin: 0; font-size: 16px; color: var(--tx); }
    .warn { color: var(--warn, #e0a52b); display: inline-grid; place-items: center; }
    .grow { flex: 1; }
    .sub { margin: 8px 0 2px; color: var(--tx-mid); font-size: 13px; }
    .hint { margin: 0 0 12px; color: var(--tx-low); font-size: 12px; line-height: 1.5; }
    .list { border: 1px solid var(--line); border-radius: var(--radius-control); overflow: auto; }
    .row {
      display: grid; grid-template-columns: 1.4fr 1.6fr auto; gap: 12px; align-items: center;
      padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 12px;
    }
    .row:last-child { border-bottom: none; }
    .row .g { color: var(--tx); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .f { color: var(--tx-low); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .r { color: var(--warn, #e0a52b); white-space: nowrap; }
    .foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  `,
})
export class AutofillReport {
  protected readonly lib = inject(LibraryStore);
  private readonly i18n = inject(TranslocoService);
  readonly errors = input.required<FillError[]>();
  readonly close = output<void>();

  /** Human label for a reason code (extend as more skip reasons appear). */
  protected reasonLabel(code: string): string {
    const key = REASON_KEYS[code] ?? 'fillReport.reasonOther';
    return this.i18n.translate(key);
  }

  /** Is any listed failure of this reason / about a manual / about a generated artifact? Drives which
   *  explanatory hint is shown (a run can hit more than one of these at once). */
  protected has(reason: string): boolean { return this.errors().some((e) => e.reason === reason); }
  /** Nothing failed, the run only swept guide slots. The dialog still opens (a deletion has to be
   *  shown), but calling that "files could not be written" would be a lie about a successful run. */
  protected onlySwept(): boolean {
    return this.errors().every((e) => e.reason === 'swept' || e.reason === 'adopted' || e.reason === 'leftover');
  }
  protected hasManual(): boolean { return this.errors().some((e) => e.asset === 'man'); }
  /** A generated artifact that failed for a retryable reason (download/no source), the "try again"
   *  hint. A preview whose bundle never arrived belongs here, not under hintPreview. */
  protected hasAsset(): boolean {
    return this.errors().some((e) => (e.asset === 'cov' || e.asset === 'gss' || e.asset === 'fmv')
      && e.reason !== 'readonly' && e.reason !== 'noready');
  }
  /** A preview the GameDB hasn't built yet, its own hint, because the fix is not "try again": nothing
   *  on this side can produce it (auto-fill never encodes video), it has to be published upstream. */
  protected hasPreview(): boolean { return this.errors().some((e) => e.asset === 'fmv' && e.reason === 'noready'); }
}
