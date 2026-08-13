import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { LibraryStore } from './library-store';

/**
 * Watches the service worker for a freshly deployed version and **applies it automatically**,
 * activates the waiting version and reloads into it, so a deploy reaches the user without any manual
 * cache-clearing (the whole point of shipping the PWA). The reload is deferred while a card write is
 * in progress (`lib.working()`) so we never interrupt a .cov/.gd/.fmv/move/copy. The `available`
 * flag + banner stay as a visible fallback for that "busy, will apply when idle" window.
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly sw = inject(SwUpdate);
  private readonly lib = inject(LibraryStore);
  readonly available = signal(false);
  private applying = false;

  constructor() {
    if (!this.sw.isEnabled) return; // disabled under `ng serve`

    this.sw.versionUpdates.subscribe((e) => {
      if (e.type === 'VERSION_READY') {
        this.available.set(true);
        void this.applyWhenIdle();
      }
    });
    // A broken / inconsistent SW cache → hard reload to recover.
    this.sw.unrecoverable.subscribe(() => location.reload());

    void this.check();
    setInterval(() => void this.check(), 15 * 60 * 1000); // every 15 min
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.check();
    });
  }

  private async check(): Promise<void> {
    try { await this.sw.checkForUpdate(); } catch { /* offline / not ready */ }
  }

  /** Activate the new version + reload as soon as no card write is running. */
  private async applyWhenIdle(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    if (await this.tryApply()) return;
    // Busy writing the card, retry every few seconds until idle.
    const iv = setInterval(() => {
      if (!this.lib.working()) {
        clearInterval(iv);
        void this.tryApply();
      }
    }, 3000);
  }

  private async tryApply(): Promise<boolean> {
    if (this.lib.working()) return false; // mid card-write, wait
    try { await this.sw.activateUpdate(); } catch { /* activate best-effort */ }
    location.reload();
    return true;
  }

  /** Manual trigger (banner button), same path, ignores the idle guard. */
  async activate(): Promise<void> {
    try { await this.sw.activateUpdate(); } catch { /* */ }
    location.reload();
  }

  dismiss(): void { this.available.set(false); }
}
