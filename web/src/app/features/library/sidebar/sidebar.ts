import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import { TreeNode } from './tree-node';
import { Icon } from '../../../ui/icon/icon';
import { TranslocoModule } from '@jsverse/transloco';

/** Folder tree sidebar (SD Card → folders, counts, expand/collapse) + new-folder. */
@Component({
  selector: 'app-sidebar',
  imports: [TreeNode, Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="sidebar">
      <div class="sb-head">
        <span>{{ 'sidebar.folders' | transloco }}</span>
        <button class="addbtn" type="button" [title]="'sidebar.newFolderTitle' | transloco" (click)="lib.startNewFolder(lib.cwd())">
          <app-icon name="folderPlus" [size]="15" />
        </button>
      </div>

      @if (lib.newFolderParent() !== null) {
        <div class="newrow">
          <app-icon name="folder" [size]="14" />
          <input
            #ni class="newinput"
            [placeholder]="'sidebar.newFolderIn' | transloco: { folder: lib.newFolderParent() || lib.rootName() }"
            (keydown.enter)="commit(ni.value)"
            (keydown.escape)="lib.cancelNewFolder()"
            (blur)="lib.cancelNewFolder()" />
        </div>
      }

      <div class="sb-scroll scroll">
        <div class="ftree">
          <app-tree-node [node]="lib.tree()" [depth]="0" />
        </div>
      </div>
    </aside>
  `,
  styles: `
    :host { display: contents; }
    .sidebar {
      width: 224px; flex: 0 0 224px; border-right: 1px solid var(--line);
      background: var(--panel); display: flex; flex-direction: column; min-height: 0;
    }
    /* Narrow: the tree stops taking 224px out of the list's width and floats over it instead. The
       toggle (and its persisted pref) is unchanged — only where the panel sits changes. */
    @media (max-width: 860px) {
      .sidebar {
        position: absolute; top: 0; bottom: 0; left: 0; z-index: 20;
        box-shadow: 14px 0 34px rgba(0, 0, 0, 0.45);
      }
    }
    .sb-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 12px 9px 16px; font-size: 10px; text-transform: uppercase; letter-spacing: 1.4px;
      color: var(--tx-low); font-weight: 600;
    }
    .addbtn {
      display: grid; place-items: center; width: 22px; height: 22px; padding: 0;
      border: none; background: none; color: var(--tx-low); border-radius: 6px; cursor: pointer;
    }
    .addbtn:hover { background: var(--elevated); color: var(--accent); }
    .newrow { display: flex; align-items: center; gap: 7px; padding: 4px 12px 8px; color: var(--accent); }
    .newinput {
      flex: 1; background: var(--bg); border: 1px solid var(--accent-line); border-radius: 6px;
      color: var(--tx); font-family: var(--sans); font-size: 13px; padding: 5px 8px; outline: none;
    }
    .sb-scroll { padding: 0 8px 12px; overflow: auto; flex: 1; min-height: 0; }
    .ftree { display: flex; flex-direction: column; }
  `,
})
export class Sidebar {
  protected readonly lib = inject(LibraryStore);
  private readonly ni = viewChild<ElementRef<HTMLInputElement>>('ni');

  constructor() {
    effect(() => this.ni()?.nativeElement.focus());
  }

  protected commit(name: string): void {
    const parent = this.lib.newFolderParent();
    if (parent !== null && name.trim()) this.lib.createFolder(parent, name);
    else this.lib.cancelNewFolder();
  }
}
