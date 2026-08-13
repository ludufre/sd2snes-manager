import { Injectable, signal } from '@angular/core';
import type { Toast, ToastKind } from './models';

/** Transient toast notifications (auto-dismiss). */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private seq = 0;
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  show(msg: string, kind: ToastKind = 'ok'): void {
    const id = ++this.seq;
    this._toasts.update((list) => [...list, { id, msg, kind }]);
    setTimeout(() => this.dismiss(id), 2600);
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
