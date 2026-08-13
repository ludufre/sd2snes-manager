import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import type { FolderNode } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';

interface FlatFolder { path: string; name: string; total: number; depth: number; }

/** Popover to pick a destination folder for the selected ROMs (bulk "Move to..."). */
@Component({
  selector: 'app-move-picker',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="picker">
      <div class="ph">
        <h3>{{ titleKey() | transloco: { count: ids().size } }}</h3>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>
      <div class="list scroll">
        @for (f of flat(); track f.path) {
          <button class="frow" [style.paddingLeft.px]="12 + f.depth * 16" type="button" (click)="pick(f.path)">
            <app-icon [name]="f.path === '' ? 'folderOpen' : 'folder'" [size]="14" />
            <span class="nm">{{ f.name }}</span>
            <span class="ct">{{ f.total }}</span>
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 60; }
    .picker {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 61;
      width: min(380px, 92vw); max-height: 70vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .ph { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .ph h3 { margin: 0; font-size: 14px; }
    .list { overflow: auto; padding: 8px; }
    .frow {
      display: flex; align-items: center; gap: 9px; width: 100%; border: none; background: none; color: var(--tx-mid);
      font-family: var(--sans); font-size: 13px; padding: 8px 10px; border-radius: 7px; cursor: pointer; text-align: left;
    }
    .frow:hover { background: var(--elevated); color: var(--accent); }
    .frow .nm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .frow .ct { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
  `,
})
export class MovePicker {
  readonly ids = input.required<ReadonlySet<string>>();
  readonly mode = input<'move' | 'copy'>('move');
  readonly close = output<void>();
  private readonly lib = inject(LibraryStore);

  protected readonly titleKey = computed(() => {
    const one = this.ids().size <= 1;
    return this.mode() === 'copy'
      ? (one ? 'move.copyTitleOne' : 'move.copyTitleMany')
      : (one ? 'move.moveTitleOne' : 'move.moveTitleMany');
  });

  protected readonly flat = computed(() => {
    const out: FlatFolder[] = [];
    const walk = (n: FolderNode, depth: number): void => {
      out.push({ path: n.path, name: n.path === '' ? this.lib.rootName() : n.name, total: n.total, depth });
      for (const c of n.childList) walk(c, depth + 1);
    };
    walk(this.lib.tree(), 0);
    return out;
  });

  protected pick(path: string): void {
    if (this.mode() === 'copy') void this.lib.copyEntries(this.ids(), path);
    else void this.lib.moveEntries(this.ids(), path);
    this.close.emit();
  }
}
