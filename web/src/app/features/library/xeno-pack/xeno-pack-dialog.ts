import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { CardWriter } from '../../../core/card-writer.service';
import { DialogService } from '../../../core/dialog.service';
import { downloadBlob } from '../../../core/download';
import { fmtSize } from '../../../core/format';
import { LangService } from '../../../core/lang.service';
import { LibraryStore } from '../../../core/library-store';
import { ToastService } from '../../../core/toast.service';
import { msuFileName, pcmFileName } from '../../../core/xeno-pack/msu-pcm';
import { XenoPlacement } from '../../../core/xeno-pack/xc-place.service';
import { ImportCancelled, ZipError, conflicts, copyEntry, fileSource, planImport, readZipDirectory, renameMap, streamTracks, type ImportPlan, type OutFile } from '../../../core/xeno-pack/msu-zip';
import { PackZip } from '../../../core/xeno-pack/pack-zip';
import { PackRunner } from '../../../core/xeno-pack/xeno-pack-runner';
import {
  XC_DUMP_CARD_DIR, XC_DUMP_CARD_FILE, PACK_APPROX_BYTES, cleanStem, looksLikeXenoCrisis, packStem,
} from '../../../core/xeno-pack/xc-rom';
import { DUMP_SIZE, TRACK_COUNT, ONCE_TRACKS, checkDump } from '../../../core/xeno-pack/xc-streams';
import { Icon } from '../../../ui/icon/icon';

type Phase = 'setup' | 'running' | 'done' | 'failed' | 'stopped';
type TrackState = 'wait' | 'work' | 'saving' | 'done';
interface TrackCell { n: number; state: TrackState; pct: number; loops: boolean }

const freshTracks = (): TrackCell[] =>
  Array.from({ length: TRACK_COUNT }, (_, i) => ({ n: i + 1, state: 'wait' as TrackState, pct: 0, loops: !ONCE_TRACKS.has(i + 1) }));

/** Builds the Xeno Crisis MSU-1 music pack from the user's own RP2040 flash dump. Decoding runs in a
 *  worker (core/xeno-pack); the files go to the card next to the ROM, or into a ZIP. Nothing is uploaded. */
@Component({
  selector: 'app-xeno-pack-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="requestClose()"></div>
    <div class="xp" [class.hot]="dumpHot()" (dragover)="onOver($event)" (dragleave)="onLeave($event)" (drop)="onDrop($event)">
      <div class="xh">
        <div>
          <h3>{{ 'xenoPack.title' | transloco }}</h3>
          <span class="sub">{{ 'xenoPack.subtitle' | transloco }}</span>
        </div>
        <button class="btn ghost sm" type="button" (click)="requestClose()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="xb scroll">
        @if (phase() === 'setup') {
          <div class="seg tabs">
            <button type="button" [class.on]="source() === 'dump'" (click)="source.set('dump')">{{ 'xenoPack.tabDump' | transloco }}</button>
            <button type="button" [class.on]="source() === 'zip'" (click)="source.set('zip')">{{ 'xenoPack.tabZip' | transloco }}</button>
          </div>

          @if (source() === 'zip') {
            <p class="intro">{{ 'xenoPack.zipIntro' | transloco }}</p>
            <section>
              <h4>{{ 'xenoPack.zipStep' | transloco }}</h4>
              @if (zipFile(); as f) {
                @if (zipPlan(); as p) {
                  <div class="ok"><app-icon name="check" [size]="14" /><span><b class="mono">{{ f.name }}</b> · {{ 'xenoPack.zipFound' | transloco: { count: p.tracks.length, prefix: p.prefix } }}</span></div>
                  @if (p.missing.length) { <div class="warn">{{ 'xenoPack.zipMissing' | transloco: { list: p.missing.join(', ') } }}</div> }
                }
              }
              @if (zipError(); as e) { <div class="bad">{{ e }}</div> }
              <div class="row">
                <button class="btn sm" type="button" [disabled]="zipReading()" (click)="pickZip()">
                  <app-icon name="upload" [size]="13" />{{ (zipReading() ? 'xenoPack.zipReading' : 'xenoPack.zipPick') | transloco }}
                </button>
                <span class="low">{{ 'xenoPack.dropHere' | transloco }}</span>
              </div>
            </section>
            <section>
              <h4>{{ 'xenoPack.stepTarget' | transloco }}</h4>
              @if (!cardPossible()) {
                <div class="warn">{{ 'xenoPack.zipNeedsCard' | transloco }}</div>
              } @else {
                @if (candidates().length > 1) {
                  <label class="fld">
                    <span>{{ 'xenoPack.rom' | transloco }}</span>
                    <select (change)="selectedId.set($any($event.target).value)">
                      @for (c of candidates(); track c.id) {
                        <option [value]="c.id" [selected]="c.id === selectedKey()">{{ c.file }}{{ c.folder ? ' · ' + c.folder : '' }}</option>
                      }
                    </select>
                  </label>
                } @else if (selected(); as s) {
                  <div class="rom"><app-icon name="gamepad" [size]="14" /><span class="mono">{{ s.file }}</span></div>
                }
                @if (sharedCount() > 0) { <div class="warn">{{ 'xenoPack.folderHint' | transloco: { count: sharedCount() } }}</div> }
                @if (existing()) { <div class="warn">{{ 'xenoPack.replaces' | transloco }}</div> }
              }
            </section>
            @if (lib.bulk()) { <div class="warn">{{ 'xenoPack.busy' | transloco }}</div> }
          } @else {
          <p class="intro">{{ 'xenoPack.intro' | transloco }}</p>

          <section>
            <h4>{{ 'xenoPack.stepDump' | transloco }}</h4>
            <p class="hint">{{ 'xenoPack.dumpHint' | transloco }}</p>
            @if (dump(); as d) {
              <div class="ok"><app-icon name="check" [size]="14" /><span><b class="mono">{{ d.name }}</b> · {{ 'xenoPack.recognised' | transloco }}</span></div>
            }
            @if (dumpError(); as e) { <div class="bad">{{ e }}</div> }
            <div class="row">
              <button class="btn sm" type="button" [disabled]="reading()" (click)="pick()">
                <app-icon name="upload" [size]="13" />{{ (reading() ? 'xenoPack.reading' : 'xenoPack.pick') | transloco }}
              </button>
              @if (cardDump(); as f) {
                <button class="btn sm" type="button" [disabled]="reading()" (click)="useFile(f)">
                  <app-icon name="sd" [size]="13" />{{ 'xenoPack.fromCard' | transloco: { file: f.name } }}
                </button>
              }
              <span class="low">{{ 'xenoPack.dropHere' | transloco }}</span>
            </div>
          </section>

          <section>
            <h4>{{ 'xenoPack.stepTarget' | transloco }}</h4>
            @if (cardPossible()) {
              <div class="seg">
                <button type="button" [class.on]="mode() === 'card'" (click)="modeChoice.set('card')">{{ 'xenoPack.toCard' | transloco }}</button>
                <button type="button" [class.on]="mode() === 'zip'" (click)="modeChoice.set('zip')">{{ 'xenoPack.toZip' | transloco }}</button>
              </div>
            }
            @if (mode() === 'card') {
              @if (candidates().length > 1) {
                <label class="fld">
                  <span>{{ 'xenoPack.rom' | transloco }}</span>
                  <select (change)="selectedId.set($any($event.target).value)">
                    @for (c of candidates(); track c.id) {
                      <option [value]="c.id" [selected]="c.id === selectedKey()">{{ c.file }}{{ c.folder ? ' · ' + c.folder : '' }}</option>
                    }
                  </select>
                </label>
              } @else if (selected(); as s) {
                <div class="rom"><app-icon name="gamepad" [size]="14" /><span class="mono">{{ s.file }}</span></div>
              }
              <p class="hint">{{ 'xenoPack.willWrite' | transloco: { stem: stem(), folder: folderLabel(), size: size } }}</p>
              @if (sharedCount() > 0) { <div class="warn">{{ 'xenoPack.folderHint' | transloco: { count: sharedCount() } }}</div> }
              @if (existing()) { <div class="warn">{{ 'xenoPack.replaces' | transloco }}</div> }
              @if (msuThere()) { <p class="hint">{{ 'xenoPack.msuKept' | transloco: { stem: stem() } }}</p> }
            } @else {
              @if (!lib.hasCard()) { <p class="hint">{{ 'xenoPack.noCard' | transloco }}</p> }
              @else if (!selected()) { <p class="hint">{{ 'xenoPack.noRom' | transloco }}</p> }
              <label class="fld">
                <span>{{ 'xenoPack.stemLabel' | transloco }}</span>
                <input type="text" spellcheck="false" [value]="stemInput()" (input)="stemInput.set($any($event.target).value)" />
              </label>
              @if (!stem()) { <div class="bad">{{ 'xenoPack.stemBad' | transloco }}</div> }
              <p class="hint">{{ 'xenoPack.stemHint' | transloco }}</p>
              <p class="hint">{{ 'xenoPack.willZip' | transloco: { stem: stem() || '…', size: size } }}</p>
            }
          </section>

          @if (lib.bulk()) { <div class="warn">{{ 'xenoPack.busy' | transloco }}</div> }
          <p class="hint">{{ 'xenoPack.time' | transloco }}</p>
          }
        } @else {
          <section>
            <div class="bar"><i [style.width.%]="overall()"></i></div>
            <p class="status">
              @switch (phase()) {
                @case ('running') { {{ (currentSaving() ? 'xenoPack.saving' : 'xenoPack.building') | transloco: { n: current(), total: total } }} }
                @case ('done') { {{ (resultMode() === 'card' ? 'xenoPack.doneCard' : 'xenoPack.doneZip') | transloco: { count: savedCount() + 1, folder: resultFolder(), stem: resultStem() } }} }
                @case ('stopped') { {{ 'xenoPack.cancelled' | transloco: { count: savedCount(), stem: resultStem() } }} }
                @case ('failed') { <span class="bad-t">{{ error() }}</span> }
              }
            </p>
            <div class="grid">
              @for (t of tracks(); track t.n) {
                <div class="cell" [class.work]="t.state === 'work' || t.state === 'saving'" [class.done]="t.state === 'done'"
                     [title]="('xenoPack.track' | transloco: { n: t.n }) + ' · ' + ((t.loops ? 'xenoPack.trackLoop' : 'xenoPack.trackOnce') | transloco)">
                  <b>{{ t.n }}</b>
                  <i [style.width.%]="t.state === 'done' ? 100 : t.pct"></i>
                </div>
              }
            </div>
            @if (phase() === 'done' && resultSource() === 'zip') {
              @if (importInvalid().length) { <div class="warn">{{ 'xenoPack.zipInvalid' | transloco: { list: importInvalid().join(', ') } }}</div> }
              @if (importMissing().length) { <div class="warn">{{ 'xenoPack.zipMissing' | transloco: { list: importMissing().join(', ') } }}</div> }
            } @else if (phase() === 'done') {
              @if (allChecked()) { <div class="ok"><app-icon name="check" [size]="14" /><span>{{ 'xenoPack.verified' | transloco }}</span></div> }
              @else { <div class="warn">{{ 'xenoPack.unverified' | transloco }}</div> }
            }
          </section>
        }
      </div>

      <div class="xf">
        @switch (phase()) {
          @case ('setup') {
            <button class="btn" type="button" (click)="requestClose()">{{ 'xenoPack.cancel' | transloco }}</button>
            <button class="btn primary" type="button" [disabled]="!(source() === 'zip' ? canInstall() : canStart())" (click)="source() === 'zip' ? startZip() : start()">
              <app-icon name="sound" [size]="14" />{{ (source() === 'zip' ? 'xenoPack.zipStart' : 'xenoPack.start') | transloco }}
            </button>
          }
          @case ('running') {
            <button class="btn" type="button" (click)="stop()">{{ 'xenoPack.stop' | transloco }}</button>
          }
          @default {
            @if (zipChunks() && phase() === 'done') {
              <button class="btn" type="button" (click)="saveZip()"><app-icon name="download" [size]="14" />{{ 'xenoPack.download' | transloco }}</button>
            }
            <button class="btn" type="button" (click)="again()">{{ 'xenoPack.again' | transloco }}</button>
            <button class="btn primary" type="button" (click)="close.emit()">{{ 'xenoPack.closeBtn' | transloco }}</button>
          }
        }
      </div>
    </div>
    <input #fi type="file" hidden (change)="onPick($event)" />
    <input #fz type="file" accept=".zip,application/zip" hidden (change)="onPickZip($event)" />
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .xp {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(600px, 94vw); max-height: 88dvh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .xp.hot { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-line), 0 24px 60px rgba(0, 0, 0, 0.55); }
    .xh { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .xh h3 { margin: 0; font-size: 15px; }
    .xh .sub { font-size: 11.5px; color: var(--tx-low); }
    .xb { overflow: auto; padding: 4px 18px 14px; display: flex; flex-direction: column; gap: 4px; }
    .intro { margin: 12px 0 4px; font-size: 12.5px; line-height: 1.5; color: var(--tx-mid); }
    section { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    h4 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.1px; color: var(--tx-low); font-weight: 600; }
    .hint { margin: 0; font-size: 12px; line-height: 1.45; color: var(--tx-low); }
    .low { font-size: 12px; color: var(--tx-low); }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mono { font-family: var(--mono); font-size: 12px; }
    .ok, .warn, .bad {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px; font-size: 12.5px; line-height: 1.45;
    }
    .ok { color: var(--ok); background: color-mix(in oklab, var(--ok) 12%, transparent); }
    .ok b { color: var(--tx); }
    .warn { color: var(--tx-mid); background: var(--amber-soft, color-mix(in oklab, #e2b341 14%, transparent)); border: 1px solid color-mix(in oklab, #e2b341 35%, transparent); }
    .bad { color: var(--danger); background: var(--danger-soft); }
    .bad-t { color: var(--danger); }
    .seg { display: flex; gap: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 11px; padding: 4px; }
    .tabs { margin-top: 12px; }
    .seg button { flex: 1; border: 0; background: transparent; color: var(--tx-mid); padding: 7px 10px; border-radius: 8px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .seg button.on { background: var(--panel-2); color: var(--tx); box-shadow: 0 0 0 1px var(--line); }
    .fld { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--tx-low); }
    .fld select, .fld input {
      background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; color: var(--tx);
      padding: 8px 10px; font: inherit; font-size: 13px;
    }
    .rom { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--line-soft); }
    .bar { height: 8px; border-radius: 99px; background: var(--panel-2); overflow: hidden; border: 1px solid var(--line-soft); }
    .bar i { display: block; height: 100%; background: var(--accent); transition: width 0.2s; }
    .status { margin: 0; font-size: 13px; line-height: 1.5; color: var(--tx); }
    .grid { display: grid; grid-template-columns: repeat(13, 1fr); gap: 5px; }
    .cell { position: relative; height: 34px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--line-soft); overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .cell b { position: relative; z-index: 1; font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--tx-mid); }
    .cell i { position: absolute; left: 0; bottom: 0; height: 100%; background: color-mix(in oklab, var(--accent) 26%, transparent); transition: width 0.15s; }
    .cell.done { border-color: color-mix(in oklab, var(--ok) 55%, transparent); }
    .cell.done i { background: color-mix(in oklab, var(--ok) 22%, transparent); }
    .cell.done b { color: var(--tx); }
    .cell.work { border-color: var(--accent-line); }
    .xf { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--line); }
    @media (max-width: 520px) { .grid { grid-template-columns: repeat(7, 1fr); } }
  `,
})
export class XenoPackDialog {
  /** The library entry the dialog was opened from (preselects its ROM), or null from the settings popover. */
  readonly entryId = input<string | null>(null);
  readonly close = output<void>();

  protected readonly lib = inject(LibraryStore);
  private readonly card = inject(CardWriter);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslocoService);
  private readonly langs = inject(LangService);
  private readonly fi = viewChild.required<ElementRef<HTMLInputElement>>('fi');
  private readonly fz = viewChild.required<ElementRef<HTMLInputElement>>('fz');
  private readonly runner = new PackRunner();
  private readonly placement = inject(XenoPlacement);
  private readonly dialog = inject(DialogService);

  protected readonly total = TRACK_COUNT;
  protected readonly size = fmtSize(PACK_APPROX_BYTES);
  protected readonly phase = signal<Phase>('setup');
  /** Where the pack comes from: built from the cartridge dump, or a ready-made MSU-1 .zip installed as it is. */
  protected readonly source = signal<'dump' | 'zip'>('dump');
  protected readonly resultSource = signal<'dump' | 'zip'>('dump');
  protected readonly zipFile = signal<File | null>(null);
  protected readonly zipPlan = signal<ImportPlan | null>(null);
  protected readonly zipError = signal<string | null>(null);
  protected readonly zipReading = signal(false);
  protected readonly importInvalid = signal<number[]>([]);
  protected readonly importMissing = signal<number[]>([]);
  private importCancel = false;

  /* ----- dump ----- */
  protected readonly dump = signal<{ name: string; bytes: Uint8Array } | null>(null);
  protected readonly dumpError = signal<string | null>(null);
  protected readonly dumpHot = signal(false);
  protected readonly reading = signal(false);
  protected readonly cardDump = signal<File | null>(null);

  /* ----- target ----- */
  protected readonly candidates = computed(() =>
    this.lib.entries().filter((e) => (looksLikeXenoCrisis(e) || e.id === this.entryId()) && !!e.dirHandle && !!e.fileHandle));
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => {
    const list = this.candidates();
    return list.find((e) => e.id === (this.selectedId() ?? this.entryId())) ?? list[0] ?? null;
  });
  protected readonly selectedKey = computed(() => this.selected()?.id ?? null);
  protected readonly cardPossible = computed(() => this.lib.hasCard() && !!this.selected());
  protected readonly modeChoice = signal<'card' | 'zip' | null>(null);
  protected readonly mode = computed<'card' | 'zip'>(() => (this.cardPossible() ? (this.modeChoice() ?? 'card') : 'zip'));
  protected readonly stemInput = signal('Xeno Crisis');
  protected readonly stem = computed(() => {
    const s = this.selected();
    return this.mode() === 'card' && s ? packStem(s.file) : cleanStem(this.stemInput());
  });
  protected readonly folderLabel = computed(() => {
    this.langs.ready();
    return this.selected()?.folder || this.lib.rootName();
  });
  protected readonly existing = signal(false);
  protected readonly msuThere = signal(false);
  protected readonly sharedCount = signal(0);
  protected readonly preparing = signal(false);

  protected readonly canInstall = computed(
    () => this.phase() === 'setup' && !!this.zipPlan() && this.cardPossible() && !this.zipReading() && !this.lib.bulk() && !this.preparing(),
  );
  protected readonly canStart = computed(
    () => this.phase() === 'setup' && !!this.dump() && !this.reading() && !!this.stem() && !this.lib.bulk() && !this.preparing(),
  );

  /* ----- run state ----- */
  protected readonly tracks = signal<TrackCell[]>(freshTracks());
  protected readonly error = signal('');
  protected readonly current = signal(1);
  protected readonly currentSaving = signal(false);
  protected readonly savedCount = signal(0);
  protected readonly checkedCount = signal(0);
  protected readonly zipChunks = signal<Uint8Array[] | null>(null);
  protected readonly resultMode = signal<'card' | 'zip'>('zip');
  protected readonly resultStem = signal('');
  protected readonly resultFolder = signal('');
  protected readonly allChecked = computed(() => this.checkedCount() === TRACK_COUNT);
  protected readonly overall = computed(() => {
    const t = this.tracks();
    return (t.reduce((a, c) => a + (c.state === 'done' ? 1 : c.pct / 100), 0) / TRACK_COUNT) * 100;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.importCancel = true; this.runner.cancel(); });
    // A dump left on the card is picked up (and checked) right away.
    void this.lib.cardFile(XC_DUMP_CARD_DIR, XC_DUMP_CARD_FILE).then((f) => {
      this.cardDump.set(f);
      if (f && !this.dump()) void this.useFile(f);
    });
    // Which of the pack's files are already beside the ROM (the write replaces them).
    effect(() => {
      const s = this.selected();
      const stem = this.stem();
      const card = this.mode() === 'card';
      untracked(() => void this.probeExisting(card ? s?.dirHandle : undefined, stem));
    });
    // Other ROMs in the game's folder: the pack needs a folder of its own (the build asks before moving anything).
    effect(() => {
      const s = this.selected();
      const card = this.mode() === 'card';
      untracked(() => void (card && s ? this.placement.sharedWith(s) : Promise.resolve([] as string[])).then((o) => this.sharedCount.set(o.length)));
    });
  }

  private async probeExisting(dir: FileSystemDirectoryHandle | undefined, stem: string): Promise<void> {
    const has = async (name: string): Promise<boolean> => !!dir && !!stem && (await dir.getFileHandle(name).then(() => true, () => false));
    this.existing.set(await has(pcmFileName(stem, 1)));
    this.msuThere.set(await has(msuFileName(stem)));
  }

  /* ----- picking the dump ----- */
  protected pick(): void {
    this.fi().nativeElement.value = '';
    this.fi().nativeElement.click();
  }
  protected async onPick(e: Event): Promise<void> {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) await this.useFile(f);
  }
  protected onOver(e: DragEvent): void {
    if (this.phase() !== 'setup' || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    this.dumpHot.set(true);
  }
  protected onLeave(e: DragEvent): void {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) this.dumpHot.set(false);
  }
  protected async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.dumpHot.set(false);
    const f = e.dataTransfer?.files?.[0];
    if (!f || this.phase() !== 'setup') return;
    if (/\.zip$/i.test(f.name)) { this.source.set('zip'); await this.useZip(f); }
    else { this.source.set('dump'); await this.useFile(f); }
  }

  /* ----- installing a ready-made pack from a .zip ----- */
  protected pickZip(): void {
    this.fz().nativeElement.value = '';
    this.fz().nativeElement.click();
  }
  protected async onPickZip(e: Event): Promise<void> {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) await this.useZip(f);
  }

  /** Read the archive's directory (names and sizes only) and work out which entries are the pack. */
  protected async useZip(f: File): Promise<void> {
    this.zipFile.set(null);
    this.zipPlan.set(null);
    this.zipError.set(null);
    this.zipReading.set(true);
    try {
      const r = planImport(await readZipDirectory(fileSource(f)));
      if (r.ok) { this.zipFile.set(f); this.zipPlan.set(r.plan); }
      else if (r.reason === 'none') this.zipError.set(this.i18n.translate('xenoPack.zipNone'));
      else if (r.reason === 'prefixes') this.zipError.set(this.i18n.translate('xenoPack.zipPrefixes', { list: r.detail.join(', ') }));
      else this.zipError.set(this.i18n.translate('xenoPack.zipDuplicates', { list: r.detail.join(', ') }));
    } catch (err) {
      this.zipError.set(this.i18n.translate('xenoPack.zipBroken', { error: err instanceof ZipError || err instanceof Error ? err.message : String(err) }));
    } finally {
      this.zipReading.set(false);
    }
  }

  /** Confirm, give the ROM a folder of its own if it shares one, then copy the tracks (renamed) and write the `.msu` last. */
  protected async startZip(): Promise<void> {
    const file = this.zipFile();
    const plan = this.zipPlan();
    const first = this.selected();
    if (!file || !plan || !first?.dirHandle) return;
    const stem = packStem(first.file);
    const map = renameMap(stem, plan);
    const present: string[] = [];
    for await (const [name, h] of first.dirHandle.entries()) if (h.kind === 'file') present.push(name);
    const clash = conflicts(map.map((m) => m.to), present);
    const ask = await this.dialog.confirm({
      title: this.i18n.translate('xenoPack.zipConfirmTitle'),
      body: this.i18n.translate('xenoPack.zipConfirmBody', {
        count: plan.tracks.length, stem, missing: plan.missing.length ? plan.missing.join(', ') : this.i18n.translate('xenoPack.zipNoneMissing'),
      }) + '\n\n' + this.i18n.translate(plan.msu ? 'xenoPack.zipMsuCopy' : 'xenoPack.zipMsuNew', { stem }) + (clash.length ? '\n\n' + this.i18n.translate('xenoPack.zipConfirmReplace', { count: clash.length }) : ''),
      confirmLabel: this.i18n.translate('xenoPack.zipConfirmButton'),
    });
    if (!ask.ok) return;

    this.preparing.set(true);
    const ready = await this.placement.ensureOwnFolder(first.id);
    this.preparing.set(false);
    if (!ready) return;
    const dir = this.selected()?.dirHandle;
    if (!dir) return;

    this.resultMode.set('card');
    this.resultSource.set('zip');
    this.resultStem.set(stem);
    this.resultFolder.set(this.folderLabel());
    this.tracks.set(freshTracks());
    this.savedCount.set(0);
    this.importInvalid.set([]);
    this.importMissing.set(plan.missing);
    this.error.set('');
    this.importCancel = false;
    this.current.set(plan.tracks[0]?.n ?? 1);
    this.currentSaving.set(true);
    this.phase.set('running');
    this.card.resetWriteHealth();

    const patch = (n: number, p: Partial<TrackCell>): void => this.tracks.update((t) => t.map((c) => (c.n === n ? { ...c, ...p } : c)));
    const openOut = async (name: string): Promise<OutFile> => {
      // An aborted write keeps a file that was already there as it was, but one it created would stay behind empty.
      const existed = await dir.getFileHandle(name).then(() => true, () => false);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      let n = 0;
      return {
        write: async (c) => { await w.write(c as FileSystemWriteChunkType); n += c.length; },
        close: async () => {
          await w.close();
          const size = (await fh.getFile()).size;
          if (size !== n) throw new Error(`${name}: short write (${size} of ${n} bytes)`);
        },
        abort: async () => {
          await w.abort();
          if (!existed) await dir.removeEntry(name).catch(() => undefined);
        },
      };
    };
    try {
      const r = await streamTracks({
        src: fileSource(file), plan, stem, openOut,
        cancelled: () => this.importCancel,
        onProgress: (n, d, t) => { this.current.set(n); patch(n, { state: 'saving', pct: (d / t) * 100 }); },
        onTrackDone: (n) => { patch(n, { state: 'done', pct: 100 }); this.savedCount.update((c) => c + 1); },
      });
      this.importInvalid.set(r.invalid);
      // Last on purpose: until the .msu exists the console ignores the pack, so an interrupted install never leaves a half pack active.
      // The pack's own .msu is copied as it is; a pack without one gets an empty file.
      if (plan.msu) await copyEntry({ src: fileSource(file), entry: plan.msu, name: msuFileName(stem), openOut, cancelled: () => this.importCancel });
      else await this.card.write(dir, msuFileName(stem), new Uint8Array(0));
      this.toast.show(this.i18n.translate('xenoPack.toastDone', { stem }), 'ok');
      this.phase.set('done');
    } catch (err) {
      if (err instanceof ImportCancelled) return;
      this.fail(this.i18n.translate('xenoPack.failedGeneric', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  protected async useFile(f: File): Promise<void> {
    this.dump.set(null);
    this.dumpError.set(null);
    if (f.size !== DUMP_SIZE) {
      this.dumpError.set(this.i18n.translate('xenoPack.errSize', { actual: f.size }));
      return;
    }
    this.reading.set(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const c = checkDump(bytes);
      if (c.ok) this.dump.set({ name: f.name, bytes });
      else this.dumpError.set(this.i18n.translate(c.reason === 'size' ? 'xenoPack.errSize' : 'xenoPack.errVersion', { actual: f.size }));
    } catch (err) {
      this.dumpError.set(this.i18n.translate('xenoPack.failedGeneric', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.reading.set(false);
    }
  }

  /* ----- running ----- */
  private cardDir: FileSystemDirectoryHandle | null = null;
  private writeError = '';
  private zip: PackZip | null = null;
  /** Bumped on every dump run: a write still in flight from a stopped run must not count in the next one. */
  private runId = 0;

  protected async start(): Promise<void> {
    const d = this.dump();
    const stem = this.stem();
    if (!d || !stem) return;
    const mode = this.mode();
    if (mode === 'card' && this.selected()) {
      // The ROM must be alone in its folder (asks first, moves the ROM and its companions, updates the lists).
      this.preparing.set(true);
      const ok = await this.placement.ensureOwnFolder(this.selected()!.id);
      this.preparing.set(false);
      if (!ok) return;
    }
    const sel = this.selected();
    this.cardDir = mode === 'card' ? sel?.dirHandle ?? null : null;
    this.zip = mode === 'zip' ? new PackZip() : null;
    this.resultMode.set(mode);
    this.resultStem.set(stem);
    this.resultFolder.set(this.folderLabel());
    this.tracks.set(freshTracks());
    this.savedCount.set(0);
    this.checkedCount.set(0);
    this.zipChunks.set(null);
    this.error.set('');
    this.writeError = '';
    this.current.set(1);
    this.currentSaving.set(false);
    this.phase.set('running');
    this.card.resetWriteHealth();

    const run = ++this.runId;
    const patch = (n: number, p: Partial<TrackCell>): void =>
      this.tracks.update((t) => t.map((c) => (c.n === n ? { ...c, ...p } : c)));

    // The worker owns the buffer it is given; keep the parsed dump for a second run.
    const copy = d.bytes.slice().buffer;
    this.runner.start(copy, {
      onRefused: (r) => this.fail(this.i18n.translate(r.reason === 'size' ? 'xenoPack.errSize' : 'xenoPack.errVersion', { actual: r.reason === 'size' ? r.actual : 0 })),
      onProgress: (n, done, total) => {
        this.current.set(n);
        this.currentSaving.set(false);
        patch(n, { state: 'work', pct: (done / total) * 100 });
      },
      onTrack: async (r) => {
        const name = pcmFileName(stem, r.track);
        const bytes = new Uint8Array(r.bytes);
        this.currentSaving.set(true);
        patch(r.track, { state: 'saving', pct: 100 });
        try {
          if (this.cardDir) await this.card.write(this.cardDir, name, bytes);
          else this.zip!.add(name, bytes);
        } catch (err) {
          this.writeError = this.i18n.translate('xenoPack.writeFailed', { file: name, error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        if (run !== this.runId) return;
        if (r.rangeChecked) this.checkedCount.update((c) => c + 1);
        this.savedCount.update((c) => c + 1);
        patch(r.track, { state: 'done', pct: 100 });
      },
      onDone: () => void this.finish(stem),
      onError: (message, track, rangeMismatch) => {
        this.fail(
          this.writeError ? this.writeError
          : rangeMismatch ? this.i18n.translate('xenoPack.damaged', { track: track ?? 0 })
          : track != null ? this.i18n.translate('xenoPack.failed', { track, error: message })
          : this.i18n.translate('xenoPack.failedGeneric', { error: message }),
        );
      },
    });
  }

  private async finish(stem: string): Promise<void> {
    try {
      if (this.cardDir) {
        // Last on purpose: until the .msu exists the console ignores the pack, so an interrupted run never leaves a half pack active.
        // An .msu that is already there stays untouched; only a missing one is created (empty).
        if (!(await this.cardDir.getFileHandle(msuFileName(stem)).then(() => true, () => false))) {
          await this.card.write(this.cardDir, msuFileName(stem), new Uint8Array(0));
        }
        this.toast.show(this.i18n.translate('xenoPack.toastDone', { stem }), 'ok');
      } else if (this.zip) {
        this.zip.add(msuFileName(stem), new Uint8Array(0));
        this.zipChunks.set(this.zip.finish());
        this.saveZip();
      }
      this.phase.set('done');
    } catch (err) {
      this.fail(this.i18n.translate('xenoPack.writeFailed', { file: msuFileName(stem), error: err instanceof Error ? err.message : String(err) }));
    }
  }

  protected saveZip(): void {
    const chunks = this.zipChunks();
    if (chunks) downloadBlob(`${this.resultStem()}-msu1.zip`, new Blob(chunks as BlobPart[], { type: 'application/zip' }));
  }

  private fail(message: string): void {
    this.runner.cancel();
    this.error.set(message);
    this.phase.set('failed');
  }

  protected stop(): void {
    this.importCancel = true;
    this.runner.cancel();
    this.phase.set('stopped');
  }

  protected again(): void {
    this.zip = null;
    this.zipChunks.set(null);
    this.phase.set('setup');
  }

  protected requestClose(): void {
    if (this.phase() === 'running') { this.importCancel = true; this.runner.cancel(); }
    this.close.emit();
  }
}
