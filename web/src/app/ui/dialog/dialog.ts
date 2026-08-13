import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { DialogService, type ConfirmCheckbox } from '../../core/dialog.service';
import { Checkbox } from '../checkbox/checkbox';

/** Single modal host: renders the active confirm/conflict dialog (DialogService). */
@Component({
  selector: 'app-dialog',
  imports: [Checkbox, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = dialog.state();
    @if (s) {
      <div class="scrim" (click)="cancel()"></div>
      <div class="card" [class.danger]="danger()">
        @if (s.kind === 'confirm') {
          <h3>{{ s.opts.title }}</h3>
          @if (s.opts.body) { <p class="body">{{ s.opts.body }}</p> }
          @if (s.opts.checkboxLabel) {
            <label class="opt">
              <app-checkbox [checked]="checked()" (changed)="checked.set(!checked())" />
              <span>{{ s.opts.checkboxLabel }}</span>
            </label>
          }
          @if (s.opts.checkboxes?.length) {
            <div class="opts">
              @for (cb of s.opts.checkboxes; track cb.key) {
                <label class="opt" [class.disabled]="boxDisabled(cb)">
                  <app-checkbox [checked]="boxChecked(cb)" (changed)="toggle(cb)" />
                  <span>{{ cb.label }}</span>
                </label>
              }
            </div>
          }
          <div class="actions">
            <button class="btn" type="button" (click)="cancel()">{{ s.opts.cancelLabel ?? ('dialog.cancel' | transloco) }}</button>
            <button
              class="btn" [class.danger]="s.opts.danger" [class.primary]="!s.opts.danger" type="button"
              [disabled]="confirmDisabled()"
              (click)="dialog.settle({ ok: true, checked: checked(), checkedKeys: checkedKeys() })">
              {{ s.opts.confirmLabel ?? ('dialog.confirm' | transloco) }}
            </button>
          </div>
        } @else if (s.kind === 'conflict') {
          <h3>{{ 'dialog.conflictTitle' | transloco }}</h3>
          <p class="body"><span class="mono">{{ s.name }}</span> {{ 'dialog.conflictBody' | transloco }}</p>
          <label class="opt">
            <app-checkbox [checked]="applyAll()" (changed)="applyAll.set(!applyAll())" />
            <span>{{ 'dialog.applyAll' | transloco }}</span>
          </label>
          <div class="actions wrap">
            <button class="btn" type="button" (click)="cancel()">{{ 'dialog.cancel' | transloco }}</button>
            <button class="btn" type="button" (click)="conflict('skip')">{{ 'dialog.skip' | transloco }}</button>
            <button class="btn" type="button" (click)="conflict('keepboth')">{{ 'dialog.keepBoth' | transloco }}</button>
            <button class="btn danger" type="button" (click)="conflict('overwrite')">{{ 'dialog.overwrite' | transloco }}</button>
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
      width: min(420px, 92vw); background: var(--panel); border: 1px solid var(--line);
      border-radius: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6); padding: 22px; animation: pop 0.16s ease;
    }
    @keyframes pop { from { transform: translate(-50%, -46%); opacity: 0; } }
    .card.danger { border-color: color-mix(in oklab, var(--danger) 45%, transparent); }
    h3 { margin: 0 0 10px; font-size: 16px; letter-spacing: -0.2px; }
    .body { margin: 0 0 14px; color: var(--tx-mid); font-size: 13px; line-height: 1.5; white-space: pre-line; }
    .mono { font-family: var(--mono); color: var(--tx); }
    .opt { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 13px; color: var(--tx-mid); margin: 4px 0 16px; user-select: none; }
    .opts { margin: 4px 0 16px; }
    .opts .opt { margin: 6px 0; }
    .opt.disabled { opacity: 0.5; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .actions.wrap { flex-wrap: wrap; }
  `,
})
export class Dialog {
  protected readonly dialog = inject(DialogService);

  protected readonly danger = computed(() => {
    const s = this.dialog.state();
    return s?.kind === 'confirm' && !!s.opts.danger;
  });

  protected readonly checked = linkedSignal(() => {
    const s = this.dialog.state();
    return s?.kind === 'confirm' ? !!s.opts.checkboxDefault : false;
  });
  /** Per-key checked state for the granular `checkboxes` list (reset whenever the dialog changes). */
  protected readonly marks = linkedSignal<Record<string, boolean>>(() => {
    const s = this.dialog.state();
    const out: Record<string, boolean> = {};
    if (s?.kind === 'confirm' && s.opts.checkboxes) for (const cb of s.opts.checkboxes) out[cb.key] = !!cb.default;
    return out;
  });
  /** A `forcesOthers` checkbox (e.g. the ROM) is checked -> every other box is forced on + disabled. */
  private forced(): boolean {
    const s = this.dialog.state();
    return s?.kind === 'confirm' && !!s.opts.checkboxes?.some((cb) => cb.forcesOthers && this.marks()[cb.key]);
  }
  protected boxChecked(cb: ConfirmCheckbox): boolean { return !!this.marks()[cb.key] || (this.forced() && !cb.forcesOthers); }
  protected boxDisabled(cb: ConfirmCheckbox): boolean { return this.forced() && !cb.forcesOthers; }
  protected toggle(cb: ConfirmCheckbox): void {
    if (this.boxDisabled(cb)) return;
    this.marks.update((m) => ({ ...m, [cb.key]: !m[cb.key] }));
  }
  protected checkedKeys(): string[] {
    const s = this.dialog.state();
    const boxes = s?.kind === 'confirm' ? s.opts.checkboxes : undefined;
    if (!boxes) return [];
    if (this.forced()) return boxes.map((cb) => cb.key);       // ROM forces everything
    return boxes.filter((cb) => this.marks()[cb.key]).map((cb) => cb.key);
  }
  /** Block "confirm" when the dialog offers checkboxes but the user has selected none (a no-op delete). */
  protected confirmDisabled(): boolean {
    const s = this.dialog.state();
    return s?.kind === 'confirm' && !!s.opts.checkboxes?.length && this.checkedKeys().length === 0;
  }
  protected readonly applyAll = linkedSignal(() => {
    this.dialog.state(); // reset whenever the dialog changes
    return false;
  });

  protected cancel(): void {
    const s = this.dialog.state();
    if (s?.kind === 'conflict') this.dialog.settle({ action: 'cancel', all: false });
    else this.dialog.settle({ ok: false, checked: false, checkedKeys: [] });
  }
  protected conflict(action: 'overwrite' | 'skip' | 'keepboth'): void {
    this.dialog.settle({ action, all: this.applyAll() });
  }
}
