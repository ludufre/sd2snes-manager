import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type BadgeKind = 'ok' | 'info' | 'warn' | 'muted' | 'busy';

/** A status pill with an optional leading dot. Label is projected. */
@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="badge" [class]="kind()">
      @if (dot()) { <span class="d" [class]="dotClass()"></span> }
      <ng-content />
    </span>
  `,
  styles: `
    :host { display: inline-flex; }
    .badge {
      display: inline-flex; align-items: center; gap: 5px;
      font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: 0.3px;
      padding: 3px 8px; border-radius: var(--radius-pill); border: 1px solid transparent; white-space: nowrap;
    }
    .badge .d { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
    .badge.ok { color: var(--ok); background: var(--ok-soft); border-color: color-mix(in oklab, var(--ok) 30%, transparent); }
    .badge.info { color: var(--info); background: var(--info-soft); border-color: color-mix(in oklab, var(--info) 30%, transparent); }
    .badge.warn { color: var(--warn); background: var(--warn-soft); border-color: color-mix(in oklab, var(--warn) 30%, transparent); }
    .badge.muted { color: var(--tx-low); background: var(--panel); border-color: var(--line); }
    .badge.busy { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-line); }
    .badge .d.ok { background: var(--ok); }
    .badge .d.info { background: var(--info); }
    .badge .d.warn { background: var(--warn); }
    .badge .d.muted { background: var(--tx-low); }
    .badge.busy .d { background: var(--accent); animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  `,
})
export class StatusBadge {
  readonly kind = input.required<BadgeKind>();
  readonly dot = input(true);
  protected readonly dotClass = computed(() => (this.kind() === 'busy' ? '' : this.kind()));
}
