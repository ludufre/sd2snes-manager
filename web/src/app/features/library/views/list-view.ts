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

/** Dense list/table view: arte · jogo · CRC32 · status (Capa·Snapshot·Prévia·Cheats), + folder rows. */
@Component({
  selector: 'app-list-view',
  imports: [Icon, Checkbox, CoverArt, AssetIcons, StatusBadge, DropFolder, DragEntry, ContextEntry, ContextTheme, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="list">
      <div class="lrow head">
        <div class="ck" [title]="'views.selectAll' | transloco" (click)="$event.stopPropagation(); lib.toggleAllFiltered()">
          <app-checkbox [checked]="lib.allFilteredOn()" [indeterminate]="lib.someFilteredOn()" (changed)="lib.toggleAllFiltered()" />
        </div>
        <div>{{ 'views.colArt' | transloco }}</div><div>{{ 'views.colGame' | transloco }}</div><div class="crc">CRC32</div><div class="ast">{{ 'views.colStatus' | transloco }}</div><div></div>
      </div>

      @if (lib.cwd() && !lib.query()) {
        <div class="lrow folder up" (click)="lib.navUp()">
          <div class="ck"></div>
          <div class="cv folderico"><app-icon name="folder" [size]="20" /></div>
          <div class="name"><div class="t">..</div><div class="f">{{ 'views.folderUp' | transloco }}</div></div>
          <div class="crc"></div>
          <div class="ast"></div>
          <div class="chev"></div>
        </div>
      }

      @for (f of lib.visibleFolders(); track f.path) {
        <div class="lrow folder" [appDropFolder]="f.path" (click)="lib.navTo(f.path)">
          <div class="ck"></div>
          <div class="cv folderico"><app-icon name="folder" [size]="20" /></div>
          <div class="name">
            <div class="t">{{ f.name }}</div>
            <div class="f">{{ folderSub(f) }}</div>
          </div>
          <div class="crc"></div>
          <div class="ast"><app-status-badge kind="muted" [dot]="false">{{ 'views.folder' | transloco }}</app-status-badge></div>
          <div class="chev"><app-icon name="chevron" [size]="16" /></div>
        </div>
      }

      @for (g of lib.filtered(); track g.id) {
        <div
          class="lrow"
          [class.sel]="g.id === lib.selId()"
          [class.checked]="lib.selected().has(g.id)"
          [appDragEntry]="g.id"
          [appContextEntry]="g"
          (click)="lib.select(g.id)">
          <div class="ck" [title]="'views.selectForBatch' | transloco" (click)="$event.stopPropagation(); lib.toggleSel(g.id)">
            <app-checkbox [checked]="lib.selected().has(g.id)" (changed)="lib.toggleSel(g.id)" />
          </div>
          <div class="cv"><app-cover-art [entry]="g" /></div>
          <div class="name">
            <div class="t">{{ g.title }}</div>
            <div class="f">{{ g.file }}</div>
          </div>
          <div class="crc">{{ g.crc }}</div>
          <div class="ast"><app-asset-icons [entry]="g" /></div>
          <div class="chev"><app-icon name="chevron" [size]="16" /></div>
        </div>
      }

      @for (t of lib.themesInCwd(); track t.id) {
        <div class="lrow theme" [class.active]="lib.isThemeActive(t)" [appContextTheme]="t" [title]="'views.themeHint' | transloco">
          <div class="ck"></div>
          <div class="cv themeico">
            @if (lib.themePreviewUrl(t); as url) { <img referrerpolicy="no-referrer" [src]="url" [alt]="t.stem" /> }
            @else { <app-icon name="palette" [size]="20" /> }
          </div>
          <div class="name">
            <div class="t">{{ t.stem }}</div>
            <div class="f">{{ t.name }}</div>
          </div>
          <div class="crc"></div>
          <div class="ast">
            @if (lib.isThemeActive(t)) {
              <app-status-badge kind="ok" [dot]="false">{{ 'views.themeActive' | transloco }}</app-status-badge>
            } @else {
              <app-status-badge kind="info" [dot]="false">{{ 'views.themeBadge' | transloco }}</app-status-badge>
            }
          </div>
          <div class="chev"></div>
        </div>
      }
    </div>
  `,
  styles: `
    /* Named container so the rows react to the space the list ACTUALLY got — which depends on the
       sidebar and detail panel being open, not just on the window. (The anonymous container on .cv
       below is the cover-art's own; naming this one keeps the two from being confused.) */
    .list { width: 100%; container: list / inline-size; }
    .lrow {
      display: grid; grid-template-columns: 40px 44px 1fr 110px 150px 40px;
      align-items: center; gap: 14px; height: var(--row-h); padding: 0 20px;
      border-bottom: 1px solid var(--line-soft); cursor: pointer; transition: background 0.1s;
    }
    /* 384px of the row is fixed columns. CRC32 is pure reference — it goes first. The asset column
       only gets narrower, never dropped: "what's missing" is the point of this screen. */
    @container list (max-width: 760px) {
      .lrow { grid-template-columns: 40px 44px 1fr 150px 40px; }
      .lrow > .crc { display: none; }
    }
    /* The asset column fits 5 icons (5x15px + 4x7px gap = 103px); the old 96px was sized for 4 and
       pushed the last indicator under the chevron. */
    @container list (max-width: 620px) {
      .lrow { grid-template-columns: 34px 40px 1fr 108px 28px; gap: 10px; padding: 0 12px; }
    }
    .lrow:hover { background: var(--panel); }
    .lrow.sel { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
    .lrow.checked { background: color-mix(in oklab, var(--accent) 9%, transparent); }
    .lrow.checked.sel { background: var(--accent-soft); }
    /* The whole cell is the click target (toggles selection) — generous hit area so a near-miss
       doesn't open the detail panel. The inner checkbox stays interactive (pointer + keyboard); its
       own click stops propagation, so clicking the box and clicking the cell never double-toggle. */
    .ck { display: grid; place-items: center; align-self: stretch; cursor: pointer; }
    .lrow.head {
      height: 38px; cursor: default; background: var(--bg); position: sticky; top: 0; z-index: 4;
      font-family: var(--mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--tx-low);
      border-bottom: 1px solid var(--line);
    }
    .lrow.head:hover { background: var(--bg); }
    .cv { width: 44px; aspect-ratio: 4 / 3; container-type: inline-size; }
    .name { min-width: 0; }
    .name .t { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name .f { font-family: var(--mono); font-size: 11px; color: var(--tx-low); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .crc { font-family: var(--mono); font-size: 12px; color: var(--tx-mid); }
    .chev { color: var(--tx-low); display: grid; place-items: center; }
    .lrow.folder:hover { background: var(--panel); }
    .cv.folderico { display: grid; place-items: center; color: var(--accent); }
    .lrow.folder .name .t { font-weight: 600; }
    /* theme (.thm) rows — right-click to set/remove; a subtle accent ring marks the active one */
    .lrow.theme { cursor: context-menu; }
    .cv.themeico { display: grid; place-items: center; color: var(--accent); overflow: hidden; border-radius: 4px; }
    .cv.themeico img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .lrow.theme.active { box-shadow: inset 3px 0 0 var(--ok, #3ecf6b); }
    .lrow.theme.active .name .t { color: var(--ok, #3ecf6b); }
  `,
})
export class ListView {
  protected readonly lib = inject(LibraryStore);
  private readonly i18n = inject(TranslocoService);

  protected folderSub(f: FolderNode): string {
    const kids = f.childList.length;
    const folders = kids
      ? this.i18n.translate(kids > 1 ? 'views.foldersCount' : 'views.folderCount', { count: kids }) + ' · '
      : '';
    const parts: string[] = [];
    if (f.total > 0 || f.themeTotal === 0) parts.push(this.i18n.translate(f.total === 1 ? 'views.gameCount' : 'views.gamesCount', { count: f.total }));
    if (f.themeTotal > 0) parts.push(this.i18n.translate(f.themeTotal === 1 ? 'views.themeCountOne' : 'views.themeCountMany', { count: f.themeTotal }));
    return folders + parts.join(' · ');
  }
}
