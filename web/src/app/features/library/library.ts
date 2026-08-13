import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../core/library-store';
import { PrefsStore } from '../../core/prefs-store';
import { Icon } from '../../ui/icon/icon';
import { Topbar } from '../../ui/topbar/topbar';
import { StatBar } from './statbar/statbar';
import { Toolbar } from './toolbar/toolbar';
import { BulkBar } from './bulkbar/bulkbar';
import { BulkProgress } from './bulkbar/bulk-progress';
import { Sidebar } from './sidebar/sidebar';
import { Breadcrumb } from './breadcrumb/breadcrumb';
import { ListView } from './views/list-view';
import { GalleryView } from './views/gallery-view';
import { DetailPanel } from './detail/detail-panel';
import { SettingsPop } from './settings/settings-pop';
import { Toasts } from './toasts/toasts';
import { Dialog } from '../../ui/dialog/dialog';
import { ContextMenu } from '../../ui/context-menu/context-menu';
import { MovePicker } from './move-picker/move-picker';
import { FirmwareDialog } from './firmware/firmware-dialog';
import { ThemesDialog } from './themes/themes-dialog';
import { BiosDialog } from './bios/bios-dialog';
import { MigrateDialog } from './migrate/migrate-dialog';
import { CheatEditor } from './cheats/cheat-editor';
import { InfoEditor } from './info/info-editor';
import { GuidesEditor } from './guides/guides-editor';
import { IdentifyDialog } from './identify/identify-dialog';
import { AutoFillDialog } from './autofill/autofill-dialog';
import { AutofillReport } from './autofill/autofill-report';
import { ChangelogDialog } from './changelog/changelog-dialog';
import { UpdateBanner } from './update-banner/update-banner';

/**
 * The single app screen, lays out the shell (topbar · statbar · toolbar ·
 * bulkbar · sidebar · views · detail) and the connect/empty state. All data
 * and behaviour come from the injected stores.
 */
@Component({
  selector: 'app-library',
  imports: [
    Icon, Topbar, StatBar, Toolbar, BulkBar, BulkProgress, Sidebar, Breadcrumb,
    ListView, GalleryView, DetailPanel, SettingsPop, Toasts, Dialog, ContextMenu, MovePicker, FirmwareDialog,
    ThemesDialog, UpdateBanner, BiosDialog, MigrateDialog, CheatEditor, InfoEditor, GuidesEditor, IdentifyDialog, AutoFillDialog, AutofillReport,
    ChangelogDialog, TranslocoModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library {
  protected readonly lib = inject(LibraryStore);
  protected readonly prefs = inject(PrefsStore);

  constructor() {
    // Warn before unload/refresh while a card-writing operation is in progress.
    window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
      if (this.lib.working()) {
        e.preventDefault();
        e.returnValue = ''; // required for the native confirm dialog in some browsers
      }
    });

    const narrow = window.matchMedia('(max-width: 860px)');
    narrow.addEventListener('change', (e) => this.tooNarrowForSplit.set(e.matches));
    // The chip-BIOS warning is opened manually from the topbar (openBios), never auto-shown.
    //
    // The SD-layout migration is the one exception, deliberately. Missing BIOS is a partial
    // degradation the user can live with; a card still in the old layout on firmware 2.15+ is
    // silently broken in a shape that looks exactly like data loss -- saves, cheats and covers all
    // read as absent -- and the Manager is the only thing that can explain it. So when we can
    // positively identify both halves (fw >= 2.15 and files that still need moving), we say so
    // without waiting to be asked.
    //
    // Not persisted across connects. An earlier version remembered "Later" in localStorage, which
    // meant postponing once silenced the warning forever on that card -- for a condition the user
    // has to act on, and which the Manager stops raising by itself the moment it is fixed.
    effect(() => {
      if (!this.lib.migrationRequired()) { this.migrateArmed = true; return; }
      if (!this.migrateArmed) return;          // already shown for this card; "Later" holds until re-connect
      this.migrateArmed = false;
      this.migrateOpen.set(true);
    });

    /* A run that finished reopens the dialog on its result screen. Starting the organize and then
       closing the modal (to watch the progress bar) is the normal thing to do -- and it used to
       mean the outcome was never shown at all, only a toast that fades. */
    effect(() => {
      if (this.lib.migrateResult()) this.migrateOpen.set(true);
    });
  }

  /** Re-armed whenever the card stops needing migration (fixed, or ejected, eject() clears the
   *  probe), so plugging a still-unorganized card back in raises it again. */
  private migrateArmed = true;

  protected closeMigrate(): void {
    this.migrateOpen.set(false);
    // Dismiss the result with the dialog, or the effect above would reopen it immediately.
    this.lib.clearMigrateResult();
  }

  protected readonly settingsOpen = signal(false);
  protected readonly firmwareOpen = signal(false);
  protected readonly themesOpen = signal(false);
  protected readonly biosOpen = signal(false);
  protected readonly migrateOpen = signal(false);
  protected readonly changelogOpen = signal(false);
  protected readonly drag = signal(false);

  /** Opened from the version pill or from the Settings footer, the popover closes with it, so the
   *  dialog isn't left sitting under a scrim that swallows the click that would dismiss it. */
  protected openChangelog(): void {
    this.settingsOpen.set(false);
    this.changelogOpen.set(true);
  }
  /** OS file/folder drag hovering the library (to import into the current folder). */
  protected readonly importHot = signal(false);

  protected readonly isEmpty = computed(
    () =>
      this.lib.filtered().length === 0 &&
      this.lib.visibleFolders().length === 0 &&
      this.lib.themesInCwd().length === 0,
  );
  /** True while the window is too narrow to host the split layout. Backed by matchMedia rather than
   *  a resize listener: it fires only when the threshold is actually crossed, not on every pixel.
   *  860px is where the sidebar becomes an overlay (see sidebar.ts), below it the inline detail
   *  panel would leave the list with almost nothing. */
  private readonly tooNarrowForSplit = signal(window.matchMedia('(max-width: 860px)').matches);

  /** Split degrades to the drawer on a narrow window, the panel then floats over the list instead
   *  of competing with it for width. */
  protected readonly splitLive = computed(() => this.prefs.view() === 'split' && !this.tooNarrowForSplit());

  /** Drawer detail (list/gallery, or a squeezed split) when a game is selected. */
  protected readonly showDrawer = computed(() => !this.splitLive() && !!this.lib.sel());

  protected async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.drag.set(false);
    if (this.lib.scan()) return; // a scan is already in flight
    // If a folder was dropped from the OS, open it directly (skip the picker).
    // getAsFileSystemHandle() must be called synchronously while the item is live.
    const item = e.dataTransfer?.items?.[0] as
      | (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
      | undefined;
    const pending = item?.getAsFileSystemHandle?.();
    if (pending) {
      try {
        const handle = await pending;
        if (handle) {
          await this.lib.connectFromHandle(handle as FileSystemDirectoryHandle);
          return;
        }
      } catch {
        /* fall through to the picker */
      }
    }
    void this.lib.connect();
  }

  /* ---- import: drop OS files/folders into the current folder ---- */
  protected onImportOver(e: DragEvent): void {
    if (this.lib.dragActive()) return; // internal move/copy drag, ignore
    if (!e.dataTransfer?.types?.includes('Files')) return; // only OS file drags
    e.preventDefault();
    this.importHot.set(true);
  }
  protected onImportLeave(e: DragEvent): void {
    const el = e.currentTarget as HTMLElement;
    const to = e.relatedTarget as Node | null;
    if (to && el.contains(to)) return; // moving onto a child, still inside
    this.importHot.set(false);
  }
  protected async onImportDrop(e: DragEvent): Promise<void> {
    if (this.lib.dragActive()) return; // internal DnD handled by drop targets
    const items = e.dataTransfer?.items;
    if (!items?.length) return;
    e.preventDefault();
    this.importHot.set(false);
    // capture handles synchronously while the items are still live
    const pending: Promise<FileSystemHandle | null>[] = [];
    for (const it of Array.from(items)) {
      if (it.kind !== 'file') continue;
      const get = (it as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })
        .getAsFileSystemHandle?.();
      if (get) pending.push(get);
    }
    if (!pending.length) return;
    try {
      const handles = (await Promise.all(pending)).filter((h): h is FileSystemHandle => !!h);
      if (handles.length) await this.lib.importDropped(handles, this.lib.cwd());
    } catch {
      /* ignore */
    }
  }
}
