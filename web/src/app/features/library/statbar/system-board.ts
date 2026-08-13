import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { Icon } from '../../../ui/icon/icon';
import { BOARD_COLS } from '../../../core/models';

/**
 * The statbar's per-system board: one row per platform present on the card, one column per asset
 * category. Each cell shows both sides of the same total. How many are still missing (the number
 * you act on) and how many are already on the card, over a fill bar.
 *
 * Both numbers are buttons: clicking drills the library down to exactly those games
 * (`focusCell`), which is what turns the board from a readout into a starting point. Showing the
 * pair also settles what a lone number never could, whether it counts what's there or what isn't.
 */
@Component({
  selector: 'app-system-board',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="board" [style.--cols]="cols.length">
      <div class="grid" role="table">
        <!-- header -->
        <div class="cell head sys" role="columnheader">{{ 'statbar.board.system' | transloco }}</div>
        @for (c of cols; track c.key) {
          <div class="cell head" role="columnheader">
            <span class="ci" [style.color]="c.color"><app-icon [name]="c.icon" [size]="13" /></span>
            <span class="ct">{{ c.label | transloco }}</span>
          </div>
        }

        @for (r of lib.systemStats(); track r.system) {
          <div class="cell sys" [class.tot]="!r.system" role="rowheader">
            <b>{{ r.system ?? ('statbar.board.total' | transloco) }}</b>
            <i>{{ r.total }}</i>
          </div>
          @for (c of cols; track c.key) {
            @let cell = r.cells[c.key];
            @let sys = r.system;
            <div class="cell val" [class.tot]="!sys" [class.done]="!cell.missing" [class.bad]="isBad(cell.missing, r.total)">
              <div class="nums">
                <!-- Both sides are reachable: the big number is what still needs filling, the
                     small one what's already there. A side at zero is a dash, not a link — there
                     is nothing to list. -->
                @if (cell.missing && sys) {
                  <button
                    type="button" class="miss"
                    [title]="'statbar.board.cellMissingTitle' | transloco: { missing: cell.missing, total: r.total, col: c.label | transloco }"
                    (click)="lib.focusCell(sys, c.key, 'missing')">{{ cell.missing }}</button>
                } @else {
                  <span class="miss">{{ cell.missing || '—' }}</span>
                }
                <span class="dot">·</span>
                @if (cell.have && sys) {
                  <button
                    type="button" class="have"
                    [title]="'statbar.board.cellHaveTitle' | transloco: { have: cell.have, total: r.total, col: c.label | transloco }"
                    (click)="lib.focusCell(sys, c.key, 'present')">{{ cell.have }} ✓</button>
                } @else {
                  <span class="have">{{ cell.have ? cell.have + ' ✓' : '—' }}</span>
                }
              </div>
              @if (sys) {
                <span class="bar"><i [style.width.%]="cell.pct" [style.background]="c.color"></i></span>
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: `
    /* Horizontal scroll instead of squeezing the columns into illegibility — the system label stays
       pinned so a scrolled row is still identifiable. */
    .board { flex: 1 0 100%; overflow-x: auto; overscroll-behavior-x: contain; padding-bottom: 2px; }
    .grid {
      display: grid;
      grid-template-columns: 108px repeat(var(--cols), minmax(84px, 1fr));
      gap: 1px; background: var(--line-soft);
      border: 1px solid var(--line-soft); border-radius: var(--radius-control); overflow: hidden;
      min-width: 620px;
    }
    .cell { background: var(--panel); padding: 8px 11px; min-width: 0; }
    .head {
      display: flex; align-items: center; gap: 6px; background: var(--panel-2); padding: 7px 11px;
      font-size: 10.5px; color: var(--tx-low); text-transform: uppercase; letter-spacing: 0.8px;
    }
    .head .ci { display: inline-flex; flex: 0 0 auto; }
    .head .ct { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .sys {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      position: sticky; left: 0; z-index: 1;
    }
    .sys b { font-size: 12.5px; font-weight: 600; }
    .sys i { font-family: var(--mono); font-size: 11px; color: var(--tx-low); font-style: normal; }
    .sys.head { background: var(--panel-2); }
    .sys.tot { background: var(--panel-2); }
    .sys.tot b { font-size: 10.5px; color: var(--tx-low); letter-spacing: 1px; text-transform: uppercase; }

    .val { color: var(--tx); }
    .nums { display: flex; align-items: baseline; gap: 5px; }
    /* the missing count leads; what's already on the card reads as a footnote to it */
    .val .miss {
      font-family: var(--mono); font-size: 16px; font-weight: 700; letter-spacing: -0.5px;
      line-height: 1.1; background: none; border: none; padding: 0; color: inherit;
    }
    .val .dot { color: var(--tx-low); font-size: 11px; }
    .val .have {
      font-family: var(--mono); font-size: 11.5px; font-weight: 600; line-height: 1.1;
      background: none; border: none; padding: 0; color: var(--tx-low); white-space: nowrap;
    }
    button.miss, button.have { cursor: pointer; border-radius: 4px; }
    button.miss:hover { text-decoration: underline; }
    button.have:hover { color: var(--tx-mid); text-decoration: underline; }
    button.miss:focus-visible, button.have:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .val .bar { display: block; height: 4px; margin-top: 7px; background: var(--elevated); border-radius: 99px; overflow: hidden; }
    .val .bar > i { display: block; height: 100%; border-radius: 99px; transition: width 0.25s; }
    .val.done .miss { color: var(--ok); }
    .val.bad .miss { color: var(--danger); }
    .val.tot { background: var(--panel-2); }
    .val.tot .miss { font-size: 13px; }
  `,
})
export class SystemBoard {
  protected readonly lib = inject(LibraryStore);
  protected readonly cols = BOARD_COLS;

  /** Over a third of the platform still missing, worth colouring as a real gap, not a to-do. */
  protected isBad(missing: number, total: number): boolean {
    return total > 0 && missing / total > 0.3;
  }
}
