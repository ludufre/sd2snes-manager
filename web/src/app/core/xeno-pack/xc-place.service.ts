import { inject, Injectable } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { CardWriter } from '../card-writer.service';
import { DialogService } from '../dialog.service';
import type { Entry } from '../models';
import { LibraryStore } from '../library-store';
import { ToastService } from '../toast.service';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { systemOf } from '../../lib/scan.js';
import { XC_DUMP_CARD_DIR, XC_DUMP_CARD_FILE } from './xc-rom';
import { companionNames, joinPath, otherRoms, pickDumpCandidates, pickFolderName, rewriteListedPaths } from './xc-place';
import { probeDump } from './xc-status';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRomName = (n: string): boolean => !!systemOf(n);
const stemOfName = (n: string): string => (n.lastIndexOf('.') > 0 ? n.slice(0, n.lastIndexOf('.')) : n);

async function namesIn(dir: FileSystemDirectoryHandle): Promise<{ name: string; handle: FileSystemHandle }[]> {
  const out: { name: string; handle: FileSystemHandle }[] = [];
  for await (const [name, handle] of dir.entries()) out.push({ name, handle });
  return out;
}

/** Card operations around the Xeno Crisis tools: finding the dump beside the ROM, and giving the game a folder of its own. */
@Injectable({ providedIn: 'root' })
export class XenoPlacement {
  private readonly lib = inject(LibraryStore);
  private readonly card = inject(CardWriter);
  private readonly dialog = inject(DialogService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslocoService);

  /** A valid dump in the ROM's own folder (named like the dump, else any 16 MiB .bin), or null. */
  async findNearbyDump(dir: FileSystemDirectoryHandle): Promise<string | null> {
    try {
      const files: { name: string; size: number }[] = [];
      for (const { name, handle } of await namesIn(dir)) {
        if (handle.kind !== 'file' || name.startsWith('._')) continue;
        if (!/\.bin$/i.test(name)) continue;
        files.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size });
      }
      for (const name of pickDumpCandidates(files)) {
        if ((await probeDump(await (await dir.getFileHandle(name)).getFile())) === 'ok') return name;
      }
    } catch { /* unreadable folder: no candidate */ }
    return null;
  }

  /** Move the dump found beside the ROM to /sd2snes/xenocrisis_rp2040.bin: copy, check the copy, only then delete the source. */
  async moveDumpToCard(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
    const dest = `/${XC_DUMP_CARD_DIR}/${XC_DUMP_CARD_FILE}`;
    try {
      const target = await this.lib.cardDir(XC_DUMP_CARD_DIR, true);
      if (!target) return false;
      const srcFh = await dir.getFileHandle(name);
      if (await target.getFileHandle(XC_DUMP_CARD_FILE).then(() => true, () => false)) {
        const r = await this.dialog.confirm({
          title: this.i18n.translate('xenoPack.replaceDumpTitle'),
          body: this.i18n.translate('xenoPack.replaceDumpBody', { path: dest }),
          confirmLabel: this.i18n.translate('store.replace'),
          danger: true,
        });
        if (!r.ok) return false;
      }
      await this.card.copyFile(srcFh, target, XC_DUMP_CARD_FILE);
      const copy = await (await target.getFileHandle(XC_DUMP_CARD_FILE)).getFile();
      if ((await probeDump(copy)) !== 'ok') throw new Error('the copy does not match the dump');
      await this.card.remove(dir, name);
      this.toast.show(this.i18n.translate('xenoPack.dumpMoved', { path: dest }), 'ok');
      return true;
    } catch (err) {
      this.toast.show(this.i18n.translate('xenoPack.moveFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Other ROMs in the game's folder: the firmware only opens an MSU-1 folder as a game when it holds a single ROM. */
  async sharedWith(e: Entry): Promise<string[]> {
    if (!e.dirHandle) return [];
    const names = (await namesIn(e.dirHandle)).filter((x) => x.handle.kind === 'file' && !x.name.startsWith('._')).map((x) => x.name);
    return otherRoms(names, e.file, isRomName);
  }

  /**
   * Make sure the game's ROM is alone in its folder before the pack is written beside it. When it is not, the user
   * is asked first; on yes a folder named after the ROM is created, the ROM and the files that travel with it move
   * in, and the Recent/Favorite lists follow. Returns false when the user cancels or something fails.
   */
  async ensureOwnFolder(id: string): Promise<boolean> {
    const e = this.lib.entries().find((x) => x.id === id);
    if (!e?.dirHandle || !e.fileHandle) return true;
    const others = await this.sharedWith(e);
    if (!others.length) return true;

    const stem = stemOfName(e.file);
    const parent = e.dirHandle;
    const existing: { name: string; hasRoms: boolean }[] = [];
    for (const { name, handle } of await namesIn(parent)) {
      if (handle.kind !== 'directory') continue;
      const inner = await namesIn(handle as FileSystemDirectoryHandle).catch(() => []);
      existing.push({ name, hasRoms: inner.some((x) => x.handle.kind === 'file' && isRomName(x.name)) });
    }
    const folderName = pickFolderName(stem, existing);
    const destPath = joinPath(e.folder, folderName);
    const r = await this.dialog.confirm({
      title: this.i18n.translate('xenoPack.folderTitle'),
      body: this.i18n.translate('xenoPack.folderBody', { folder: destPath, stem, count: others.length }),
      confirmLabel: this.i18n.translate('xenoPack.folderConfirm'),
    });
    if (!r.ok) return false;

    try {
      const oldPath = '/' + joinPath(e.folder, e.file);
      const oldDir = e.dirHandle;
      const companions = companionNames(stem, (await namesIn(oldDir)).filter((x) => x.handle.kind === 'file').map((x) => x.name));
      await this.lib.moveEntries([e.id], destPath);
      const moved = this.lib.entries().find((x) => x.id === id);
      if (!moved?.dirHandle || moved.folder.toLowerCase() !== destPath.toLowerCase()) return false;
      for (const name of companions) {
        if (name.toLowerCase() === e.file.toLowerCase()) continue;
        const fh = await oldDir.getFileHandle(name).catch(() => null);
        if (!fh) continue; // the cover already travelled with the ROM
        await this.card.moveFile(oldDir, fh, moved.dirHandle, name);
      }
      await this.updateLists(oldPath, '/' + joinPath(moved.folder, moved.file));
      return true;
    } catch (err) {
      this.toast.show(this.i18n.translate('xenoPack.moveFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Point the Recent and Favorite lists at the ROM's new path. Best effort: a list the card refuses is dropped by the firmware at boot anyway. */
  private async updateLists(from: string, to: string): Promise<void> {
    const dir = await this.lib.cardDir(XC_DUMP_CARD_DIR);
    if (!dir) return;
    for (const name of ['lastgame.cfg', 'favorites.cfg']) {
      try {
        const fh = await dir.getFileHandle(name).catch(() => null);
        if (!fh) continue;
        const r = rewriteListedPaths(new Uint8Array(await (await fh.getFile()).arrayBuffer()), from, to);
        if (r.changed) await this.card.write(dir, name, r.data);
      } catch (err) {
        console.warn('[xeno-pack] could not update', name, err);
      }
    }
  }
}
