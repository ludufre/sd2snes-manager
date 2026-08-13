import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { ContextMenuService, type ContextTarget } from '../../core/context-menu.service';
import { LibraryStore } from '../../core/library-store';
import type { Entry, ThemeFile } from '../../core/models';
import { Icon } from '../icon/icon';

/** Single host for the ROM right-click menu (mounted once in library.html). */
@Component({
  selector: 'app-context-menu',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = ctx.state();
    @if (s) {
      <div class="scrim" (click)="ctx.close()" (contextmenu)="$event.preventDefault(); ctx.close()"></div>
      <div class="menu" [style.left.px]="pos().x" [style.top.px]="pos().y">
        @if (entryOf(s); as g) {
        <button (click)="open(g)"><app-icon name="split" [size]="14" />{{ 'ctxmenu.openDetails' | transloco }}</button>
        @if (g.fileHandle && !g.identified) {
          <button (click)="identify(g)"><app-icon name="spark" [size]="14" />{{ 'ctxmenu.identify' | transloco }}</button>
        }
        @if (g.cover === 'available') {
          <button (click)="genCover(g)"><app-icon name="image" [size]="14" />{{ 'ctxmenu.genCover' | transloco }}</button>
        }
        @if (g.cheats === 'available') {
          <button (click)="dlCheats(g)"><app-icon name="download" [size]="14" />{{ 'ctxmenu.dlCheats' | transloco }}</button>
        }
        <div class="sep"></div>
        <button (click)="move(g)"><app-icon name="move" [size]="14" />{{ 'ctxmenu.moveTo' | transloco }}</button>
        <button (click)="copy(g)"><app-icon name="plus" [size]="14" />{{ 'ctxmenu.copyTo' | transloco }}</button>
        @let hasCover = g.cover === 'has' || g.cover === 'custom' || g.gcv === 'has';
        @let hasPreview = g.snapshot === 'has' || g.fmv === 'has';
        @if (hasCover || hasPreview || g.info === 'has' || g.cheats === 'has' || g.state === 'has' || g.save) {
          <div class="sep"></div>
          @if (hasCover) {
            <button (click)="delCover(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delCover' | transloco }}</button>
          }
          @if (hasPreview) {
            <button (click)="delPreview(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delPreview' | transloco }}</button>
          }
          @if (g.info === 'has') {
            <button (click)="delInfo(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delInfo' | transloco }}</button>
          }
          @if (g.cheats === 'has') {
            <button (click)="delCheats(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delCheats' | transloco }}</button>
          }
          @if (g.state === 'has') {
            <button class="danger" (click)="delStates(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delStates' | transloco }}</button>
          }
          @if (g.save) {
            <button class="danger" (click)="delSave(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delSave' | transloco }}</button>
          }
        }
        <div class="sep"></div>
        <button class="danger" (click)="del(g)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.delete' | transloco }}</button>
        } @else if (themeOf(s); as t) {
        <button (click)="setTheme(t)"><app-icon name="palette" [size]="14" />{{ 'ctxmenu.setTheme' | transloco }}</button>
        <div class="sep"></div>
        <button class="danger" (click)="removeTheme(t)"><app-icon name="trash" [size]="14" />{{ 'ctxmenu.removeTheme' | transloco }}</button>
        }
      </div>
    }
  `,
  styles: `
    .scrim { position: fixed; inset: 0; z-index: 64; }
    .menu {
      position: fixed; z-index: 65; min-width: 190px;
      background: var(--elevated); border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55); padding: 5px; display: flex; flex-direction: column;
      animation: pop 0.12s ease;
    }
    @keyframes pop { from { transform: scale(0.97); opacity: 0; } }
    .menu button {
      display: flex; align-items: center; gap: 10px; border: none; background: none; color: var(--tx);
      font-family: var(--sans); font-size: 13px; text-align: left; padding: 8px 10px; border-radius: 7px; cursor: pointer;
    }
    .menu button:hover { background: var(--panel); }
    .menu button.danger { color: var(--danger); }
    .menu button.danger:hover { background: var(--danger-soft); }
    .sep { height: 1px; background: var(--line); margin: 4px 2px; }
  `,
})
export class ContextMenu {
  protected readonly ctx = inject(ContextMenuService);
  protected readonly lib = inject(LibraryStore);

  protected readonly pos = computed(() => {
    const s = this.ctx.state();
    if (!s) return { x: 0, y: 0 };
    const w = 200, h = 460; // tall enough for all the per-asset delete rows near the screen edge
    return {
      x: Math.min(s.x, window.innerWidth - w - 8),
      y: Math.min(s.y, window.innerHeight - h - 8),
    };
  });

  protected entryOf(s: ContextTarget): Entry | null { return 'entry' in s ? s.entry : null; }
  protected themeOf(s: ContextTarget): ThemeFile | null { return 'theme' in s ? s.theme : null; }

  private ids(g: Entry): ReadonlySet<string> {
    const sel = this.lib.selected();
    return sel.has(g.id) ? sel : new Set([g.id]);
  }

  protected setTheme(t: ThemeFile): void { void this.lib.setActiveTheme(t); this.ctx.close(); }
  protected removeTheme(t: ThemeFile): void { void this.lib.removeTheme(t); this.ctx.close(); }

  protected open(g: Entry): void { this.lib.select(g.id); this.ctx.close(); }
  protected identify(g: Entry): void { void this.lib.identifyAndShow(g); this.ctx.close(); }
  protected genCover(g: Entry): void { void this.lib.genCover(g); this.ctx.close(); }
  protected dlCheats(g: Entry): void { void this.lib.dlCheats(g); this.ctx.close(); }
  protected move(g: Entry): void { this.lib.openPicker('move', this.ids(g)); this.ctx.close(); }
  protected copy(g: Entry): void { this.lib.openPicker('copy', this.ids(g)); this.ctx.close(); }
  protected delCover(g: Entry): void { void this.lib.delCover(g); this.ctx.close(); }
  protected delPreview(g: Entry): void { void this.lib.delPreview(g); this.ctx.close(); }
  protected delInfo(g: Entry): void { void this.lib.delInfo(g); this.ctx.close(); }
  protected delCheats(g: Entry): void { void this.lib.delCheats(g); this.ctx.close(); }
  protected delStates(g: Entry): void { void this.lib.delStates(g); this.ctx.close(); }
  protected delSave(g: Entry): void { void this.lib.delSave(g); this.ctx.close(); }
  protected del(g: Entry): void { void this.lib.delRom(g); this.ctx.close(); }
}
