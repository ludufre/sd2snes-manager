import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import { PrefsStore } from '../../../core/prefs-store';
import { VersionService } from '../../../core/version.service';
import { ACCENT_SWATCHES, type Density, type View } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';
import { TranslocoModule } from '@jsverse/transloco';

const FW_ISSUES = 'https://github.com/ludufre/sd2snes/issues/new';

/** The "Display" popover: View / Density segmented controls + accent swatches. */
@Component({
  selector: 'app-settings-pop',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-scrim" (click)="close.emit()"></div>
    <div class="settings-pop">
      <div class="sp-head">
        <h3>{{ 'settings.display' | transloco }}</h3>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="sp-field">
        <label>{{ 'settings.view' | transloco }}</label>
        <div class="segctl">
          @for (v of views; track v) {
            <button [class.on]="prefs.view() === v" (click)="prefs.setView(v)">{{ v }}</button>
          }
        </div>
      </div>

      <div class="sp-field">
        <label>{{ 'settings.density' | transloco }}</label>
        <div class="segctl">
          @for (d of densities; track d) {
            <button [class.on]="prefs.density() === d" (click)="prefs.setDensity(d)">{{ d }}</button>
          }
        </div>
      </div>

      <div class="sp-field">
        <label>{{ 'settings.accentColor' | transloco }}</label>
        <div class="swatches">
          @for (c of accents; track c) {
            <button class="swatch" [class.on]="prefs.accent() === c" [style.background]="c" (click)="prefs.setAccent(c)">
              @if (prefs.accent() === c) { <app-icon name="check" [size]="18" /> }
            </button>
          }
        </div>
      </div>

      <!-- Only with a REAL card mounted: hasCard, not connected — the demo fixture sets connected too,
           and its ROMs have no files to identify, so the button could only ever answer "nothing to
           update". -->
      @if (lib.hasCard()) {
        <div class="sp-field">
          <label>{{ 'settings.data' | transloco }}</label>
          <button class="sp-action" type="button" (click)="refreshGamedb()">
            <app-icon name="download" [size]="14" />
            <span>
              {{ 'settings.refreshGamedb' | transloco }}
              <em>{{ 'settings.refreshGamedbHint' | transloco }}</em>
            </span>
          </button>
        </div>
      }

      <div class="sp-foot">
        <a class="report" [href]="reportUrl()" target="_blank" rel="noopener">
          <app-icon name="edit" [size]="14" />{{ 'settings.reportProblem' | transloco }}<span class="ext">↗</span>
        </a>
        <!-- Second way into the changelog, next to the version it belongs with. The topbar button is
             the primary one. -->
        <button class="about" type="button" (click)="openChangelog.emit()">
          sd2snes+ Manager · {{ ver.label() }} · <span class="what">{{ 'changelog.heading' | transloco }}</span>
        </button>
      </div>
    </div>
  `,
  styles: `
    .settings-scrim { position: fixed; inset: 0; z-index: 49; }
    .settings-pop {
      position: fixed; top: 56px; right: 16px; width: min(328px, calc(100vw - 32px)); z-index: 50;
      background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); padding: 8px 18px 20px; animation: popin 0.16s ease;
    }
    @keyframes popin { from { transform: translateY(-8px); } }
    .sp-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 0 4px; }
    .sp-head h3 { margin: 0; font-size: 14px; letter-spacing: -0.2px; }
    .sp-field { margin-top: 16px; }
    .sp-field > label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--tx-low); font-weight: 600; margin-bottom: 9px; }
    .segctl { display: flex; gap: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 11px; padding: 4px; }
    .segctl button {
      flex: 1; border: none; background: none; color: var(--tx-mid); font-family: var(--sans); font-size: 13px;
      font-weight: 500; text-transform: capitalize; padding: 8px 10px; border-radius: 8px; transition: 0.13s; cursor: pointer;
    }
    .segctl button:hover:not(.on) { color: var(--tx); }
    .segctl button.on { background: var(--elevated); color: var(--tx); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), inset 0 0 0 1px var(--line); }
    .swatches { display: flex; gap: 10px; }
    .swatch {
      flex: 1; aspect-ratio: 1 / 0.92; border-radius: 13px; border: none; color: #fff;
      display: grid; place-items: center; cursor: pointer; position: relative; transition: transform 0.12s;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
    }
    .swatch:hover { transform: translateY(-2px); }
    .swatch.on { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px currentColor; }
    .swatch app-icon { filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.4)); }
    .sp-action {
      display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; cursor: pointer;
      padding: 9px 11px; border-radius: 9px; font-family: var(--sans); font-size: 13px;
      color: var(--tx-mid); background: var(--bg); border: 1px solid var(--line);
    }
    .sp-action:hover { color: var(--accent); border-color: var(--accent-line); }
    .sp-action em { display: block; font-style: normal; font-size: 11px; color: var(--tx-low); margin-top: 2px; }
    .sp-foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
    .sp-foot .report {
      display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-radius: 9px;
      font-size: 13px; color: var(--tx-mid); text-decoration: none; background: var(--bg); border: 1px solid var(--line);
    }
    .sp-foot .report:hover { color: var(--accent); border-color: var(--accent-line); }
    .sp-foot .report .ext { color: var(--tx-low); margin-left: auto; }
    .sp-foot .about {
      display: block; width: 100%; margin-top: 10px; padding: 6px 0; text-align: center;
      background: none; border: none; cursor: pointer;
      font-family: var(--mono); font-size: 10.5px; color: var(--tx-low);
    }
    .sp-foot .about:hover { color: var(--tx-mid); }
    .sp-foot .about .what { color: var(--accent); }
  `,
})
export class SettingsPop {
  protected readonly prefs = inject(PrefsStore);
  protected readonly ver = inject(VersionService);
  protected readonly lib = inject(LibraryStore);
  readonly close = output<void>();
  readonly openChangelog = output<void>();

  /** Drop the cached GameDB answers and re-identify the whole library from the server. The popover
   *  closes first: the run drives the bulk bar behind it, which is the progress the user needs to see. */
  protected refreshGamedb(): void {
    this.close.emit();
    void this.lib.refreshGamedb();
  }

  protected readonly accents = ACCENT_SWATCHES;
  protected readonly views: View[] = ['list', 'gallery', 'split'];
  protected readonly densities: Density[] = ['compact', 'regular', 'comfy'];

  /** GitHub "new issue" link, prefilled with app version + browser for context. */
  protected readonly reportUrl = computed(() => {
    const v = this.ver.info();
    const tag = v ? `v${v.version}${v.commit && v.commit !== 'nogit' ? ' (' + v.commit + ')' : ''}` : 'dev';
    const body = [
      '<!-- Describe the problem · Descreva o problema -->',
      '',
      '',
      '---',
      `App: sd2snes+ Manager ${tag}`,
      `Browser: ${navigator.userAgent}`,
    ].join('\n');
    const title = '[Manager] ';
    return `${FW_ISSUES}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  });
}
