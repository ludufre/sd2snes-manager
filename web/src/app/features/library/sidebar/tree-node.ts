import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import type { FolderNode } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';
import { DropFolder } from '../../../ui/drop-folder.directive';
import { TranslocoModule } from '@jsverse/transloco';

/** One row of the folder tree. Recurses into its own selector for children.
 *  Hosts the per-folder context menu (new subfolder / rename / delete). */
@Component({
  selector: 'app-tree-node',
  imports: [Icon, DropFolder, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let n = node();
    <div
      class="tnode" [class.active]="active()" [appDropFolder]="n.path"
      [draggable]="!isRoot() && !editing()"
      (dragstart)="onDragStart($event)"
      (dragend)="lib.endDrag()"
      [style.paddingLeft.px]="8 + depth() * 15" (click)="lib.navTo(n.path)">
      @if (hasKids()) {
        <button class="texp" (click)="onToggle($event)">
          <app-icon name="chevron" [size]="13" [class.open]="open()" />
        </button>
      } @else {
        <span class="texp sp"></span>
      }
      <app-icon [name]="isRoot() || active() || open() ? 'folderOpen' : 'folder'" [size]="15" />

      @if (editing()) {
        <input
          #ri class="rename" [value]="n.name"
          (click)="$event.stopPropagation()"
          (keydown.enter)="commitRename(ri.value)"
          (keydown.escape)="editing.set(false)"
          (blur)="editing.set(false)" />
      } @else {
        <span class="tname">{{ isRoot() ? lib.rootName() : n.name }}</span>
        <span class="tcount">{{ n.total || n.themeTotal }}</span>
        @if (!isRoot()) {
          <button class="menu-btn" [class.on]="menuOpen()" [title]="'sidebar.folderActions' | transloco" (click)="toggleMenu($event)">
            <app-icon name="moreHorizontal" [size]="14" />
          </button>
        }
      }
    </div>

    @if (menuOpen()) {
      <div class="menu-scrim" (click)="closeMenu($event)"></div>
      <div class="menu" [style.left.px]="menuPos().x" [style.top.px]="menuPos().y" (click)="$event.stopPropagation()">
        <button (click)="newSub()"><app-icon name="folderPlus" [size]="14" />{{ 'sidebar.newSubfolder' | transloco }}</button>
        <button (click)="startRename()"><app-icon name="edit" [size]="14" />{{ 'sidebar.rename' | transloco }}</button>
        <button class="danger" (click)="del()"><app-icon name="trash" [size]="14" />{{ 'sidebar.delete' | transloco }}</button>
      </div>
    }

    @if (open() && hasKids()) {
      @for (c of n.childList; track c.path) {
        <app-tree-node [node]="c" [depth]="depth() + 1" />
      }
    }
  `,
  styles: `
    :host { display: block; position: relative; }
    .tnode {
      display: flex; align-items: center; gap: 7px; padding: 7px 8px; border-radius: 7px;
      cursor: pointer; color: var(--tx-mid); transition: 0.1s; user-select: none; position: relative;
    }
    .tnode:hover { background: var(--elevated); color: var(--tx); }
    .tnode.active { background: var(--accent-soft); color: var(--accent); }
    .tname { flex: 1; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tcount { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .tnode.active .tcount { color: var(--accent); }
    .texp {
      width: 16px; height: 16px; flex: 0 0 auto; display: grid; place-items: center;
      border: none; background: none; color: var(--tx-low); padding: 0; border-radius: 4px; cursor: pointer;
    }
    .texp:hover { background: var(--line); color: var(--tx); }
    .texp.sp { pointer-events: none; }
    .texp app-icon { transition: transform 0.12s; }
    .texp app-icon.open { transform: rotate(90deg); }
    .menu-btn {
      width: 18px; height: 18px; flex: 0 0 auto; display: grid; place-items: center; border: none; background: none;
      color: var(--tx-low); padding: 0; border-radius: 4px; cursor: pointer; opacity: 0; transition: 0.1s;
    }
    .tnode:hover .menu-btn, .menu-btn.on { opacity: 1; }
    .menu-btn:hover { background: var(--line); color: var(--tx); }
    .rename {
      flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--accent-line); border-radius: 5px;
      color: var(--tx); font-family: var(--sans); font-size: 13px; padding: 3px 6px; outline: none;
    }
    .menu-scrim { position: fixed; inset: 0; z-index: 30; }
    .menu {
      position: fixed; z-index: 31; min-width: 160px;
      background: var(--elevated); border: 1px solid var(--line); border-radius: 9px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5); padding: 5px; display: flex; flex-direction: column;
    }
    .menu button {
      display: flex; align-items: center; gap: 9px; border: none; background: none; color: var(--tx);
      font-family: var(--sans); font-size: 13px; text-align: left; padding: 7px 9px; border-radius: 6px; cursor: pointer;
    }
    .menu button:hover { background: var(--panel); }
    .menu button.danger { color: var(--danger); }
    .menu button.danger:hover { background: var(--danger-soft); }
  `,
})
export class TreeNode {
  protected readonly lib = inject(LibraryStore);
  readonly node = input.required<FolderNode>();
  readonly depth = input(0);

  protected readonly isRoot = computed(() => this.node().path === '');
  protected readonly hasKids = computed(() => this.node().childList.length > 0);
  protected readonly open = computed(() => this.isRoot() || this.lib.expanded().has(this.node().path));
  protected readonly active = computed(() => this.lib.cwd() === this.node().path);

  protected readonly menuOpen = signal(false);
  protected readonly menuPos = signal({ x: 0, y: 0 });
  protected readonly editing = signal(false);
  private readonly ri = viewChild<ElementRef<HTMLInputElement>>('ri');

  constructor() {
    effect(() => {
      const el = this.ri()?.nativeElement;
      if (el) { el.focus(); el.select(); }
    });
  }

  protected onToggle(e: Event): void {
    e.stopPropagation();
    this.lib.toggleExp(this.node().path);
  }
  protected onDragStart(e: DragEvent): void {
    // don't start a folder drag when the gesture begins on a button/input
    // (expand chevron, ⋯ menu, rename field), otherwise their clicks break
    if ((e.target as HTMLElement).closest('button, input')) {
      e.preventDefault();
      return;
    }
    this.lib.beginDragFolder(this.node().path);
    e.stopPropagation();
  }
  protected toggleMenu(e: Event): void {
    e.stopPropagation();
    if (!this.menuOpen()) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.menuPos.set({ x: r.left, y: r.bottom + 4 });
    }
    this.menuOpen.update((v) => !v);
  }
  protected closeMenu(e: Event): void { e.stopPropagation(); this.menuOpen.set(false); }

  protected newSub(): void { this.menuOpen.set(false); this.lib.startNewFolder(this.node().path); }
  protected startRename(): void { this.menuOpen.set(false); this.editing.set(true); }
  protected commitRename(name: string): void {
    this.editing.set(false);
    if (name.trim() && name.trim() !== this.node().name) this.lib.renameFolder(this.node().path, name);
  }
  protected del(): void { this.menuOpen.set(false); void this.lib.deleteFolder(this.node().path); }
}
