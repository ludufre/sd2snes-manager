import { Injectable, signal } from '@angular/core';
import type { Entry, ThemeFile } from './models';

/** Right-click context-menu state: a ROM entry or a theme file (position + target). */
export type ContextTarget =
  | { x: number; y: number; entry: Entry }
  | { x: number; y: number; theme: ThemeFile };

@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  private readonly _state = signal<ContextTarget | null>(null);
  readonly state = this._state.asReadonly();

  open(x: number, y: number, entry: Entry): void {
    this._state.set({ x, y, entry });
  }
  openTheme(x: number, y: number, theme: ThemeFile): void {
    this._state.set({ x, y, theme });
  }
  close(): void {
    this._state.set(null);
  }
}
