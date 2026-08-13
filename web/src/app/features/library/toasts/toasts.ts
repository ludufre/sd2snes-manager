import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from '../../../core/toast.service';

/** Bottom-center transient toasts. */
@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toasts">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [class]="t.kind"><span class="d"></span>{{ t.msg }}</div>
      }
    </div>
  `,
  styles: `
    .toasts {
      position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 60;
      display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none;
    }
    .toast {
      background: var(--elevated); border: 1px solid var(--line); border-radius: 9px; padding: 9px 15px;
      font-size: 13px; display: flex; align-items: center; gap: 9px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      animation: toastin 0.2s ease;
    }
    .toast .d { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: 0 0 auto; }
    .toast.info .d { background: var(--info); }
    .toast.warn .d { background: var(--warn); }
    @keyframes toastin { from { transform: translateY(12px); opacity: 0; } }
  `,
})
export class Toasts {
  protected readonly toast = inject(ToastService);
}
