import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import { Icon } from '../../../ui/icon/icon';
import { DropFolder } from '../../../ui/drop-folder.directive';
import { TranslocoModule } from '@jsverse/transloco';

/** Path breadcrumb + "Include subfolders" toggle (flat when searching/filtering). */
@Component({
  selector: 'app-breadcrumb',
  imports: [Icon, DropFolder, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let searching = !!lib.query();
    <div class="crumbs">
      <button class="crumb" [class.here]="lib.cwd() === '' && !searching" [appDropFolder]="''" (click)="lib.navTo('')">
        <app-icon name="folderOpen" [size]="14" />{{ lib.rootName() }}
      </button>

      <!-- Only a text search spans the whole card; status/system filters stay scoped to the folder
           path, so keep the breadcrumb (and the subfolder toggle) visible for them. -->
      @if (!searching) {
        @for (p of parts(); track p.path; let last = $last) {
          <span class="csep"><app-icon name="chevron" [size]="13" /></span>
          <button class="crumb" [class.here]="last" [appDropFolder]="p.path" (click)="lib.navTo(p.path)">{{ p.name }}</button>
        }
      } @else {
        <span class="crumb-flat">{{ 'breadcrumb.resultsAllCard' | transloco }}</span>
      }

      <div class="grow"></div>

      @if (!searching) {
        <button
          class="subfold" [class.on]="lib.recursive()"
          [title]="'breadcrumb.includeSubfoldersTitle' | transloco"
          (click)="lib.setRecursive(!lib.recursive())">
          <span class="toggle" [class.on]="lib.recursive()"></span>{{ 'breadcrumb.includeSubfolders' | transloco }}
        </button>
      }
    </div>
  `,
  styles: `
    .crumbs {
      display: flex; align-items: center; gap: 4px; padding: 9px 20px; flex: 0 0 auto;
      border-bottom: 1px solid var(--line-soft); background: var(--bg); min-height: 42px;
      /* deep paths scroll instead of being clipped by body{overflow:hidden} */
      overflow-x: auto; scrollbar-width: none;
    }
    .crumbs::-webkit-scrollbar { display: none; }
    .grow { flex: 1; }
    .crumb {
      display: inline-flex; align-items: center; gap: 6px; border: none; background: none; white-space: nowrap;
      color: var(--tx-mid); font-family: var(--sans); font-size: 13px; font-weight: 500;
      padding: 4px 8px; border-radius: 6px; transition: 0.1s; cursor: pointer;
    }
    .crumb:hover { background: var(--elevated); color: var(--tx); }
    .crumb.here { color: var(--tx); font-weight: 600; }
    .csep { color: var(--tx-low); display: grid; place-items: center; }
    .crumb-flat { font-family: var(--mono); font-size: 11px; color: var(--tx-low); margin-left: 4px; }
    .subfold {
      display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line);
      background: var(--panel); color: var(--tx-mid); font-family: var(--mono); font-size: 11px;
      padding: 5px 10px 5px 7px; border-radius: var(--radius-control); transition: 0.12s; cursor: pointer;
    }
    .subfold:hover { color: var(--tx); border-color: var(--tx-low); }
    .subfold.on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
    /* visual-only toggle (the button owns the click) */
    .subfold .toggle {
      width: 28px; height: 16px; border-radius: 99px; background: var(--elevated);
      border: 1px solid var(--line); position: relative; transition: 0.15s; flex: 0 0 auto;
    }
    .subfold .toggle::after {
      content: ''; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px;
      border-radius: 50%; background: var(--tx-low); transition: 0.15s;
    }
    .subfold .toggle.on { background: var(--accent-soft); border-color: var(--accent-line); }
    .subfold .toggle.on::after { left: 13px; background: var(--accent); }
  `,
})
export class Breadcrumb {
  protected readonly lib = inject(LibraryStore);

  protected readonly parts = computed(() => {
    const cwd = this.lib.cwd();
    if (!cwd) return [] as Array<{ name: string; path: string }>;
    const out: Array<{ name: string; path: string }> = [];
    let acc = '';
    for (const s of cwd.split('/')) {
      acc = acc ? acc + '/' + s : s;
      out.push({ name: s, path: acc });
    }
    return out;
  });
}
