import { Injectable, effect, signal } from '@angular/core';
import { DEFAULT_PREFS, type Density, type Prefs, type View } from './models';

const LS_KEY = 'sd2snes-covers:prefs';

/**
 * Appearance preferences (view / density / accent), persisted to localStorage
 * and applied to <html> as CSS variables + data attributes so the whole token
 * system re-themes at runtime. Navigation state (folder/game, filters) lives
 * elsewhere. This store is purely "how it looks".
 */
@Injectable({ providedIn: 'root' })
export class PrefsStore {
  private readonly _view = signal<View>(DEFAULT_PREFS.view);
  private readonly _density = signal<Density>(DEFAULT_PREFS.density);
  private readonly _accent = signal<string>(DEFAULT_PREFS.accent);
  private readonly _sidebarOpen = signal<boolean>(DEFAULT_PREFS.sidebarOpen);
  private readonly _boardOpen = signal<boolean>(DEFAULT_PREFS.boardOpen);

  readonly view = this._view.asReadonly();
  readonly density = this._density.asReadonly();
  readonly accent = this._accent.asReadonly();
  readonly sidebarOpen = this._sidebarOpen.asReadonly();
  readonly boardOpen = this._boardOpen.asReadonly();

  constructor() {
    this.load();
    // Persist + apply to the document whenever any pref changes.
    effect(() => {
      const prefs: Prefs = {
        view: this._view(),
        density: this._density(),
        accent: this._accent(),
        sidebarOpen: this._sidebarOpen(),
        boardOpen: this._boardOpen(),
      };
      this.apply(prefs);
      this.save(prefs);
    });
  }

  setView(view: View): void { this._view.set(view); }
  setDensity(density: Density): void { this._density.set(density); }
  setAccent(accent: string): void { this._accent.set(accent); }
  setSidebarOpen(open: boolean): void { this._sidebarOpen.set(open); }
  setBoardOpen(open: boolean): void { this._boardOpen.set(open); }

  private apply(prefs: Prefs): void {
    const root = document.documentElement;
    root.style.setProperty('--accent', prefs.accent);
    root.dataset['density'] = prefs.density;
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<Prefs>;
      if (p.view) this._view.set(p.view);
      if (p.density) this._density.set(p.density);
      if (p.accent) this._accent.set(p.accent);
      if (typeof p.sidebarOpen === 'boolean') this._sidebarOpen.set(p.sidebarOpen);
      if (typeof p.boardOpen === 'boolean') this._boardOpen.set(p.boardOpen);
    } catch {
      // ignore corrupt prefs; defaults stand
    }
  }

  private save(prefs: Prefs): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(prefs));
    } catch {
      // storage may be unavailable (private mode); non-fatal
    }
  }
}
