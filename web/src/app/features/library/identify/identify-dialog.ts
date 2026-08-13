import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import type { Entry } from '../../../core/models';
import { LibraryStore } from '../../../core/library-store';
import { cdnUrl } from '../../../core/env';
import { Icon } from '../../../ui/icon/icon';

/**
 * "Available in the GameDB", opened after Identify. Previews the gamedb cover / screenshot / video
 * and lets you generate them onto the card (or download the raw asset). The list and the ficha keep
 * showing only what's actually on the SD card; this dialog is the separate "what's available" view.
 */
@Component({
  selector: 'app-identify-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let g = entry();
    <div class="scrim" (click)="close.emit()"></div>
    <div class="idg">
      <div class="idh">
        <h3>{{ 'identify.title' | transloco }}</h3>
        <span class="idsub">{{ g.title }}</span>
        <div class="grow"></div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      @if (!g.matched) {
        <div class="idmsg">{{ 'identify.noMatch' | transloco }}</div>
      } @else {
        <div class="idbody scroll">
          <div class="idcard">
            <div class="idcap">{{ 'identify.cover' | transloco }}</div>
            @if (g.coverUrl) {
              <img class="idmedia" [src]="cdn(g.coverUrl)" crossorigin="anonymous" [alt]="'identify.coverAlt' | transloco" />
              <div class="idactions">
                <button class="btn sm primary" type="button" [disabled]="g.busy === 'cover'" (click)="lib.genCover(g)">
                  <app-icon name="spark" [size]="13" />{{ g.busy === 'cover' ? ('identify.generating' | transloco) : (g.cover === 'has' ? ('identify.regenCover' | transloco) : ('identify.genCover' | transloco)) }}
                </button>
                <button class="btn sm" type="button" (click)="download(g.coverUrl, g.title + ' cover')"><app-icon name="download" [size]="13" />{{ 'identify.download' | transloco }}</button>
              </div>
            } @else { <div class="idnone">{{ 'identify.none' | transloco }}</div> }
          </div>

          <div class="idcard">
            <div class="idcap">{{ 'identify.screenshot' | transloco }}</div>
            @if (g.screenshotUrl) {
              <img class="idmedia" [src]="cdn(g.screenshotUrl)" crossorigin="anonymous" [alt]="'identify.screenshotAlt' | transloco" />
              <div class="idactions">
                <button class="btn sm" type="button" (click)="download(g.screenshotUrl, g.title + ' screenshot')"><app-icon name="download" [size]="13" />{{ 'identify.download' | transloco }}</button>
              </div>
            } @else { <div class="idnone">{{ 'identify.none' | transloco }}</div> }
          </div>

          <div class="idcard">
            <div class="idcap">{{ 'identify.videoToSnapshot' | transloco }}</div>
            @if (g.videoUrl) {
              <video class="idmedia" [src]="cdn(g.videoUrl)" crossorigin="anonymous" autoplay muted loop playsinline controls></video>
              <div class="idactions">
                <button class="btn sm primary" type="button" [disabled]="g.busy === 'fmv'" (click)="lib.genFmvFromGamedb(g)">
                  <app-icon name="spark" [size]="13" />{{ g.busy === 'fmv' ? ('identify.generating' | transloco) : ('identify.genFmv' | transloco) }}
                </button>
                <button class="btn sm" type="button" (click)="download(g.videoUrl, g.title + ' video')"><app-icon name="download" [size]="13" />{{ 'identify.download' | transloco }}</button>
              </div>
            } @else { <div class="idnone">{{ 'identify.none' | transloco }}</div> }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .idg {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(560px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .idh { display: flex; align-items: center; gap: 12px; padding: 13px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .idh h3 { margin: 0; font-size: 15px; white-space: nowrap; }
    .idh .idsub { font-size: 12px; color: var(--tx-low); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow { flex: 1; }
    .idmsg { padding: 28px; text-align: center; color: var(--tx-low); font-family: var(--mono); font-size: 13px; }
    .idbody { overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
    .idcard { display: flex; flex-direction: column; gap: 8px; }
    .idcap { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--tx-mid); }
    .idmedia { max-width: 100%; max-height: 200px; width: auto; align-self: flex-start; border-radius: 8px;
               border: 1px solid var(--line-soft); background: #000; object-fit: contain; }
    .idactions { display: flex; gap: 8px; flex-wrap: wrap; }
    .idnone { font-family: var(--mono); font-size: 12px; color: var(--tx-low); }
  `,
})
export class IdentifyDialog {
  readonly entry = input.required<Entry>();
  readonly close = output<void>();
  protected readonly lib = inject(LibraryStore);
  protected readonly cdn = cdnUrl;

  /** Save the raw gamedb asset to the user's computer. */
  protected async download(url: string, name: string): Promise<void> {
    try {
      const resp = await fetch(cdnUrl(url) as string, { mode: 'cors' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const ext = (resp.headers.get('content-type') ?? '').split(';')[0].split('/')[1] || 'bin';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error('[identify] download failed', url, e);
    }
  }
}
