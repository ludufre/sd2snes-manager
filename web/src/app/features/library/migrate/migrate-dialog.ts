import { ChangeDetectionStrategy, Component, computed, effect, inject, output, signal } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { SdMigrationService, type MigrationPlan } from '../../../core/sd-migration.service';
import { ambiguousDirFor } from '../../../core/sd-layout';
import { Icon } from '../../../ui/icon/icon';

/**
 * "Organizar o cartão", moves per-game files into the two-letter bucket layout that firmware
 * 2.15+ reads, and sweeps the macOS AppleDouble droppings.
 *
 * Mirrors the BIOS dialog's shape (scrim + fixed panel + amber warn block + list), because it is
 * the same kind of thing: a card-health problem the user has to act on.
 */
@Component({
  selector: 'app-migrate-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="mig">
      <div class="bh">
        <div>
          <h3>{{ 'migrate.title' | transloco }}</h3>
          <span class="sub">{{ 'migrate.subtitle' | transloco }}</span>
        </div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      @switch (outOfLayout()) {
        @case ('legacy') { <div class="warn" [innerHTML]="'migrate.warn' | transloco"></div> }
        @case ('partial') { <div class="warn" [innerHTML]="'migrate.warnPartial' | transloco: { count: strayCount() }"></div> }
        @default {
          <div class="tip">
            <app-icon name="download" [size]="13" />
            <span [innerHTML]="'migrate.why' | transloco"></span>
          </div>
        }
      }

      <div class="fw">
        @switch (lib.cardFw().kind) {
          @case ('release') { {{ 'migrate.fwDetected' | transloco: { version: raw() } }} }
          @case ('snapshot') { {{ 'migrate.fwSnapshot' | transloco: { version: raw() } }} }
          <!-- identified, but it says nothing about the LAYOUT: the stock firmware knows neither
               folder scheme of this fork, and it is often just the image left behind after a USB
               flash. So it is named, and the question below still decides. -->
          @case ('official') { {{ 'migrate.fwOfficial' | transloco: { version: raw() } }} }
          @case ('absent') { {{ 'migrate.fwAbsent' | transloco }} }
          @default { {{ 'migrate.fwUnknown' | transloco }} }
        }
        <!-- the version could not be read, but the user answered which firmware this card runs —
             say so, because that answer is what decides everything below. -->
        @if (lib.fwAssumed(); as a) {
          <div class="assumed">{{ (a === 'buckets' ? 'migrate.fwAssumedNew' : 'migrate.fwAssumedOld') | transloco }}</div>
        }
      </div>

      @if (lib.migrateResult(); as r) {
        <!-- RESULT — what the run actually did. Shown here (not only as a toast) because the run is
             long, the user closes the dialog while it works, and "did it finish, and did anything
             fail?" is the one question a toast cannot answer after it fades. -->
        <div class="blist scroll">
          <div class="res" [class.ok]="resOk()">
            <app-icon [name]="resOk() ? 'check' : 'info'" [size]="16" />
            <span>{{ (resOk() ? 'migrate.resultTitle' : 'migrate.resultTitleWarn') | transloco }}</span>
          </div>
          @if (r.moved) { <div class="rrow">{{ 'migrate.resMoved' | transloco: { count: r.moved } }}</div> }
          @if (r.renamed) { <div class="rrow">{{ 'migrate.resRenamed' | transloco: { count: r.renamed } }}</div> }
          @if (r.junkRemoved) { <div class="rrow">{{ 'migrate.resJunk' | transloco: { count: r.junkRemoved } }}</div> }
          @if (r.junkFailed) { <div class="rrow">{{ 'migrate.resJunkFailed' | transloco: { count: r.junkFailed } }}</div> }
          @if (r.sysDirsRemoved) { <div class="rrow">{{ 'migrate.resSysDirs' | transloco: { count: r.sysDirsRemoved } }}</div> }
          @if (r.sysDirsFailed) { <div class="rrow">{{ 'migrate.resSysDirsFailed' | transloco: { count: r.sysDirsFailed } }}</div> }
          @if (r.prunedDirs) { <div class="rrow">{{ 'migrate.resPruned' | transloco: { count: r.prunedDirs } }}</div> }
          @if (r.conflicts) { <div class="rrow">{{ 'migrate.resConflicts' | transloco: { count: r.conflicts } }}</div> }
          @if (r.failed.length) { <div class="rrow bad">{{ 'migrate.resFailed' | transloco: { count: r.failed.length } }}</div> }
          @if (!r.moved && !r.junkRemoved && !r.prunedDirs && !r.renamed && !r.sysDirsRemoved) { <div class="rrow">{{ 'migrate.resNothing' | transloco }}</div> }
          @if (r.failed.length) { <div class="amb">{{ failedNames() }}</div> }
          @if (r.unwritable) { <div class="note bad">{{ 'migrate.resUnwritable' | transloco }}</div> }
          @else if (r.aborted) { <div class="note bad">{{ 'migrate.resAborted' | transloco }}</div> }
          @if (lib.migrateCount() > 0) { <div class="note">{{ 'migrate.resRemaining' | transloco: { count: lib.migrateCount() } }}</div> }
        </div>
      } @else {
        <div class="blist scroll">
          @if (plan(); as p) {
            @for (r of rows(); track r.key) {
              <div class="brow">
                <div class="info">
                  <div class="chip">{{ r.key | transloco }}</div>
                  <div class="fn">{{ r.path }}</div>
                </div>
                <span class="badge" [class.ok]="r.files === 0">
                  {{ 'migrate.filesCount' | transloco: { count: r.files } }}
                </span>
              </div>
            }
            @if (p.renames.length) {
              <div class="brow">
                <div class="info">
                  <div class="chip">{{ 'migrate.rootPatches' | transloco }}</div>
                  <div class="fn">{{ renameSample() }}</div>
                </div>
                <span class="badge">{{ 'migrate.filesCount' | transloco: { count: p.renames.length } }}</span>
              </div>
              <div class="note">{{ 'migrate.patchesHint' | transloco }}</div>
            }
            @if (p.junk.length) {
              <div class="brow">
                <div class="info">
                  <div class="chip">{{ 'migrate.rootJunk' | transloco }}</div>
                  <div class="fn">{{ 'migrate.junkHint' | transloco }}</div>
                </div>
                <span class="badge">{{ 'migrate.filesCount' | transloco: { count: p.junk.length } }}</span>
              </div>
            }
            <!-- OPT-IN, and the only destructive thing in this dialog: a $RECYCLE.BIN may still
                 hold files the user believes they have. Off unless they tick it, and it names the
                 folders it would delete so the decision is made on facts, not on a category. -->
            @if (p.systemDirs.length) {
              <label class="opt">
                <input type="checkbox" [checked]="rmSystemDirs()" (change)="toggleSystemDirs($event)" />
                <span class="ol">
                  <span class="ot">{{ 'migrate.sysDirs' | transloco }}</span>
                  <span class="fn">{{ p.systemDirs.join(' · ') }}</span>
                  <span class="oh">{{ 'migrate.sysDirsHint' | transloco }}</span>
                </span>
              </label>
            }
            @if (p.conflicts.length) {
              <div class="note">{{ 'migrate.conflicts' | transloco: { count: p.conflicts.length } }}</div>
            }
            @if (p.moves.length && !lib.canMoveFiles()) {
              <div class="note">{{ 'migrate.fwTooOld' | transloco }}</div>
            }
            @if (p.ambiguous.length) {
              <div class="note" [innerHTML]="'migrate.ambiguous' | transloco: { count: p.ambiguous.length }"></div>
              <!-- Grouped BY DIRECTORY, and the directory is printed. A bare list of names sent the
                   user hunting in the wrong root: the ficha .yml were long since fixed, the ones
                   still stuck were the CHEATS .yml -- same names, same extension, other folder. -->
              @for (g of ambiguousGroups(); track g.path) {
                <div class="ambg">
                  <div class="ambp">
                    <span class="chip">{{ g.label | transloco }}</span>
                    <span class="p">{{ g.path }}</span>
                    <span class="n">{{ 'migrate.filesCount' | transloco: { count: g.count } }}</span>
                  </div>
                  <div class="amb">{{ g.sample }}</div>
                </div>
              }
              @if (ambiguousStuck(); as stuck) {
                <div class="note">{{ 'migrate.ambiguousAlready' | transloco: { count: stuck } }}</div>
              }
              <div class="note">{{ 'migrate.ambiguousHint' | transloco }}</div>
            }
            @if (p.emptyDirs) {
              <div class="note">{{ 'migrate.emptyDirs' | transloco: { count: p.emptyDirs } }}</div>
            }
            <!-- systemDirs is deliberately NOT in this test: every Windows-formatted card carries a
                 System Volume Information, so counting it as pending work would have told every
                 such user their card needs organizing, forever. It is an offer, not a problem —
                 the checkbox above stays visible next to this line. -->
            @if (!p.moves.length && !p.junk.length && !p.ambiguous.length && !p.emptyDirs && !p.renames.length) {
              <div class="note ok">{{ 'migrate.nothingToDo' | transloco }}</div>
            }
          } @else if (planned()) {
            <!-- Walked, and came back with nothing: there is no card behind this dialog (demo mode). -->
            <div class="note">{{ 'migrate.noCard' | transloco }}</div>
          } @else {
            <!-- The card walk is ~20s on a loaded card: it is the whole content of the dialog while
                 it runs, so it reads as a state, not as a footnote. -->
            <div class="scanning">
              <div class="spin"></div>
              <span>{{ 'migrate.scanning' | transloco }}</span>
            </div>
          }
        </div>

        @if (!migration.hasNativeMove) {
          <div class="note">{{ 'migrate.noNativeMove' | transloco }}</div>
        }
        <div class="note">{{ 'migrate.safetyNote' | transloco }}</div>
      }

      <!-- Live progress INSIDE the modal: the bulk bar behind it is half-hidden by the scrim, and
           the run is the only thing happening. -->
      @if (lib.migrateRunning()) {
        @let b = lib.bulk();
        <div class="run">
          <span class="lbl">{{ b?.label }}</span>
          <div class="bar" [class.indet]="!b?.total"><i [style.width.%]="b?.total ? pct() : 40"></i></div>
          @if (b?.total) { <span class="cnt">{{ b?.done }} / {{ b?.total }}</span> }
        </div>
      }

      <div class="foot">
        <button class="btn ghost" type="button" (click)="close.emit()">
          {{ (started() ? 'migrate.close' : 'migrate.later') | transloco }}
        </button>
        @if (!lib.migrateResult() || canRun()) {
          <button class="btn" type="button" [disabled]="!canRun()" (click)="run()">
            {{ (lib.migrateResult() ? 'migrate.runAgain' : 'migrate.run') | transloco }}
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .mig {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(560px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .bh { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .bh h3 { margin: 0; font-size: 15px; }
    .bh .sub { font-size: 11.5px; color: var(--tx-low); }
    .warn {
      margin: 12px 14px 4px; padding: 10px 12px; border-radius: 9px; font-size: 12.5px; line-height: 1.5;
      color: var(--tx-mid); background: var(--amber-soft, color-mix(in oklab, #e2b341 14%, transparent));
      border: 1px solid color-mix(in oklab, #e2b341 35%, transparent);
    }
    .warn b { color: var(--tx); font-family: var(--mono); }
    .tip {
      margin: 8px 14px 2px; padding: 8px 12px; border-radius: 9px; font-size: 12px; line-height: 1.45;
      color: var(--tx-mid); background: var(--accent-soft); border: 1px solid var(--accent-line);
      display: flex; align-items: center; gap: 8px;
    }
    .tip app-icon { color: var(--accent); flex: 0 0 auto; }
    .fw { margin: 8px 14px 0; font-size: 11.5px; color: var(--tx-low); font-family: var(--mono); }
    .fw .assumed { margin-top: 3px; font-family: inherit; }
    .blist { overflow: auto; padding: 8px 14px 4px; display: flex; flex-direction: column; gap: 6px; }
    .brow {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 9px;
      background: var(--panel-2, rgba(255, 255, 255, 0.03)); border: 1px solid var(--line);
    }
    .brow .info { flex: 1 1 auto; min-width: 0; }
    .brow .chip { font-size: 12.5px; color: var(--tx); }
    .brow .fn { font-size: 11px; color: var(--tx-low); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opt {
      display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 9px;
      background: var(--panel-2, rgba(255, 255, 255, 0.03)); border: 1px solid var(--line); cursor: pointer;
    }
    .opt input { margin-top: 2px; flex: 0 0 auto; accent-color: var(--accent); }
    .opt .ol { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .opt .ot { font-size: 12.5px; color: var(--tx); }
    .opt .oh { font-size: 11px; color: var(--tx-low); line-height: 1.4; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--tx-mid); flex: 0 0 auto; }
    .badge.ok { color: var(--tx-low); opacity: 0.7; }
    .note { margin: 6px 14px 0; font-size: 11.5px; line-height: 1.45; color: var(--tx-low); }
    .amb { margin: 2px 14px 0; font-size: 11px; font-family: var(--mono); color: var(--tx-mid); word-break: break-all; }
    .ambg { margin: 6px 14px 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-2, rgba(255, 255, 255, 0.03)); }
    .ambp { display: flex; align-items: center; gap: 8px; }
    .ambp .chip { font-size: 11.5px; color: var(--tx); white-space: nowrap; }
    .ambp .p { font-size: 11px; font-family: var(--mono); color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ambp .n { margin-left: auto; font-size: 11px; color: var(--tx-low); white-space: nowrap; }
    .ambg .amb { margin: 4px 0 0; }
    .note.ok { color: var(--tx-mid); }
    .note.bad { color: var(--warn, #e0a52b); }
    .res {
      display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-radius: 9px;
      font-size: 13px; color: var(--tx-mid);
      background: color-mix(in oklab, #e2b341 12%, transparent);
      border: 1px solid color-mix(in oklab, #e2b341 32%, transparent);
    }
    .res.ok { background: var(--accent-soft); border-color: var(--accent-line); }
    .res app-icon { flex: 0 0 auto; color: var(--warn, #e0a52b); }
    .res.ok app-icon { color: var(--accent); }
    .scanning {
      display: flex; align-items: center; justify-content: center; gap: 11px;
      padding: 26px 8px; color: var(--tx); font-size: 14px;
    }
    .spin {
      width: 16px; height: 16px; flex: 0 0 auto; border-radius: 50%;
      border: 2px solid var(--line); border-top-color: var(--accent); animation: sp 0.7s linear infinite;
    }
    @keyframes sp { to { transform: rotate(360deg); } }
    .rrow { font-size: 12.5px; color: var(--tx-mid); padding: 2px 2px 0; }
    .rrow.bad { color: var(--warn, #e0a52b); }
    .run { display: flex; align-items: center; gap: 10px; margin: 10px 14px 0; }
    .run .lbl { font-size: 11.5px; color: var(--tx-mid); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .run .cnt { font-size: 11.5px; color: var(--tx-low); font-family: var(--mono); white-space: nowrap; }
    .run .bar { flex: 1; height: 6px; background: var(--elevated); border-radius: 99px; overflow: hidden; }
    .run .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width 0.25s; }
    .run .bar.indet > i { transition: none; animation: indet 1.15s ease-in-out infinite; }
    @keyframes indet { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
    .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 14px 14px; }
  `,
})
export class MigrateDialog {
  readonly lib = inject(LibraryStore);
  readonly migration = inject(SdMigrationService);
  readonly close = output<void>();

  private readonly _plan = signal<MigrationPlan | null>(null);
  readonly plan = this._plan.asReadonly();
  /** The walk finished. Separates "still scanning" from "the walk came back with nothing", without
   *  it, a card that went away mid-preview leaves the dialog spinning forever. */
  private readonly _planned = signal(false);
  readonly planned = this._planned.asReadonly();

  readonly raw = computed(() => {
    const v = this.lib.cardFw();
    return v.kind === 'release' || v.kind === 'snapshot' ? v.raw : '';
  });

  /** What the top block reasons about: the walk this dialog did, or -- while that walk is still
   *  running -- the one the last probe published. Never a bare counter. */
  private readonly shownPlan = computed(() => this._plan() ?? this.lib.lastPlan());

  /**
   * Which message heads the dialog, decided by an actual plan rather than by "is anything pending".
   *
   *   'legacy'   the card really is in the old layout, and the firmware on it reads only the new
   *              one -- the alarming case, and the only one `migrate.warn` describes truthfully;
   *   'partial'  the card is organized, but some files are still filed in the wrong place. Almost
   *              always Game Boy sidecars written before the `sgb` namespace existed;
   *   null       nothing is out of place. The dialog stays perfectly openable -- sweeping the macOS
   *              leftovers is reason enough -- and must not accuse a card that is already fine.
   *
   * The distinction is the whole point: the button is always there, so the dialog is opened by hand
   * on healthy cards, and telling those users their saves are invisible to the console is a scare
   * with nothing behind it.
   */
  readonly outOfLayout = computed<'legacy' | 'partial' | null>(() => {
    const p = this.shownPlan();
    if (!p || !p.moves.length || !this.lib.readsBuckets()) return null;
    return p.observed === 'legacy' ? 'legacy' : 'partial';
  });

  /** How many files the plan still wants to move, the number `migrate.warnPartial` quotes. */
  readonly strayCount = computed(() => this.shownPlan()?.moves.length ?? 0);

  readonly rows = computed(() => {
    const p = this._plan();
    if (!p) return [];
    return Object.entries(p.byRoot).map(([path, v]) => ({
      key: ROOT_LABEL[path] ?? 'migrate.rootOther',
      path,
      files: v.files,
    }));
  });

  /**
   * The files we refused to attribute, grouped by the directory they sit in.
   *
   * The path is the whole point. A ficha and a cheat sheet for the same game are both
   * "<stem>.yml", so a flat list of names cannot say which of the two roots is still stuck --
   * and the natural reading ("it must be the fichas") is the wrong one as often as not.
   */
  readonly ambiguousGroups = computed(() => {
    const byPath = new Map<string, { root: string; path: string; names: string[] }>();
    for (const a of this._plan()?.ambiguous ?? []) {
      const g = byPath.get(a.path) ?? { root: a.root, path: a.path, names: [] };
      if (!g.names.includes(a.name)) g.names.push(a.name);
      byPath.set(a.path, g);
    }
    return [...byPath.values()].map((g) => ({
      root: g.root,
      path: g.path,
      label: ROOT_LABEL[g.root] ?? 'migrate.rootOther',
      count: g.names.length,
      sample: g.names.slice(0, 4).join(', ') + (g.names.length > 4 ? ` +${g.names.length - 4}` : ''),
    }));
  });

  /** How many are already in the quarantine, i.e. a previous run put them there and this run will
   *  do nothing to them. Without this the same list reappears run after run looking like a failure. */
  readonly ambiguousStuck = computed(
    () => (this._plan()?.ambiguous ?? []).filter((a) => a.path === ambiguousDirFor(a.root)).length,
  );

  /**
   * Delete the root recycle bins / volume metadata too. Default off, and deliberately not
   * remembered between openings: a destructive box that comes back pre-ticked is one the user
   * eventually stops reading.
   */
  private readonly _rmSystemDirs = signal(false);
  readonly rmSystemDirs = this._rmSystemDirs.asReadonly();
  toggleSystemDirs(ev: Event): void {
    this._rmSystemDirs.set((ev.target as HTMLInputElement).checked);
  }

  readonly canRun = computed(() => {
    const p = this._plan();
    if (!p || this.lib.working()) return false;
    // Moving is gated on the card's firmware, and so is renaming patches (it is 2.15+ that stopped
    // offering the same-stem ones); sweeping junk never is, and neither is deleting a recycle bin.
    return p.junk.length > 0 || p.emptyDirs > 0
      || (this._rmSystemDirs() && p.systemDirs.length > 0)
      || ((p.moves.length > 0 || p.renames.length > 0) && this.lib.canMoveFiles());
  });

  /** A couple of the renames, old -> new, so "3 patches" is something the user can recognise on
   *  their own card rather than a number to take on faith. */
  readonly renameSample = computed(() => {
    const r = this._plan()?.renames ?? [];
    return r.slice(0, 2).map((x) => `${x.name} → ${x.to}`).join(', ') + (r.length > 2 ? ` +${r.length - 2}` : '');
  });

  /** A run has been started (still going, or finished and reporting). From that moment "Depois" is a
   *  lie -- there is nothing left to postpone -- so the button becomes "Fechar". */
  readonly started = computed(() => this.lib.migrateRunning() || !!this.lib.migrateResult());

  /** Everything the run set out to do actually happened. */
  readonly resOk = computed(() => {
    const r = this.lib.migrateResult();
    return !!r && !r.unwritable && !r.aborted && !r.failed.length;
  });

  /** A few of the files that could not be moved, so the user has something to act on. */
  readonly failedNames = computed(() => {
    const f = this.lib.migrateResult()?.failed ?? [];
    return f.slice(0, 6).map((x) => x.name).join(', ') + (f.length > 6 ? ` +${f.length - 6}` : '');
  });

  readonly pct = computed(() => {
    const b = this.lib.bulk();
    return b?.total ? (b.done / b.total) * 100 : 0;
  });

  constructor() {
    /* Reopened to show a result (the run finished while the dialog was closed): do not walk the
       card again -- probeMigration already published a fresh plan, and a ~20s scan on top of the
       result screen would look like the run had restarted. */
    if (this.lib.migrateResult() || this.lib.migrateRunning()) this._plan.set(this.lib.lastPlan());
    else void this.refresh();

    /* Adopt the plan the store re-derives at the end of a run. Matters for a dialog that was opened
       while the run was going: run() below only feeds the instance that started it. */
    effect(() => {
      if (this.lib.migrateResult() && !this.lib.migrateRunning()) this._plan.set(this.lib.lastPlan());
    });
  }

  private async refresh(): Promise<void> {
    try {
      this._plan.set(await this.lib.planMigration());
    } catch (err) {
      console.error('[migration] preview failed', err);
    } finally {
      this._planned.set(true); // whatever happened, stop showing "scanning", see `planned`
    }
  }

  async run(): Promise<void> {
    await this.lib.runMigration({ removeSystemDirs: this._rmSystemDirs() });
    /* runMigration ends with probeMigration(), which re-derives the plan from the filesystem and
       publishes it. Reuse that instead of scanning the card a second time -- a full walk is ~20s
       on a loaded card, and the answer would be identical. */
    this._plan.set(this.lib.lastPlan() ?? (await this.lib.planMigration()));
  }
}

const ROOT_LABEL: Record<string, string> = {
  'sd2snes/info': 'migrate.rootInfo',
  'sd2snes/cheats': 'migrate.rootCheats',
  'sd2snes/saves': 'migrate.rootSaves',
  'sd2snes/states': 'migrate.rootStates',
};
