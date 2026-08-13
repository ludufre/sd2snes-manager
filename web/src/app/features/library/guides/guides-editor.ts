import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import type { Entry, GuideInfo } from '../../../core/models';
import { fmtSize, stemOf } from '../../../core/format';
import { Icon } from '../../../ui/icon/icon';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { pickPdfFile, pickImageFiles } from '../../../lib/scan.js';
import { manualTypeOfSlug, MANUAL_SLUG_TYPES, MAX_GUIDES, MAX_USER_GUIDES } from '../../../lib/man.js';
import { ManViewer } from './man-viewer';
import { ToastService } from '../../../core/toast.service';

type PendingInput = { kind: 'pdf'; file: File } | { kind: 'images'; files: File[] };
type ManualType = 'manual' | 'guide' | 'map' | 'insert' | 'other';

/** Manage a game's in-game manual/guides (`.man`): list what's on card, add a new user guide from a
 *  PDF or an ordered set of page images (rendered + encoded entirely in the browser, see lib/man.js),
 *  remove one. Slot 0 (`<stem>.man`) is the official GameDB manual, owned by auto-fill (see
 *  library-store.ts installManuals + GAMEDB-MANUALS-PLANO.md "Manager (autofill)"), shown here read-only
 *  with an "Official" badge; "Add" only ever targets a USER_GUIDE_SLOTS slot (2..8), so it never
 *  overwrites it. Molde: cheat-editor.ts / info-editor.ts. */
@Component({
  selector: 'app-guides-editor',
  imports: [Icon, TranslocoModule, ManViewer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="maybeClose()"></div>
    <div class="ed">
      <div class="eh">
        <div>
          <h3>{{ 'guides.title' | transloco }}</h3>
          <span class="sub">{{ entry().title }} · /sd2snes/info/&lt;C&gt;/{{ stem() }}[.NN].man</span>
        </div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="ebody scroll">
        @if (loading()) {
          <div class="empty">{{ 'guides.building' | transloco }}</div>
        } @else {
          @for (g of guides(); track g.nn) {
            <div class="grow-row">
              <app-icon name="book" [size]="16" />
              <div class="gi">
                <span class="gt">
                  @if (slugType(g); as st) {
                    {{ 'manualType.' + st | transloco }}
                  } @else {
                    {{ g.title || (g.nn === 0 ? ('guides.officialTitle' | transloco) : ('detail.guidesTitle' | transloco) + ' ' + g.nn) }}
                  }
                  @if (g.nn === 0) { <span class="obadge">{{ 'guides.officialBadge' | transloco }}</span> }
                </span>
                <span class="gm">
                  {{ 'guides.pages' | transloco: { count: g.npages } }} · {{ fmtSize(g.sizeBytes) }}
                  @if (g.zoom) { <span class="zbadge">{{ 'guides.zoomBadge' | transloco }}</span> }
                </span>
              </div>
              <button class="btn ghost sm" type="button" [disabled]="busy()" [title]="'manViewer.view' | transloco" (click)="openView(g)">
                <app-icon name="eye" [size]="14" />
              </button>
              <button class="btn ghost sm del" type="button" [disabled]="busy()" [title]="'guides.remove' | transloco" (click)="remove(g.nn)">
                <app-icon name="trash" [size]="14" />
              </button>
            </div>
          }
          @if (guides().length === 0 && !pending()) {
            <div class="empty">{{ 'guides.empty' | transloco }}</div>
          }
        }

        @if (pending(); as p) {
          <div class="addbox">
            <label class="fl">
              <span>{{ 'guides.typeLabel' | transloco }}</span>
              <div class="typesel">
                @for (t of manualTypes; track t) {
                  <button type="button" class="tbtn" [class.on]="pendingType() === t" (click)="pendingType.set(t)">{{ 'manualType.' + t | transloco }}</button>
                }
              </div>
            </label>
            <p class="hint">{{ 'guides.typeHint' | transloco }}</p>
            <label class="fl">
              <span>{{ 'guides.spreadLabel' | transloco }}</span>
              <div class="typesel">
                @for (s of spreadModes; track s) {
                  <button type="button" class="tbtn" [class.on]="pendingSpread() === s" (click)="pendingSpread.set(s)">
                    {{ 'guides.spread' + (s === 'auto' ? 'Auto' : s === 'on' ? 'On' : 'Off') | transloco }}
                  </button>
                }
              </div>
            </label>
            <p class="hint">{{ 'guides.spreadHint' | transloco }}</p>
            <p class="hint">{{ p.kind === 'pdf' ? p.file.name : ('guides.imagesSelected' | transloco: { count: p.files.length }) }}</p>
            <div class="addf">
              <button class="btn ghost sm" type="button" [disabled]="building()" (click)="pending.set(null)">{{ 'guides.cancel' | transloco }}</button>
              <button class="btn sm primary" type="button" [disabled]="building()" (click)="confirmAdd()">
                <app-icon name="save" [size]="13" />{{ building() ? ('guides.building' | transloco) : ('guides.save' | transloco) }}
              </button>
            </div>
          </div>
        }
      </div>

      <div class="ef">
        <span class="cap" [class.full]="capReached()">{{ 'guides.cap' | transloco: { count: guides().length, max: max } }}</span>
        <div class="grow"></div>
        <button class="btn sm" type="button" [disabled]="capReached() || !!pending() || building()" (click)="addFromPdf()">
          <app-icon name="upload" [size]="13" />{{ 'guides.addPdf' | transloco }}
        </button>
        <button class="btn sm" type="button" [title]="'guides.imagesHint' | transloco" [disabled]="capReached() || !!pending() || building()" (click)="addFromImages()">
          <app-icon name="image" [size]="13" />{{ 'guides.addImages' | transloco }}
        </button>
        <button class="btn ghost sm" type="button" (click)="close.emit()">{{ 'guides.close' | transloco }}</button>
      </div>
    </div>

    @if (viewing(); as v) {
      <app-man-viewer [bytes]="v.bytes" [label]="v.label" [filename]="v.filename" (close)="viewing.set(null)" />
    }
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .ed {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(560px, 95vw); max-height: 88vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .eh { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .eh h3 { margin: 0; font-size: 15px; }
    .eh .sub { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .ebody { overflow: auto; padding: 8px 18px 12px; display: flex; flex-direction: column; gap: 8px; }
    .grow-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; }
    .gi { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .gt { font-size: 13px; }
    .gm { font-family: var(--mono); font-size: 10.5px; color: var(--tx-low); display: flex; align-items: center; gap: 6px; }
    .zbadge { font-size: 9px; padding: 1px 5px; border-radius: 5px; background: var(--accent); color: #fff; }
    .obadge { font-size: 9px; padding: 1px 5px; border-radius: 5px; background: var(--ok); color: #06280f; margin-left: 6px; vertical-align: middle; }
    .del { color: var(--tx-low); }
    .del:hover { color: var(--danger); }
    .empty { color: var(--tx-low); font-family: var(--mono); font-size: 13px; padding: 24px; text-align: center; }
    .addbox { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px dashed var(--line); border-radius: 10px; margin-top: 4px; }
    .fl { display: flex; flex-direction: column; gap: 5px; }
    .fl > span { font-size: 11.5px; color: var(--tx-mid); }
    .fi {
      width: 100%; box-sizing: border-box; font-family: var(--sans); font-size: 13px; padding: 7px 9px;
      color: var(--tx); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; outline: none;
    }
    .fi:focus { border-color: var(--accent); }
    .typesel { display: flex; flex-wrap: wrap; gap: 6px; }
    .tbtn { font-size: 12px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--tx-mid); cursor: pointer; }
    .tbtn:hover { border-color: var(--accent); }
    .tbtn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .hint { margin: 0; font-size: 11px; color: var(--tx-low); }
    .addf { display: flex; justify-content: flex-end; gap: 8px; }
    .ef { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel-2); flex-wrap: wrap; }
    .grow { flex: 1; }
    .cap { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .cap.full { color: var(--danger); }
  `,
})
export class GuidesEditor {
  readonly entry = input.required<Entry>();
  readonly close = output<void>();
  private readonly lib = inject(LibraryStore);
  private readonly i18n = inject(TranslocoService);
  private readonly toast = inject(ToastService);

  /** The `.man` currently open in the viewer overlay (its raw bytes + a header/PDF label), or null. */
  protected readonly viewing = signal<{ bytes: Uint8Array; label: string; filename: string } | null>(null);

  /** Total physical `.man` slots for this stem (footer "N/8"), includes slot 0 (official) when present. */
  protected readonly max = MAX_GUIDES;
  protected readonly stem = computed(() => stemOf(this.entry().file));
  protected readonly guides = signal<GuideInfo[]>([]);
  /** Slot 0 excluded, only the slots the "Add" flow can actually claim (2..8). */
  protected readonly userGuides = computed(() => this.guides().filter((g) => g.nn !== 0));
  protected readonly loading = signal(false);
  protected readonly building = signal(false);
  protected readonly pending = signal<PendingInput | null>(null);
  /** Fixed document type for the new guide, baked as a slug into the `.man` header, exactly like the
   *  gamedb (no free-text title). The firmware translates the slug into the viewer's language. */
  protected readonly manualTypes = MANUAL_SLUG_TYPES as readonly ManualType[];
  protected readonly pendingType = signal<ManualType>('guide');
  /** Spread-split mode for the new guide: 'auto' splits pages whose aspect says "2-page spread scan"
   *  (each half becomes one emitted page with the full pixel budget); 'on'/'off' force it. */
  protected readonly spreadModes = ['auto', 'on', 'off'] as const;
  protected readonly pendingSpread = signal<'auto' | 'on' | 'off'>('auto');
  /** Disables "Add" once every user slot (2..8) is taken. Slot 0 (official) is never a candidate,
   *  so it doesn't free up capacity for the user even when absent. */
  protected readonly capReached = computed(() => this.userGuides().length >= MAX_USER_GUIDES);
  protected readonly busy = computed(() => this.building() || this.loading());
  protected readonly fmtSize = fmtSize;
  /** Document-type key for an official slug-tagged `.man` (→ localized via `manualType.*`), else null. */
  protected slugType(g: GuideInfo): string | null {
    return g.slug ? manualTypeOfSlug(g.slug) : null;
  }

  /** Plain-text label for a guide (viewer header + PDF name), mirrors the row's displayed name. */
  private guideLabel(g: GuideInfo): string {
    const st = this.slugType(g);
    if (st) return this.i18n.translate('manualType.' + st);
    if (g.title) return g.title;
    if (g.nn === 0) return this.i18n.translate('guides.officialTitle');
    return `${this.i18n.translate('detail.guidesTitle')} ${g.nn}`;
  }

  /** Load a guide's on-card `.man` bytes and open the viewer overlay (decode → render → optional PDF). */
  protected async openView(g: GuideInfo): Promise<void> {
    const bytes = await this.lib.readGuideBytes(this.entry(), g.nn);
    if (!bytes) { this.toast.show(this.i18n.translate('manViewer.error'), 'warn'); return; }
    const label = this.guideLabel(g);
    const filename = `${this.entry().title} - ${label}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    this.viewing.set({ bytes, label, filename });
  }

  private seededId: string | null = null;

  constructor() {
    effect(() => {
      const g = this.entry();
      if (!g || this.seededId === g.id) return;
      this.seededId = g.id;
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try { this.guides.set(await this.lib.listGuides(this.entry())); }
    finally { this.loading.set(false); }
  }

  protected maybeClose(): void {
    if (!this.building()) this.close.emit();
  }

  protected async addFromPdf(): Promise<void> {
    const file = await pickPdfFile();
    if (!file) return;
    this.pending.set({ kind: 'pdf', file });
    this.pendingType.set('guide');
    this.pendingSpread.set('auto');
  }

  protected async addFromImages(): Promise<void> {
    const files = await pickImageFiles();
    if (!files.length) return;
    this.pending.set({ kind: 'images', files });
    this.pendingType.set('guide');
    this.pendingSpread.set('auto');
  }

  protected async confirmAdd(): Promise<void> {
    const p = this.pending();
    if (!p) return;
    this.building.set(true);
    try {
      // Type (not a free-text title) → the `.man` is built identically to the gamedb (slug + zoom).
      const ok = await this.lib.addGuide(this.entry(), p, { type: this.pendingType(), spread: this.pendingSpread() });
      if (ok) { this.pending.set(null); await this.load(); }
    } finally {
      this.building.set(false);
    }
  }

  protected async remove(nn: number): Promise<void> {
    await this.lib.removeGuide(this.entry(), nn);
    await this.load();
  }
}
