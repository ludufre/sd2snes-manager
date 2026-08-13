import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { FirmwareService, type FwAsset, type FwRelease } from '../../../core/firmware.service';
import { Icon } from '../../../ui/icon/icon';

/** sd2snes+ firmware updater: release list + Markdown notes + install to /sd2snes/. */
@Component({
  selector: 'app-firmware-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="fw">
      <div class="fwh">
        <h3>{{ 'firmware.heading' | transloco }}</h3>
        <a class="repo" href="https://github.com/ludufre/sd2snes/releases" target="_blank" rel="noopener">ludufre/sd2snes</a>
        <div class="grow"></div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      @if (error()) {
        <div class="fwmsg err">{{ 'firmware.loadError' | transloco: { error: error() } }}</div>
      } @else if (!releases()) {
        <div class="fwmsg">{{ 'firmware.loading' | transloco }}</div>
      } @else if (releases()!.length === 0) {
        <div class="fwmsg">{{ 'firmware.noReleases' | transloco }}</div>
      } @else {
        <div class="fwbody">
          <div class="rlist scroll">
            @for (r of releases(); track r.tag) {
              <button class="ritem" [class.on]="r.tag === sel()?.tag" type="button" (click)="sel.set(r)">
                <span class="rname">{{ r.name }}@if (r.prerelease) {<i class="pre">{{ 'firmware.prerelease' | transloco }}</i>}</span>
                <span class="rmeta">{{ r.tag }} · {{ r.publishedAt.slice(0, 10) }}</span>
              </button>
            }
          </div>
          <div class="rnotes scroll">
            @if (sel(); as r) { <div class="md" [innerHTML]="r.bodyHtml"></div> }
          </div>
        </div>

        @if (sel(); as r) {
          <div class="fwfoot">
            <span class="dest"><app-icon name="folder" [size]="13" /> → {{ lib.rootName() }}/sd2snes</span>
            <span class="ghfall" [title]="'firmware.ghFallbackTitle' | transloco">
              GitHub ↗
              @if (r.update) { <a [href]="r.update.ghUrl" target="_blank" rel="noopener">{{ 'firmware.coreLink' | transloco }}</a> }
              @if (r.full) { <a [href]="r.full.ghUrl" target="_blank" rel="noopener">{{ 'firmware.fullLink' | transloco }}</a> }
            </span>
            <div class="grow"></div>
            @if (r.update) {
              <button class="btn sm" type="button" [disabled]="busy()" (click)="install(r.update, r.name + ' · ' + i18n.translate('firmware.updateLabel'))">
                <app-icon name="download" [size]="13" />{{ 'firmware.update' | transloco }} · {{ kb(r.update.size) }}
              </button>
            }
            @if (r.full) {
              <button class="btn sm primary" type="button" [disabled]="busy()" (click)="install(r.full, r.name + ' · ' + i18n.translate('firmware.fullLabel'))">
                <app-icon name="download" [size]="13" />{{ 'firmware.fullInstall' | transloco }} · {{ kb(r.full.size) }}
              </button>
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .fw {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(820px, 94vw); height: min(620px, 88vh); display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .fwh { display: flex; align-items: center; gap: 12px; padding: 13px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .fwh h3 { margin: 0; font-size: 15px; }
    .fwh .repo { font-family: var(--mono); font-size: 11px; color: var(--tx-low); text-decoration: none; }
    .fwh .repo:hover { color: var(--accent); }
    .grow { flex: 1; }
    .fwmsg { flex: 1; display: grid; place-items: center; color: var(--tx-low); font-family: var(--mono); font-size: 13px; }
    .fwmsg.err { color: var(--danger); }
    .fwbody { flex: 1; min-height: 0; display: flex; }
    .rlist { width: 240px; flex: 0 1 240px; min-width: 150px; border-right: 1px solid var(--line); overflow: auto; padding: 8px; }
    .ritem {
      display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; border: none; cursor: pointer;
      background: none; color: var(--tx); padding: 9px 10px; border-radius: 8px;
    }
    .ritem:hover { background: var(--elevated); }
    .ritem.on { background: var(--accent-soft); }
    .ritem .rname { font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
    .ritem .pre {
      font-style: normal; font-family: var(--mono); font-size: 9px; text-transform: uppercase;
      background: var(--elevated); color: var(--tx-low); padding: 1px 4px; border-radius: 4px;
    }
    .ritem .rmeta { font-family: var(--mono); font-size: 10.5px; color: var(--tx-low); }
    .rnotes { flex: 1; min-width: 0; overflow: auto; padding: 16px 20px; }
    .fwfoot { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel-2); }
    .fwfoot .dest { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; color: var(--tx-mid); }
    .fwfoot .ghfall { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 11px; color: var(--tx-low); padding-left: 14px; border-left: 1px solid var(--line); }
    .fwfoot .ghfall a { color: var(--tx-mid); text-decoration: none; }
    .fwfoot .ghfall a:hover { color: var(--accent); text-decoration: underline; }

    /* The release notes' Markdown is styled globally (styles/_markdown.scss): these rules used to
       live here, where emulated encapsulation kept them from ever reaching the [innerHTML] nodes. */
  `,
})
export class FirmwareDialog {
  readonly close = output<void>();
  protected readonly lib = inject(LibraryStore);
  protected readonly i18n = inject(TranslocoService);
  private readonly fw = inject(FirmwareService);

  protected readonly releases = signal<FwRelease[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly sel = signal<FwRelease | null>(null);
  protected readonly busy = computed(() => !!this.lib.bulk());

  constructor() {
    this.fw
      .listReleases()
      .then((rs) => {
        this.releases.set(rs);
        this.sel.set(rs[0] ?? null); // most recent, pre-selected
      })
      .catch((e: unknown) => this.error.set(e instanceof Error ? e.message : String(e)));
  }

  protected async install(a: FwAsset, label: string): Promise<void> {
    await this.lib.installFirmware(a.id, label);
  }

  protected kb(n: number): string {
    return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  }
}
