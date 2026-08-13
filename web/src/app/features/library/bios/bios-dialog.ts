import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { Icon } from '../../../ui/icon/icon';

interface SlotResult { crc: string; ok: boolean; error?: string; }

/** "BIOS dos chips", arraste qualquer arquivo (identificamos o slot pelo nome/CRC) ou em cada linha. */
@Component({
  selector: 'app-bios-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div
      class="bios" [class.hotany]="hotAny()"
      (dragover)="onOverAny($event)" (dragleave)="onLeaveAny($event)" (drop)="onDropAny($event)">
      <div class="bh">
        <div>
          <h3>{{ 'bios.title' | transloco }}</h3>
          <span class="sub">
            {{ 'bios.missingSummary' | transloco: { missing: missing(), total: lib.bios().length } }}
          </span>
        </div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="warn" [innerHTML]="'bios.warn' | transloco"></div>
      <div class="tip">
        <app-icon name="download" [size]="13" />
        <span [innerHTML]="'bios.tip' | transloco"></span>
      </div>

      <div class="blist scroll">
        @for (b of lib.bios(); track b.id) {
          @let r = results()[b.id];
          <div
            class="brow" [class.present]="b.present" [class.err]="r && !r.ok"
            (dragover)="onOver($event, b.id)" (dragleave)="hot.set(null)" (drop)="onDrop($event, b.id)"
            [class.hot]="hot() === b.id">
            <div class="info">
              <div class="chip">{{ b.chip }}</div>
              <div class="fn">{{ b.file }}</div>
            </div>

            @if (b.present) {
              <span class="badge ok"><app-icon name="check" [size]="13" />{{ 'bios.onCard' | transloco }}</span>
            } @else if (r && !r.ok) {
              <span class="badge bad" [title]="r.error || ''">CRC {{ r.crc }} ✗</span>
              <button class="btn ghost sm" type="button" (click)="pick(b.id)">{{ 'bios.tryAgain' | transloco }}</button>
            } @else {
              <span class="hint">{{ 'bios.dragOr' | transloco }}</span>
              <button class="btn ghost sm" type="button" (click)="pick(b.id)">{{ 'bios.browse' | transloco }}</button>
            }
          </div>
        }
      </div>

      @if (hotAny()) { <div class="drophint"><app-icon name="download" [size]="22" />{{ 'bios.dropToInstall' | transloco }}</div> }
    </div>
    <input #fi type="file" hidden (change)="onPick($event)" />
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .bios {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(560px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .bios.hotany { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-line), 0 24px 60px rgba(0, 0, 0, 0.55); }
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
    .tip b { color: var(--tx); }
    .blist { overflow: auto; padding: 8px 14px 16px; display: flex; flex-direction: column; gap: 6px; }
    .brow {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 9px;
      border: 1px dashed var(--line); background: var(--panel-2); min-height: 50px;
    }
    .brow.present { border-style: solid; border-color: var(--line-soft); }
    .brow.hot { border-color: var(--accent); background: var(--accent-soft); }
    .brow.err { border-color: var(--danger); }
    .brow .info { flex: 1; min-width: 0; }
    .brow .chip { font-size: 13px; font-weight: 500; }
    .brow .fn { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .brow .hint { font-size: 12px; color: var(--tx-low); }
    .badge { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; padding: 3px 8px; border-radius: 99px; }
    .badge.ok { color: var(--ok); background: color-mix(in oklab, var(--ok) 12%, transparent); }
    .badge.bad { color: var(--danger); background: var(--danger-soft); }
    .drophint {
      position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 10px; pointer-events: none;
      background: color-mix(in oklab, var(--accent) 16%, rgba(10, 12, 14, 0.82)); color: var(--tx);
      font-size: 14px; font-weight: 600; letter-spacing: 0.3px;
    }
    .drophint app-icon { color: var(--accent); }
  `,
})
export class BiosDialog {
  readonly close = output<void>();
  protected readonly lib = inject(LibraryStore);
  private readonly fi = viewChild.required<ElementRef<HTMLInputElement>>('fi');

  // Grouped count (SGB satisfied by either a complete v1 or v2 pair), same logic as the topbar badge.
  protected readonly missing = computed(() => this.lib.biosMissing());
  protected readonly results = signal<Record<string, SlotResult>>({});
  protected readonly hot = signal<string | null>(null);
  protected readonly hotAny = signal(false);
  private pickingId: string | null = null;

  /* ----- per-slot drop (explicit target). Stops propagation so it doesn't also auto-identify ----- */
  protected onOver(e: DragEvent, id: string): void {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    this.hotAny.set(false);
    this.hot.set(id);
  }

  protected async onDrop(e: DragEvent, id: string): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    this.hot.set(null);
    const f = e.dataTransfer?.files?.[0];
    if (f) await this.handle(id, f);
  }

  /* ----- global drop (auto-identify any dropped BIOS) ----- */
  protected onOverAny(e: DragEvent): void {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    this.hotAny.set(true);
  }
  protected onLeaveAny(e: DragEvent): void {
    // Only clear when actually leaving the dialog (not when moving between children).
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) this.hotAny.set(false);
  }
  protected async onDropAny(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.hotAny.set(false);
    for (const f of Array.from(e.dataTransfer?.files ?? [])) {
      const m = await this.lib.addBiosAuto(f);
      if (m) this.results.update((r) => ({ ...r, [m.id]: m.result }));
    }
  }

  protected pick(id: string): void {
    this.pickingId = id;
    this.fi().nativeElement.value = '';
    this.fi().nativeElement.click();
  }
  protected async onPick(e: Event): Promise<void> {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f && this.pickingId) await this.handle(this.pickingId, f);
  }

  private async handle(id: string, file: File): Promise<void> {
    const r = await this.lib.addBios(id, file);
    this.results.update((m) => ({ ...m, [id]: r }));
  }
}
