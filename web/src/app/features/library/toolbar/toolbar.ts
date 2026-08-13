import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { PrefsStore } from '../../../core/prefs-store';
import { BOARD_COLS, type StatusFilter, type View } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';

/** Folder-tree toggle · search · system chips · status chips · view segmented. */
@Component({
  selector: 'app-toolbar',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <button
        class="btn ghost sm icon" type="button" [title]="'toolbar.toggleFolders' | transloco"
        [class.on]="lib.sidebarOpen()" (click)="lib.toggleSidebar()">
        <app-icon name="panelLeft" [size]="16" />
      </button>

      <div class="search">
        <app-icon name="search" [size]="15" />
        <input
          [placeholder]="'toolbar.searchPlaceholder' | transloco"
          [value]="raw()"
          (input)="onSearch($any($event.target).value)" />
        @if (raw()) {
          <button class="clear" type="button" [title]="'toolbar.clearSearch' | transloco" (click)="clearSearch()">
            <app-icon name="x" [size]="13" />
          </button>
        }
      </div>

      <!-- Both chip groups share one scroll container so a narrow window costs ONE extra row, not
           two — and the two filter axes stay side by side, which is how they're used. -->
      <div class="chipbar">
        <div class="chips">
          <button class="chip" [class.on]="lib.sysFilter() === 'all'" (click)="lib.setSysFilter('all')">{{ 'toolbar.sysAll' | transloco }}</button>
          @for (s of lib.presentSystems(); track s) {
            <button class="chip" [class.on]="lib.sysFilter() === s" (click)="lib.setSysFilter(s)">{{ s }}</button>
          }
        </div>

        <div class="chips">
          <!-- "Com …" comes from clicking a board cell's on-card side. It exists only while that
               filter is on, rather than doubling the fixed chips for a filter reached from
               elsewhere — and clicking it clears, so it's still undone where filters live. It
               leads the group because this strip scrolls: appended at the end it would be born
               off-screen, leaving the list filtered with no visible reason why. -->
          @if (hasChip(); as spec) {
            <button class="chip on has" (click)="lib.setStatusFilter('all')">
              {{ 'toolbar.statHas' | transloco: { col: spec.label | transloco } }}
              <app-icon name="x" [size]="11" />
            </button>
          }
          @for (c of statChips; track c.v) {
            <button
              class="chip" [class.on]="lib.statusFilter() === c.v" [title]="c.l | transloco"
              (click)="lib.setStatusFilter(c.v)">
              <span class="full">{{ c.l | transloco }}</span>
              @if (c.s) { <span class="short">{{ c.s | transloco }}</span> }
            </button>
          }
        </div>
      </div>

      <div class="grow"></div>

      <div class="seg">
        @for (v of views; track v.id) {
          <button [class.on]="prefs.view() === v.id" [title]="v.title | transloco" (click)="prefs.setView(v.id)">
            <app-icon [name]="v.icon" [size]="16" />
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .toolbar {
      display: flex; align-items: center; gap: 12px; padding: 12px 20px; flex: 0 0 auto;
      border-bottom: 1px solid var(--line); background: var(--bg);
    }
    .grow { flex: 1; }
    .search {
      display: flex; align-items: center; gap: 8px; flex: 0 1 280px; min-width: 0;
      background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-control); padding: 7px 11px;
      color: var(--tx-low);
    }
    .search:focus-within { border-color: var(--accent-line); }
    /* min-width:0 on both — an <input>'s automatic minimum size (~20 chars) otherwise pins the whole
       field open and the flex-shrink above never gets to act. */
    .search input { background: none; border: none; outline: none; color: var(--tx); font-family: var(--sans); font-size: 13px; width: 100%; min-width: 0; }
    .search .clear {
      display: inline-grid; place-items: center; border: none; background: none; color: var(--tx-low);
      cursor: pointer; padding: 1px; border-radius: 5px; flex: 0 0 auto; transition: color 0.12s, background 0.12s;
    }
    .search .clear:hover { color: var(--tx); background: var(--elevated); }
    /* Scrollable instead of overflowing: body has overflow:hidden, so anything that runs past the
       edge here is silently clipped rather than reachable. */
    .chipbar { display: flex; gap: 12px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .chipbar::-webkit-scrollbar { display: none; }
    .chips { display: flex; gap: 6px; flex: 0 0 auto; }
    .chip {
      font-family: var(--mono); font-size: 11px; letter-spacing: 0.5px; color: var(--tx-mid); flex: 0 0 auto;
      background: var(--panel); border: 1px solid var(--line); padding: 6px 10px; border-radius: 7px; transition: 0.12s; cursor: pointer;
    }
    .chip:hover { color: var(--tx); border-color: var(--tx-low); }
    .chip.on { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent); }
    .chip .short { display: none; }
    .chip.has { display: inline-flex; align-items: center; gap: 5px; }
    .seg { display: flex; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-control); overflow: hidden; }
    .seg button {
      background: none; border: none; color: var(--tx-low); padding: 7px 10px; display: grid; place-items: center;
      border-right: 1px solid var(--line); cursor: pointer;
    }
    .seg button:last-child { border-right: none; }
    .seg button.on { background: var(--elevated); color: var(--accent); }
    .seg button:hover:not(.on) { color: var(--tx); }

    /* Two rows, never more: folders + search + the view switcher stay together on the first (that
       switcher is navigation, and losing it strands the user in whichever view they were in), the
       chips take the second. The order property lifts the switcher above the chips without moving
       it in the DOM, so the tab sequence stays as authored. */
    @media (max-width: 1280px) {
      .toolbar { flex-wrap: wrap; row-gap: 10px; }
      .chipbar { order: 1; flex: 1 0 100%; }
      .grow { display: none; }
      .search { flex: 1 1 200px; }
      .seg { margin-left: auto; }
    }
    /* Status labels are the longest strings in the bar (worse in pt/fr/de) — swap for the column
       names, which the board already teaches. */
    @media (max-width: 720px) {
      /* :has() so a chip WITHOUT a short form (its label is already short) keeps showing its own. */
      .chip:has(.short) .full { display: none; }
      .chip .short { display: inline; }
    }
  `,
})
export class Toolbar {
  protected readonly lib = inject(LibraryStore);
  protected readonly prefs = inject(PrefsStore);

  /** Immediate input value (keeps typing snappy), decoupled from the expensive library filter, which
   *  only re-runs after a short debounce so a big card doesn't re-filter on every keystroke. */
  protected readonly raw = signal(this.lib.query());
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  constructor() {
    // keep the box in sync when the query is cleared elsewhere (e.g. a view reset). Also cancel any
    // pending debounce so an in-flight setQuery from mid-typing can't resurrect the query after the
    // external clear (box+query would desync otherwise).
    effect(() => {
      if (this.lib.query() === '') {
        if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
        this.raw.set('');
      }
    });
  }
  protected onSearch(v: string): void {
    this.raw.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.searchTimer = null; this.lib.setQuery(v); }, 200);
  }
  protected clearSearch(): void {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    this.raw.set('');
    this.lib.setQuery('');
  }

  /** `l` is the full label; `s` the short one shown when the bar runs out of room, omitted when the
   *  label is already short (the system chips need neither. A platform's name is its short form,
   *  and they come from the card). */
  protected readonly statChips: Array<{ v: StatusFilter; l: string; s?: string }> = [
    { v: 'all', l: 'toolbar.statAll' },
    { v: 'missing-cover', l: 'toolbar.statMissingCover', s: 'statbar.board.capa' },
    { v: 'missing-snapshot', l: 'toolbar.statMissingSnapshot', s: 'statbar.board.tela' },
    { v: 'missing-preview', l: 'toolbar.statMissingPreview', s: 'statbar.board.previa' },
    { v: 'missing-info', l: 'toolbar.statMissingInfo', s: 'statbar.board.info' },
    { v: 'missing-cheats', l: 'toolbar.statMissingCheats', s: 'statbar.board.cheats' },
    { v: 'missing-guides', l: 'toolbar.statMissingGuides', s: 'statbar.board.guias' },
    { v: 'unmatched', l: 'toolbar.statUnmatched', s: 'toolbar.statUnmatchedShort' },
  ];
  /** The board column behind an active "on the card" filter, or null. Returns the spec rather than a
   *  finished string so the template can translate with the pipe (which follows a language switch). */
  protected readonly hasChip = computed(
    () => BOARD_COLS.find((c) => c.statusHas === this.lib.statusFilter()) ?? null,
  );

  protected readonly views: Array<{ id: View; icon: 'list' | 'grid' | 'split'; title: string }> = [
    { id: 'list', icon: 'list', title: 'toolbar.viewList' },
    { id: 'gallery', icon: 'grid', title: 'toolbar.viewGallery' },
    { id: 'split', icon: 'split', title: 'toolbar.viewSplit' },
  ];
}
