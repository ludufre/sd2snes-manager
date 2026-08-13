import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { PrefsStore } from '../../../core/prefs-store';
import { Icon } from '../../../ui/icon/icon';
import { SystemBoard } from './system-board';
import { GAMEDB_WEB } from '../../../core/env';

/** Folder-scoped tallies (jogos · capas · snapshots · prévias · cheats) with the matching coloured
 *  asset icons, plus a right-side "Pendente verificação" + a friendly GameDB contribute link. */
@Component({
  selector: 'app-statbar',
  imports: [Icon, SystemBoard, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = lib.stats();
    <div class="statbar">
      <div class="stat"><div class="num">{{ s.total }}</div><div class="lbl">{{ 'statbar.games' | transloco }}</div></div>
      <div class="stat capa">
        <div class="num"><app-icon name="image" [size]="16" />{{ s.covers }}<span class="sub"> / {{ s.total }}</span></div>
        <div class="lbl">{{ 'statbar.covers' | transloco }}</div>
      </div>
      <div class="stat snap">
        <div class="num"><app-icon name="monitor" [size]="16" />{{ s.snapshots }}<span class="sub"> / {{ s.total }}</span></div>
        <div class="lbl">{{ 'statbar.snapshots' | transloco }}</div>
      </div>
      <div class="stat previa">
        <div class="num"><app-icon name="film" [size]="16" />{{ s.previews }}<span class="sub"> / {{ s.total }}</span></div>
        <div class="lbl">{{ 'statbar.previews' | transloco }}</div>
      </div>
      <div class="stat ok">
        <div class="num"><app-icon name="cheats" [size]="16" />{{ s.cheats }}<span class="sub"> / {{ s.total }}</span></div>
        <div class="lbl">{{ 'statbar.cheats' | transloco }}</div>
      </div>
      <div class="stat guias">
        <div class="num"><app-icon name="book" [size]="16" />{{ s.guides }}<span class="sub"> / {{ s.total }}</span></div>
        <div class="lbl">{{ 'statbar.guides' | transloco }}</div>
      </div>
      @if (used() !== null) {
        <div class="stat card" [title]="'statbar.cardUsedTitle' | transloco">
          <div class="num"><app-icon name="sd" [size]="15" />{{ used() }}</div>
          <div class="lbl">{{ 'statbar.onCard' | transloco }}</div>
        </div>
      }

      <!-- Right after the tallies it belongs to, not pinned to the far edge: it's what breaks those
           same numbers down per system. -->
      <button
        class="board-toggle" type="button" [class.on]="prefs.boardOpen()"
        [attr.aria-expanded]="prefs.boardOpen()" (click)="lib.toggleBoard()">
        {{ 'statbar.board.toggle' | transloco }}
        <app-icon class="cv" name="chevron" [size]="13" />
      </button>

      <div class="info">
        <a class="cta" [href]="gamedb" target="_blank" rel="noopener">
          {{ 'statbar.contribute' | transloco }}
          <app-icon name="chevron" [size]="13" />
        </a>
      </div>

      @if (prefs.boardOpen()) { <app-system-board /> }
    </div>
  `,
  styles: `
    .statbar {
      display: flex; align-items: center; gap: 0; padding: 14px 20px; flex: 0 0 auto; flex-wrap: wrap;
      border-bottom: 1px solid var(--line); background: var(--panel);
    }
    .stat { padding: 0 22px; border-right: 1px solid var(--line-soft); }
    .stat:first-child { padding-left: 0; }
    .num { font-family: var(--mono); font-size: 22px; font-weight: 700; letter-spacing: -1px; line-height: 1; display: flex; align-items: center; gap: 7px; }
    .num app-icon { opacity: 0.85; }
    .lbl { font-size: 11px; color: var(--tx-low); text-transform: uppercase; letter-spacing: 1px; margin-top: 6px; }
    .num .sub { color: var(--tx-low); font-size: 14px; font-weight: 500; }
    .stat.capa .num { color: var(--accent); }
    .stat.snap .num { color: var(--info); }
    .stat.previa .num { color: #ff5c8a; }
    .stat.ok .num { color: var(--ok); }
    .stat.guias .num { color: #c98cff; }
    .stat.card .num { color: var(--tx-mid); font-size: 16px; }

    /* right-side: GameDB contribute CTA */
    .info { margin-left: auto; padding-left: 22px; display: flex; align-items: center; gap: 16px; }
    /* Below this the CTA would drop to a line of its own (margin-left:auto in a wrapping flex),
       costing height for a non-critical nudge. It comes back when there's room. */
    @media (max-width: 1040px) { .info { display: none; } }
    .cta {
      display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--tx-mid);
      text-decoration: none; padding: 7px 11px; border: 1px solid var(--line); border-radius: var(--radius-control);
      background: var(--panel-2); transition: border-color 0.12s, color 0.12s;
    }
    .cta:hover { color: var(--tx); border-color: var(--accent-line); }

    .board-toggle {
      display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; margin-left: 22px;
      align-self: center;
      font-family: var(--sans); font-size: 12px; color: var(--tx-mid);
      background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-control);
      padding: 7px 11px; cursor: pointer; transition: color 0.12s, border-color 0.12s, background 0.12s;
    }
    .board-toggle:hover { color: var(--tx); border-color: var(--tx-low); }
    .board-toggle.on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
    .board-toggle .cv { transition: transform 0.15s; }
    .board-toggle.on .cv { transform: rotate(180deg); }
    /* The board is a full-width child of the wrapping statbar — it always lands on its own line. */
    app-system-board { flex: 1 0 100%; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line-soft); }
  `,
})
export class StatBar {
  protected readonly lib = inject(LibraryStore);
  protected readonly prefs = inject(PrefsStore);
  protected readonly gamedb = GAMEDB_WEB;

  /** Card space used, formatted (e.g. "12,4 GB"), or null while computing / not connected. */
  protected readonly used = computed(() => {
    const b = this.lib.cardUsedBytes();
    if (b == null) return null;
    if (b < 1024) return `${b} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = b / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
  });
}
