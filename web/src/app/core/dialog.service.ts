import { Injectable, signal } from '@angular/core';

/** One opt-in checkbox in a confirm dialog (granular delete options). When `forcesOthers` is set,
 *  checking it forces every other checkbox on + disabled (e.g. deleting the ROM takes its assets too). */
export interface ConfirmCheckbox { key: string; label: string; default?: boolean; forcesOthers?: boolean; }
export interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** Overrides the generic "Cancel" when refusing means something specific ("Pick another folder"). */
  cancelLabel?: string;
  danger?: boolean;
  /** Optional single opt-in checkbox (e.g. "also delete cheats/save"). */
  checkboxLabel?: string;
  checkboxDefault?: boolean;
  /** Optional list of independent opt-in checkboxes; the checked ones come back in `checkedKeys`. */
  checkboxes?: ConfirmCheckbox[];
}
export interface ConfirmResult { ok: boolean; checked: boolean; checkedKeys: string[]; }

export type ConflictAction = 'overwrite' | 'skip' | 'keepboth' | 'cancel';
export interface ConflictResult { action: ConflictAction; all: boolean; }

export type DialogState =
  | { kind: 'confirm'; opts: ConfirmOpts }
  | { kind: 'conflict'; name: string };

/**
 * Imperative modal dialogs (confirm + move-conflict) resolved as Promises, so
 * store operations can `await dialog.confirm(...)` / `await dialog.conflict(...)`.
 * A single <app-dialog> host (mounted in library.html) renders the active state.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly _state = signal<DialogState | null>(null);
  readonly state = this._state.asReadonly();
  private resolver: ((value: ConfirmResult | ConflictResult) => void) | null = null;

  confirm(opts: ConfirmOpts): Promise<ConfirmResult> {
    return new Promise((resolve) => {
      this.settle({ ok: false, checked: false, checkedKeys: [] });
      this.resolver = resolve as (v: ConfirmResult | ConflictResult) => void;
      this._state.set({ kind: 'confirm', opts });
    });
  }

  conflict(name: string): Promise<ConflictResult> {
    return new Promise((resolve) => {
      this.settle({ action: 'cancel', all: false });
      this.resolver = resolve as (v: ConfirmResult | ConflictResult) => void;
      this._state.set({ kind: 'conflict', name });
    });
  }

  /** Called by the dialog component on a user choice. */
  settle(value: ConfirmResult | ConflictResult): void {
    const r = this.resolver;
    this.resolver = null;
    this._state.set(null);
    r?.(value);
  }
}
