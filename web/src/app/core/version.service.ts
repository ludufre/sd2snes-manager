import { Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LangService } from './lang.service';

interface VersionInfo { version: string; commit: string; builtAt: string; }

/**
 * Reads the build stamp written by build.sh into `version.json`. The service
 * worker caches it alongside the app, so it always reflects the running build.
 * Absent under `ng serve` (gitignored / not generated) → reports "dev".
 */
@Injectable({ providedIn: 'root' })
export class VersionService {
  private readonly i18n = inject(TranslocoService);
  private readonly lang = inject(LangService);
  readonly info = signal<VersionInfo | null>(null);

  constructor() {
    // relative URL → respects <base href> (works under /manager/)
    fetch('version.json')
      .then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : null))
      .then((v) => v && this.info.set(v))
      .catch(() => {});
  }

  /** Short label for the indicator: `v1.0.0` (+ ` · <commit>` when built with git), or `dev`. */
  readonly label = computed(() => {
    this.lang.ready();
    const v = this.info();
    if (!v) return this.i18n.translate('update.dev');
    const commit = v.commit && v.commit !== 'nogit' ? ` · ${v.commit}` : '';
    return `v${v.version}${commit}`;
  });

  /** Full detail for the tooltip. */
  readonly detail = computed(() => {
    this.lang.ready();
    const v = this.info();
    if (!v) return this.i18n.translate('update.devBuild');
    const parts = [this.i18n.translate('update.version', { version: v.version })];
    if (v.commit && v.commit !== 'nogit') parts.push(this.i18n.translate('update.commit', { commit: v.commit }));
    if (v.builtAt) parts.push(this.i18n.translate('update.built', { date: v.builtAt.replace('T', ' ').replace('Z', ' UTC') }));
    return parts.join(' · ');
  });
}
