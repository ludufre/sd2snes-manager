import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { Icon } from '../../../ui/icon/icon';
import { decodeManFile } from '../../../lib/man.js';
import { imagesToPdf } from '../../../lib/pdf-export.js';
import { downloadBlob } from '../../../core/download';
import { ToastService } from '../../../core/toast.service';

type Page = { url: string; w: number; h: number };

/** RGB {rgb,w,h} page -> an opaque canvas (drops nothing; the decoded page is already opaque). */
function rgbToCanvas(rgb: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * 3, o = i * 4;
    d[o] = rgb[s]; d[o + 1] = rgb[s + 1]; d[o + 2] = rgb[s + 2]; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function canvasToJpeg(cv: HTMLCanvasElement, quality = 0.85): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    cv.toBlob(
      (b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * View a `.man` Manual/Guide straight from the card: decodes it back to RGB pages (lib/man.js
 * decodeManFile, the inverse of the encoder, 1× blocks only) and renders each page as a pixel-perfect
 * image, exactly the way we already preview a `.cov`/`.gcv`/`.fmv` (canvas render, no firmware). A
 * "Baixar PDF" button converts the decoded pages into a real PDF (lib/pdf-export.js, one jpeg per
 * page, no dependency) so the user can read/print/share it outside the app. Molde: guides-editor.ts. */
@Component({
  selector: 'app-man-viewer',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="ed">
      <div class="eh">
        <div>
          <h3>{{ label() || ('guides.title' | transloco) }}</h3>
          @if (!loading() && !error()) {
            <span class="sub">{{ 'guides.pages' | transloco: { count: pages().length } }}</span>
          }
        </div>
        <div class="zoom">
          @for (z of zoomSteps; track z) {
            <button type="button" class="zb" [class.on]="scale() === z" (click)="scale.set(z)">{{ z }}×</button>
          }
        </div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="ebody scroll">
        @if (loading()) {
          <div class="empty">{{ 'manViewer.rendering' | transloco }}</div>
        } @else if (error()) {
          <div class="empty err">{{ 'manViewer.error' | transloco }}</div>
        } @else if (!pages().length) {
          <div class="empty">{{ 'guides.empty' | transloco }}</div>
        } @else {
          @for (p of pages(); track $index) {
            <img class="pg" [src]="p.url" [style.width.px]="p.w * scale()" [alt]="'p' + ($index + 1)" loading="lazy" />
          }
        }
      </div>

      <div class="ef">
        <span class="cap">{{ label() }}</span>
        <div class="grow"></div>
        <button class="btn sm primary" type="button" [disabled]="loading() || error() || !pages().length || exporting()" (click)="downloadPdf()">
          <app-icon name="download" [size]="13" />{{ (exporting() ? 'manViewer.exporting' : 'manViewer.downloadPdf') | transloco }}
        </button>
        <button class="btn ghost sm" type="button" (click)="close.emit()">{{ 'guides.close' | transloco }}</button>
      </div>
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 60; }
    .ed {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 61;
      width: min(720px, 96vw); max-height: 92vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .eh { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .eh > div:first-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .eh h3 { margin: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .eh .sub { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .zoom { display: flex; gap: 4px; }
    .zb { font-family: var(--mono); font-size: 11px; padding: 4px 8px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg); color: var(--tx-mid); cursor: pointer; }
    .zb:hover { border-color: var(--accent); }
    .zb.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .ebody { overflow: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; align-items: center; background: var(--panel-2); }
    .pg { image-rendering: pixelated; max-width: 100%; height: auto; border-radius: 4px; border: 1px solid var(--line); background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
    .empty { color: var(--tx-low); font-family: var(--mono); font-size: 13px; padding: 40px; text-align: center; }
    .empty.err { color: var(--danger); }
    .ef { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel-2); }
    .cap { font-family: var(--mono); font-size: 11px; color: var(--tx-low); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow { flex: 1; }
  `,
})
export class ManViewer {
  /** Raw on-card `.man` bytes to render (already inflated, never `.man.zst`). */
  readonly bytes = input.required<Uint8Array>();
  /** Already-localized document label for the header/footer (e.g. the type name). */
  readonly label = input<string>('');
  /** Base name for the exported PDF (no extension). */
  readonly filename = input<string>('manual');
  readonly close = output<void>();

  private readonly i18n = inject(TranslocoService);
  private readonly toast = inject(ToastService);

  protected readonly zoomSteps = [1, 2, 3];
  protected readonly scale = signal(2);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly exporting = signal(false);
  protected readonly pages = signal<Page[]>([]);

  constructor() {
    effect(() => {
      const bytes = this.bytes();
      void this.render(bytes);
    });
  }

  private async render(bytes: Uint8Array): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    this.pages.set([]);
    // Let the "rendering..." state paint before the synchronous decode (a big manual is ~hundreds of
    // blocks, a brief main-thread freeze; without this yield the user would just see a frozen dialog).
    await new Promise((r) => requestAnimationFrame(r));
    try {
      const { pages } = decodeManFile(bytes);
      const out: Page[] = pages.map((p) => ({ url: rgbToCanvas(p.rgb, p.width, p.height).toDataURL('image/png'), w: p.width, h: p.height }));
      this.pages.set(out);
    } catch (e) {
      console.error('[man-viewer] decode failed', e);
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async downloadPdf(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      // Re-decode from the source bytes (cheap tile-unpack) so we don't keep raw RGB around after render.
      const { pages } = decodeManFile(this.bytes());
      const imgs: Array<{ jpeg: Uint8Array; width: number; height: number }> = [];
      for (const p of pages) {
        const jpeg = await canvasToJpeg(rgbToCanvas(p.rgb, p.width, p.height));
        imgs.push({ jpeg, width: p.width, height: p.height });
      }
      const pdf = imagesToPdf(imgs);
      downloadBlob(`${this.filename()}.pdf`, pdf, 'application/pdf');
    } catch (e) {
      console.error('[man-viewer] pdf export failed', e);
      this.toast.show(this.i18n.translate('manViewer.error'), 'warn');
    } finally {
      this.exporting.set(false);
    }
  }
}
