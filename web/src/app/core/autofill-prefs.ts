import { Injectable, effect, signal } from '@angular/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { COVER_REGION_CHOICES } from '../lib/regions.js';
import type { CoverRegion } from './cover-region';

const LS_KEY = 'sd2snes-covers:autofill'; // sibling of sd2snes-covers:prefs and :lang

/**
 * Auto-fill choices that must survive a reload: what a run WRITES, as opposed to how the app looks
 * (PrefsStore). Kept apart on purpose. An appearance preference can be wrong for a session and
 * nobody notices; this one decides which art lands on the card.
 */
@Injectable({ providedIn: 'root' })
export class AutoFillPrefsStore {
  private readonly _coverRegion = signal<CoverRegion>(null);

  /** Which region's cover a World dump gets. Null = no preference, i.e. exactly what the GameDB's
   *  own package already carries. */
  readonly coverRegion = this._coverRegion.asReadonly();

  constructor() {
    this.load();
    effect(() => this.save(this._coverRegion()));
  }

  setCoverRegion(v: CoverRegion): void {
    this._coverRegion.set(sanitizeCoverRegion(v));
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as { coverRegion?: unknown };
      this._coverRegion.set(sanitizeCoverRegion(p.coverRegion));
    } catch {
      // ignore corrupt prefs; the default (no preference) stands
    }
  }

  private save(coverRegion: CoverRegion): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ coverRegion }));
    } catch {
      // storage may be unavailable (private mode); non-fatal
    }
  }
}

/** Anything that is not one of the offered buckets becomes "no preference". A hand-edited
 *  localStorage must never put an unknown letter into `cover_region` on the card. */
export function sanitizeCoverRegion(v: unknown): CoverRegion {
  return (COVER_REGION_CHOICES as string[]).includes(v as string) ? (v as CoverRegion) : null;
}
