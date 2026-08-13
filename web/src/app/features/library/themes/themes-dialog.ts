import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { ThemesService, type Theme } from '../../../core/themes.service';
import type { FolderNode } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';

interface FlatFolder { path: string; name: string; total: number; depth: number; }

/** Browse the sd2snes+ theme gallery (from the Landing), then download a `.thm` straight onto the
 *  card and apply it. Two states: the gallery grid, and a folder picker overlay shown after "Install". */
@Component({
  selector: 'app-themes-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="tw">
      <div class="th">
        <h3>{{ 'themes.heading' | transloco }}</h3>
        <a class="repo" href="https://sd2snes.ludufre.com/gallery/" target="_blank" rel="noopener">gallery ↗</a>
        <div class="grow"></div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      @if (error()) {
        <div class="tmsg err">{{ 'themes.loadError' | transloco: { error: error() } }}</div>
      } @else if (!list()) {
        <div class="tmsg">{{ 'themes.loading' | transloco }}</div>
      } @else {
        <div class="tbar">
          <div class="tabs scroll">
            @for (b of brands(); track b) {
              <button class="tab" [class.on]="brand() === b" type="button" (click)="brand.set(b)">{{ brandLabel(b) }}</button>
            }
          </div>
          <label class="search">
            <app-icon name="search" [size]="14" />
            <input #si type="search" [value]="query()" (input)="query.set(si.value)" [placeholder]="'themes.search' | transloco" />
          </label>
        </div>

        @if (filtered().length === 0) {
          <div class="tmsg">{{ 'themes.empty' | transloco }}</div>
        } @else {
          <div class="grid scroll">
            @for (t of filtered(); track t.file) {
              <div class="card">
                <div class="shot">
                  <!-- no-referrer: the previews sit behind Cloudflare hotlink protection, which 403s a
                       cross-origin Referer (harmless in prod/same-origin, but blocks dev + any embedder). -->
                  <img loading="lazy" referrerpolicy="no-referrer" [src]="themes.previewUrl(t.preview)" [alt]="t.name" />
                  @if (t.full) { <span class="fw" [title]="'themes.fwBadgeTip' | transloco">{{ 'themes.fwBadge' | transloco }}</span> }
                </div>
                <div class="body">
                  <div class="nm" [title]="t.name">{{ t.name }}</div>
                  <div class="br">{{ brandLabel(t.brand) }}</div>
                </div>
                <button class="btn sm primary dl" type="button" [disabled]="busy()" (click)="startInstall(t)">
                  <app-icon name="download" [size]="13" />{{ 'themes.install' | transloco }}
                </button>
              </div>
            }
          </div>
        }
      }

      @if (pendingInstall(); as pend) {
        <div class="destwrap" (click)="cancelInstall()">
          <div class="dest" (click)="$event.stopPropagation()">
            <div class="desth">
              <h4>{{ 'themes.chooseFolder' | transloco: { name: pend.name } }}</h4>
              <button class="btn ghost sm" type="button" (click)="cancelInstall()"><app-icon name="x" [size]="15" /></button>
            </div>
            <button class="btn sm mkfolder" type="button" [disabled]="busy()" (click)="createThemesFolder()">
              <app-icon name="folderPlus" [size]="14" />{{ 'themes.createThemesFolder' | transloco }}
            </button>
            <div class="dlist scroll">
              @for (f of flat(); track f.path) {
                <button
                  class="frow" [class.on]="f.path === lib.lastThemeDir()" [style.paddingLeft.px]="12 + f.depth * 16"
                  type="button" [disabled]="busy()" (click)="confirmDest(f.path)">
                  <app-icon [name]="f.path === '' ? 'folderOpen' : 'folder'" [size]="14" />
                  <span class="fnm">{{ f.name }}</span>
                  <span class="fct">{{ f.total }}</span>
                </button>
              }
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .tw {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(920px, 95vw); height: min(660px, 90vh); display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .th { display: flex; align-items: center; gap: 12px; padding: 13px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .th h3 { margin: 0; font-size: 15px; }
    .th .repo { font-family: var(--mono); font-size: 11px; color: var(--tx-low); text-decoration: none; }
    .th .repo:hover { color: var(--accent); }
    .grow { flex: 1; }
    .tmsg { flex: 1; display: grid; place-items: center; color: var(--tx-low); font-family: var(--mono); font-size: 13px; }
    .tmsg.err { color: var(--danger); }

    .tbar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .tabs { display: flex; gap: 5px; overflow-x: auto; flex: 1; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      flex: 0 0 auto; border: 1px solid var(--line); background: none; color: var(--tx-mid); cursor: pointer;
      font-family: var(--sans); font-size: 11.5px; padding: 5px 11px; border-radius: 999px; white-space: nowrap;
    }
    .tab:hover { color: var(--accent); border-color: var(--accent-soft); }
    .tab.on { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
    .search { display: flex; align-items: center; gap: 7px; flex: 0 1 200px; min-width: 0; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; color: var(--tx-low); }
    .search input { background: none; border: none; outline: none; color: var(--tx); font-family: var(--sans); font-size: 13px; width: 100%; }

    /* grid-auto-rows: max-content — an auto track mis-sizes to ~6px here (the card is a flex column with an
       aspect-ratio child, a Chromium row-sizing quirk), collapsing every card; max-content sizes rows to content. */
    .grid { flex: 1; overflow: auto; padding: 14px; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); grid-auto-rows: max-content; align-content: start; }
    .card { display: flex; flex-direction: column; background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
    .shot { position: relative; aspect-ratio: 512 / 448; background: #05040a; }
    .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .shot .fw {
      position: absolute; top: 7px; right: 7px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.02em;
      background: rgba(56, 212, 245, 0.2); color: #7fe6f7; padding: 2px 6px; border-radius: 5px; backdrop-filter: blur(3px);
    }
    .card .body { padding: 9px 11px 4px; }
    .card .nm { font-size: 13px; font-weight: 500; color: var(--tx); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card .br { font-family: var(--mono); font-size: 10.5px; color: var(--tx-low); margin-top: 2px; }
    .card .dl { margin: 8px 11px 11px; justify-content: center; }

    /* destination picker overlay (choose where to save the .thm) */
    .destwrap { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); display: grid; place-items: center; z-index: 2; }
    .dest {
      width: min(420px, 92%); max-height: 82%; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5); overflow: hidden;
    }
    .desth { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .desth h4 { margin: 0; font-size: 13.5px; font-weight: 500; }
    .mkfolder { margin: 12px 14px 6px; justify-content: center; }
    .dlist { overflow: auto; padding: 6px 8px 10px; }
    .frow {
      display: flex; align-items: center; gap: 9px; width: 100%; border: none; background: none; color: var(--tx-mid);
      font-family: var(--sans); font-size: 13px; padding: 8px 10px; border-radius: 7px; cursor: pointer; text-align: left;
    }
    .frow:hover { background: var(--elevated); color: var(--accent); }
    .frow.on { background: var(--accent-soft); color: var(--accent); }
    .frow .fnm { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .frow .fct { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .frow:disabled { opacity: 0.5; cursor: default; }
  `,
})
export class ThemesDialog {
  readonly close = output<void>();
  protected readonly lib = inject(LibraryStore);
  protected readonly themes = inject(ThemesService);
  protected readonly i18n = inject(TranslocoService);

  protected readonly list = signal<Theme[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly brand = signal('all');
  protected readonly query = signal('');
  protected readonly pendingInstall = signal<Theme | null>(null);
  protected readonly busy = computed(() => !!this.lib.bulk());

  /** Tabs: "all" + every brand present in the data, in first-appearance order. */
  protected readonly brands = computed(() => {
    const seen: string[] = [];
    for (const t of this.list() ?? []) if (!seen.includes(t.brand)) seen.push(t.brand);
    return ['all', ...seen];
  });

  protected readonly filtered = computed(() => {
    const b = this.brand();
    const q = this.query().trim().toLowerCase();
    return (this.list() ?? []).filter(
      (t) => (b === 'all' || t.brand === b) && (!q || t.name.toLowerCase().includes(q)),
    );
  });

  /** Flattened card-folder tree for the destination picker (mirrors move-picker). */
  protected readonly flat = computed(() => {
    const out: FlatFolder[] = [];
    const walk = (n: FolderNode, depth: number): void => {
      out.push({ path: n.path, name: n.path === '' ? this.lib.rootName() : n.name, total: n.total, depth });
      for (const c of n.childList) walk(c, depth + 1);
    };
    walk(this.lib.tree(), 0);
    return out;
  });

  constructor() {
    this.themes
      .listThemes()
      .then((ts) => this.list.set(ts))
      .catch((e: unknown) => this.error.set(e instanceof Error ? e.message : String(e)));
  }

  protected brandLabel(b: string): string {
    if (b === 'all') return this.i18n.translate('themes.all');
    return b === 'Luan Freitas (ludufre)' ? 'ludufre' : b; // Landing quirk: shorten the long ludufre brand
  }

  protected startInstall(t: Theme): void { this.pendingInstall.set(t); }
  protected cancelInstall(): void { this.pendingInstall.set(null); }

  /** Create/select the `_themes` root folder, then install there. */
  protected async createThemesFolder(): Promise<void> {
    const path = await this.lib.ensureThemesRoot();
    await this.confirmDest(path);
  }

  protected async confirmDest(path: string): Promise<void> {
    const t = this.pendingInstall();
    if (!t || this.busy()) return;
    this.pendingInstall.set(null);
    await this.lib.installTheme(t, path);
  }
}
