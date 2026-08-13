import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Pill on/off switch (cheat rows + the "include subfolders" control). */
@Component({
  selector: 'app-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" class="toggle" [class.on]="on()" [class.sm]="size() === 'sm'" (click)="onClick($event)"></button>`,
  styles: `
    :host { display: inline-flex; }
    .toggle {
      width: 36px; height: 20px; border-radius: 99px; background: var(--elevated);
      border: 1px solid var(--line); position: relative; transition: 0.15s; flex: 0 0 auto; padding: 0;
    }
    .toggle::after {
      content: ''; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px;
      border-radius: 50%; background: var(--tx-low); transition: 0.15s;
    }
    .toggle.on { background: var(--accent-soft); border-color: var(--accent-line); }
    .toggle.on::after { left: 17px; background: var(--accent); }
    .toggle.sm { width: 28px; height: 16px; }
    .toggle.sm::after { width: 12px; height: 12px; }
    .toggle.sm.on::after { left: 13px; }
  `,
})
export class Toggle {
  readonly on = input(false);
  readonly size = input<'md' | 'sm'>('md');
  readonly toggled = output<void>();

  protected onClick(e: Event): void {
    e.stopPropagation();
    this.toggled.emit();
  }
}
