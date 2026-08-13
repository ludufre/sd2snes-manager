import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { Icon } from '../icon/icon';

/** Tri-state selection checkbox (unchecked / checked / indeterminate). */
@Component({
  selector: 'app-checkbox',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="ckbox"
      [class.on]="checked()"
      [class.ind]="indeterminate() && !checked()"
      [class.overlay]="overlay()"
      [attr.title]="title()"
      (click)="onClick($event)">
      @if (checked()) {
        <app-icon name="check" [size]="12" />
      } @else if (indeterminate()) {
        <span class="dash"></span>
      }
    </button>
  `,
  styles: `
    :host { display: inline-grid; place-items: center; }
    .ckbox {
      position: relative;
      width: 18px; height: 18px; flex: 0 0 auto; border-radius: 5px;
      border: 1.5px solid var(--line); background: var(--panel); color: #0d0a1f;
      display: grid; place-items: center; padding: 0; transition: 0.12s;
    }
    /* Enlarge the clickable area well beyond the 18px box so a slightly-off click still toggles
       the selection instead of falling through to the row (which opens the detail panel). */
    .ckbox::before { content: ''; position: absolute; inset: -10px; border-radius: 9px; }
    .ckbox:hover { border-color: var(--tx-low); }
    .ckbox.on { background: var(--accent); border-color: var(--accent); }
    .ckbox.ind { background: var(--accent-soft); border-color: var(--accent-line); }
    .ckbox .dash { width: 9px; height: 2px; border-radius: 2px; background: var(--accent); }
    .ckbox.overlay { background: rgba(10, 12, 14, 0.7); backdrop-filter: blur(4px); border-color: rgba(255, 255, 255, 0.4); }
    .ckbox.overlay.on { background: var(--accent); border-color: var(--accent); }
  `,
})
export class Checkbox {
  readonly checked = input(false);
  readonly indeterminate = input(false);
  readonly overlay = input(false);
  readonly title = input<string | null>(null);
  readonly changed = output<void>();

  protected onClick(e: Event): void {
    e.stopPropagation();
    this.changed.emit();
  }
}
