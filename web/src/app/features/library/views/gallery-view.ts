import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import type { FolderNode } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';
import { Checkbox } from '../../../ui/checkbox/checkbox';
import { CoverArt } from '../../../ui/cover-art/cover-art';
import { AssetIcons } from '../../../ui/badge/asset-icons';
import { StatusBadge } from '../../../ui/badge/status-badge';
import { DropFolder } from '../../../ui/drop-folder.directive';
import { DragEntry } from '../../../ui/drag-entry.directive';
import { ContextEntry } from '../../../ui/context-entry.directive';
import { ContextTheme } from '../../../ui/context-theme.directive';

/** Box-art card grid view, + folder cards. */
@Component({
  selector: 'app-gallery-view',
  imports: [Icon, Checkbox, CoverArt, AssetIcons, StatusBadge, DropFolder, DragEntry, ContextEntry, ContextTheme, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gallery">
      @if (lib.cwd() && !lib.query()) {
        <div class="gcard folder up" (click)="lib.navUp()">
          <div class="cv folderico"><app-icon name="folder" [size]="44" /></div>
          <div class="meta">
            <div class="t">..</div>
            <div class="bdgs"><app-status-badge kind="muted" [dot]="false">{{ 'views.folderUp' | transloco }}</app-status-badge></div>
          </div>
        </div>
      }

      @for (f of lib.visibleFolders(); track f.path) {
        <div class="gcard folder" [appDropFolder]="f.path" (click)="lib.navTo(f.path)">
          <div class="cv folderico">
            <app-icon name="folder" [size]="44" /><span class="fcount">{{ f.total }}</span>
          </div>
          <div class="meta">
            <div class="t">{{ f.name }}</div>
            <div class="bdgs"><app-status-badge kind="muted" [dot]="false">{{ folderSub(f) }}</app-status-badge></div>
          </div>
        </div>
      }

      @for (g of lib.filtered(); track g.id) {
        <div
          class="gcard"
          [class.sel]="g.id === lib.selId()"
          [class.checked]="lib.selected().has(g.id)"
          [appDragEntry]="g.id"
          [appContextEntry]="g"
          (click)="lib.select(g.id)">
          <div class="cv">
            <div class="gck" [title]="'views.selectForBatch' | transloco" (click)="$event.stopPropagation(); lib.toggleSel(g.id)">
              <app-checkbox [checked]="lib.selected().has(g.id)" [overlay]="true" (changed)="lib.toggleSel(g.id)" />
            </div>
            <app-cover-art [entry]="g" [showFmt]="true" />
          </div>
          <div class="meta">
            <div class="t">{{ g.title }}</div>
            <div class="bdgs">
              <app-asset-icons [entry]="g" />
            </div>
          </div>
        </div>
      }

      @for (t of lib.themesInCwd(); track t.id) {
        <div class="gcard theme" [class.active]="lib.isThemeActive(t)" [appContextTheme]="t" [title]="'views.themeHint' | transloco">
          <div class="cv themeico">
            @if (lib.themePreviewUrl(t); as url) { <img referrerpolicy="no-referrer" [src]="url" [alt]="t.stem" /> }
            @else { <app-icon name="palette" [size]="44" /> }
          </div>
          <div class="meta">
            <div class="t">{{ t.stem }}</div>
            <div class="bdgs">
              @if (lib.isThemeActive(t)) {
                <app-status-badge kind="ok" [dot]="false">{{ 'views.themeActive' | transloco }}</app-status-badge>
              } @else {
                <app-status-badge kind="info" [dot]="false">{{ 'views.themeBadge' | transloco }}</app-status-badge>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .gallery {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 16px; padding: 20px; align-content: start;
    }
    .gcard {
      background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
      cursor: pointer; transition: 0.14s; display: flex; flex-direction: column;
    }
    .gcard:hover { border-color: var(--tx-low); transform: translateY(-2px); }
    .gcard.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .gcard.checked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .gcard .cv { width: 100%; border-radius: 0; container-type: inline-size; position: relative; }
    .gcard .meta { padding: 11px 12px; display: flex; flex-direction: column; gap: 8px; }
    .gcard .meta .t {
      font-weight: 500; font-size: 13px; line-height: 1.25; display: -webkit-box;
      -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.5em;
    }
    .gcard .meta .bdgs { display: flex; gap: 6px; flex-wrap: wrap; }
    /* Hidden until hover/checked — pointer-events:none so its hit area doesn't swallow corner clicks
       meant to open the detail panel. When visible, padding gives a generous click target (the whole
       div toggles selection; the checkbox itself is purely visual). */
    .gck { position: absolute; top: 0; left: 0; z-index: 4; opacity: 0; pointer-events: none; padding: 8px 14px 14px 8px; cursor: pointer; transition: opacity 0.12s; }
    .gcard:hover .gck, .gcard.checked .gck { opacity: 1; pointer-events: auto; }
    /* folder card */
    .gcard.folder .cv.folderico {
      aspect-ratio: 4 / 3; display: grid; place-items: center; position: relative; color: var(--accent);
      background: radial-gradient(120% 120% at 50% 0%, var(--accent-soft), transparent 65%), var(--panel-2);
    }
    .gcard.folder .cv .fcount {
      position: absolute; bottom: 8px; right: 10px; font-family: var(--mono); font-size: 12px; font-weight: 700; color: var(--tx-mid);
    }
    /* theme (.thm) card — right-click to set/remove */
    .gcard.theme { cursor: context-menu; }
    .gcard.theme .cv.themeico {
      aspect-ratio: 4 / 3; display: grid; place-items: center; color: var(--accent); overflow: hidden;
      background: radial-gradient(120% 120% at 50% 0%, var(--accent-soft), transparent 65%), var(--panel-2);
    }
    .gcard.theme .cv.themeico img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .gcard.theme.active { border-color: var(--ok, #3ecf6b); box-shadow: 0 0 0 1px var(--ok, #3ecf6b); }
  `,
})
export class GalleryView {
  protected readonly lib = inject(LibraryStore);
  private readonly i18n = inject(TranslocoService);

  protected folderSub(f: FolderNode): string {
    const k = f.childList.length;
    const folders = k
      ? this.i18n.translate(k > 1 ? 'views.foldersCount' : 'views.folderCount', { count: k }) + ' · '
      : '';
    const parts: string[] = [];
    if (f.total > 0 || f.themeTotal === 0) parts.push(this.i18n.translate(f.total === 1 ? 'views.gameCount' : 'views.gamesCount', { count: f.total }));
    if (f.themeTotal > 0) parts.push(this.i18n.translate(f.themeTotal === 1 ? 'views.themeCountOne' : 'views.themeCountMany', { count: f.themeTotal }));
    return folders + parts.join(' · ');
  }
}
