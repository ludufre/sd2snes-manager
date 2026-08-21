// Folder access via the File System Access API. Runs entirely in the browser,
// no uploads. Requires a secure context (https or http://localhost); not file://.

import { openDb } from './idb.js';
/** The recycle-bin / volume-metadata folders every walk here must step over. Imported rather than
 *  re-listed: `System Volume Information` was being descended into and listed as a library folder,
 *  and a second copy of the list would only drift from the sweep's. (PATCH_EXTS below is duplicated
 *  because it mirrors a rule in the firmware; this one has a single owner.) */
import { isJunkDir } from '../core/sd-layout';

export const ROM_EXTS = ['sfc', 'smc', 'bs', 'gb', 'gbc', 'sgb', 'nes', 'sms', 'a26', 'st'];
/** Menu-theme files (sd2snes+ firmware): a `.thm` (or `.skin`) in any visible card folder. */
export const THEME_EXTS = ['thm', 'skin'];
/** ROM patches the firmware applies at boot, they live next to the ROM they patch. Collected on
 *  the way past (the walk is already reading every entry) because the migration renames the ones
 *  firmware 2.15+ refuses to offer; see planPatchRenames in core/sd-migration.service.ts.
 *  Must agree with PATCH_EXTS in core/sd-layout.ts, which carries the firmware's own rule. */
export const PATCH_EXTS = ['ips', 'bps'];

const SYSTEM_BY_EXT = { sfc: 'SNES', smc: 'SNES', bs: 'BSX', gb: 'GB', gbc: 'GBC', sgb: 'SGB', nes: 'NES', sms: 'SMS', a26: 'A26', st: 'ST' };

export function fsAccessSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
export function systemOf(name) {
  return SYSTEM_BY_EXT[extOf(name)] || null;
}
function isRom(name) {
  return ROM_EXTS.includes(extOf(name));
}
function isTheme(name) {
  return THEME_EXTS.includes(extOf(name));
}
function isPatch(name) {
  return PATCH_EXTS.includes(extOf(name));
}

/**
 * Index key for a cover sitting next to its ROM (`<folder>/<stem>`, both lowercased).
 *
 * Exported because both sides must agree byte-for-byte: `scanTree` fills the set from the `.cov`
 * files it walks past, and the status probe looks a ROM up in it (core/library-store's
 * probeOnCard). Lowercased because it replaces `fileExists(dirHandle, stem + '.cov')` on a FAT
 * card, where a lookup is case-insensitive. Folding is what keeps the two answers identical.
 * The card root has folder '' and therefore keys as '/<stem>'; harmless, since '' is not a name
 * any real folder can have, so it cannot collide.
 */
export function covKey(folder, stem) {
  return `${folder}/${stem}`.toLowerCase();
}

/** Prompt for a directory (must be called from a user gesture). Returns the handle, or
 *  null if the user cancelled. Throws on real errors (e.g. blocked context). */
export async function pickDirectory() {
  try {
    return await window.showDirectoryPicker({ id: 'sd2snes-card', mode: 'readwrite' });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Ensure read/write permission on a handle, re-requesting if needed (after a
 *  fresh pick or when site data was cleared). Returns true if granted. */
export async function ensureRwPermission(handle) {
  const opts = { mode: 'readwrite' };
  try {
    if (typeof handle.queryPermission === 'function' && (await handle.queryPermission(opts)) === 'granted') {
      return true;
    }
    if (typeof handle.requestPermission === 'function') {
      return (await handle.requestPermission(opts)) === 'granted';
    }
  } catch {
    return true; // permission API unavailable → assume the picker granted it
  }
  return true;
}

/** Query (without prompting) whether we still hold read/write on a handle, for deciding, on load,
 *  whether to auto-reconnect (granted) or show a 1-click "reconnect" button (prompt). */
export async function hasRwPermission(handle) {
  try {
    if (typeof handle?.queryPermission !== 'function') return true; // no permission API → assume usable
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/* ---- persist the picked card handle (IndexedDB) so a reload can reconnect without re-picking ----
 * FileSystemDirectoryHandle is structured-cloneable, so it stores/reads back verbatim; the browser
 * still gates access by permission (re-granted via a user gesture when needed). */
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'card';
/** Shared opener (lib/idb.js), the CRC cache lives in the same database, so neither may open it
 *  at its own version. */
const handleDb = openDb;
/* The record is either a bare handle (written by versions before the firmware question existed) or
 * `{ handle, fwAssume }`. `readRecord` normalizes both; everything below works on the object. */
async function readRecord() {
  try {
    const db = await handleDb();
    const rec = await new Promise((res, rej) => {
      const rq = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(HANDLE_KEY);
      rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error);
    });
    db.close();
    if (!rec) return null;
    return rec.handle ? rec : { handle: rec, fwAssume: null };
  } catch { return null; }
}
async function writeRecord(rec) {
  try {
    const db = await handleDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(rec, HANDLE_KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch { /* best-effort: reconnect-on-reload just won't be available */ }
}
/** Same folder? Null-safe and never throws (isSameEntry is missing on some older implementations). */
async function isSameCard(a, b) {
  try { return typeof a?.isSameEntry === 'function' && b ? await a.isSameEntry(b) : false; } catch { return false; }
}

/**
 * Remember this card, plus the layout the user said its firmware reads (see `loadCardFwAssume`).
 * Pass `fwAssume` to record an answer; pass null/undefined to keep whatever is already stored,
 * but only when it is the same card. Pointing the Manager at a different folder must never inherit
 * the previous one's assumed firmware.
 */
export async function saveCardHandle(handle, fwAssume) {
  const prev = await readRecord();
  const kept = (await isSameCard(prev?.handle, handle)) ? (prev.fwAssume ?? null) : null;
  await writeRecord({ handle, fwAssume: fwAssume ?? kept });
}
export async function loadCardHandle() {
  return (await readRecord())?.handle ?? null;
}
/** The layout the user said this card's firmware reads, when the version could not be read off it.
 *  Scoped to the remembered card. A different folder gets null and is asked again. */
export async function loadCardFwAssume(handle) {
  const rec = await readRecord();
  if (!rec?.fwAssume) return null;
  return (await isSameCard(rec.handle, handle)) ? rec.fwAssume : null;
}
export async function clearCardHandle() {
  try {
    const db = await handleDb();
    await new Promise((res) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
      tx.oncomplete = res; tx.onerror = res;
    });
    db.close();
  } catch { /* ignore */ }
}

/** Recursively walk a directory handle, returning `{ roms, dirs, themes, patches, covStems }`:
 *  - `roms`: { name, path, folder, system, fileHandle, dirHandle } per ROM
 *    (`dirHandle` is the ROM's parent dir, used to find the `<stem>.cov` sibling).
 *  - `dirs`: every directory's relative path (so empty folders are representable
 *    in the tree, not just ROM-bearing ones). Skips dotfiles + the `sd2snes` dir.
 *  - `patches`: { name, folder } per `.ips`/`.bps`, name + folder only, since the
 *    migration matches them against ROM names and never reads their bytes.
 *  - `covStems`: `covKey(folder, stem)` of every `.cov` seen. Free: the walk already reads every
 *    entry of every ROM folder and throws the non-ROMs away, so collecting the covers on the way
 *    past costs one Set insert, and saves the status probe one `getFileHandle` miss (an exception)
 *    per game. */
export async function scanTree(dirHandle, { onProgress } = {}) {
  const roms = [];
  const dirs = [];
  const themes = [];
  const patches = [];
  const covStems = new Set();
  async function walk(handle, prefix) {
    for await (const [name, child] of handle.entries()) {
      if (name.startsWith('.')) continue; // skip dotfiles & the hidden /sd2snes system dir
      if (child.kind === 'directory') {
        if (name.toLowerCase() === 'sd2snes') continue; // firmware/system folder
        // Recycle bins / volume metadata are not library folders. The dotted ones (.Trashes,
        // .fseventsd) already fell out above; this catches `System Volume Information`,
        // `$RECYCLE.BIN` and `RECYCLER`, which were being walked and offered as folders to file
        // ROMs into, and whose contents Windows will not let us read anyway.
        if (isJunkDir(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        dirs.push(path);
        // skip an unreadable subtree rather than aborting the whole scan
        try { await walk(child, path); } catch { /* skip */ }
      } else if (isRom(name)) {
        roms.push({ name, path: prefix, folder: prefix, system: systemOf(name), fileHandle: child, dirHandle: handle });
        onProgress?.(roms.length);
      } else if (isTheme(name)) {
        themes.push({ name, folder: prefix, path: prefix ? `${prefix}/${name}` : name, fileHandle: child, dirHandle: handle });
      } else if (isPatch(name)) {
        patches.push({ name, folder: prefix });
      } else if (extOf(name) === 'cov') {
        covStems.add(covKey(prefix, name.slice(0, name.lastIndexOf('.'))));
      }
    }
  }
  await walk(dirHandle, '');
  roms.sort((a, b) => (a.folder + '/' + a.name).localeCompare(b.folder + '/' + b.name));
  themes.sort((a, b) => a.path.localeCompare(b.path));
  return { roms, dirs, themes, patches, covStems };
}

/** Backward-compatible: just the ROM list. */
export async function scanRoms(dirHandle, opts) {
  return (await scanTree(dirHandle, opts)).roms;
}

/** Sum the byte size of every file under a directory (recursive, including /sd2snes/ where the big
 *  .fmv/.pcm live), the card's used space. Background use; unreadable subtrees are skipped. */
export async function walkUsage(dirHandle) {
  let total = 0;
  async function walk(handle) {
    const subdirs = [];
    for await (const [name, child] of handle.entries()) {
      if (name.startsWith('.')) continue;
      // Same skip as scanTree: a recycle bin is not the card's used space, and reading inside
      // `System Volume Information` fails on Windows regardless.
      if (child.kind === 'directory') { if (!isJunkDir(name)) subdirs.push(child); }
      else { try { total += (await child.getFile()).size; } catch { /* skip unreadable */ } }
    }
    for (const d of subdirs) { try { await walk(d); } catch { /* skip */ } }
  }
  await walk(dirHandle);
  return total;
}

/** Resolve a nested directory handle by "/"-separated path (e.g. "sd2snes/cheats").
 *  Returns null if any segment is missing. Read-only, never creates. */
export async function getDirByPath(rootHandle, path) {
  let dir = rootHandle;
  for (const seg of path.split('/')) {
    if (!seg) continue;
    try {
      dir = await dir.getDirectoryHandle(seg);
    } catch {
      return null;
    }
  }
  return dir;
}

/** True if a file with `name` exists directly in `dirHandle` (null-safe). */
export async function fileExists(dirHandle, name) {
  if (!dirHandle) return false;
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** True if a subdirectory `name` exists directly in `dirHandle` (null-safe). */
export async function dirExists(dirHandle, name) {
  if (!dirHandle) return false;
  try {
    await dirHandle.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Read a named file in `dirHandle` as a Uint8Array, or null if absent. */
export async function readFileFrom(dirHandle, name) {
  if (!dirHandle) return null;
  try {
    const fh = await dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/** Read a named file in `dirHandle` as text, or null if absent. */
export async function readTextFile(dirHandle, name) {
  if (!dirHandle) return null;
  try {
    const fh = await dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

/** Prompt the user for a local image file (for "Use my image..."). Returns the
 *  File, or null if cancelled. Uses showOpenFilePicker, falling back to <input>. */
export async function pickImageFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'] } }],
      });
      return await h.getFile();
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
  }
  return await new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.click();
  });
}

/** Prompt the user for a local PDF file (for the Guides editor's "Add PDF..."). Returns the File, or
 *  null if cancelled. */
export async function pickPdfFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      return await h.getFile();
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
  }
  return await new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/pdf,.pdf';
    inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.click();
  });
}

/** Prompt for multiple local page images (Guides editor's "Add page images...", one file per page).
 *  Returns them in the order the picker/input reports (both showOpenFilePicker and <input
 *  multiple> preserve the user's selection order on every browser tested), the caller relies on
 *  this to mean "reading order, page 1 first" (see man.js renderImagePages). Returns [] if
 *  cancelled/empty. */
export async function pickImageFiles() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'] } }],
      });
      return await Promise.all(handles.map((h) => h.getFile()));
    } catch (err) {
      if (err && err.name === 'AbortError') return [];
      throw err;
    }
  }
  return await new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.onchange = () => resolve(inp.files ? Array.from(inp.files) : []);
    inp.click();
  });
}

/** Read just the first `n` bytes of a named file in `dirHandle` (cheap header probe. A `.man`
 *  guide can be tens of MB; listing guides shouldn't read the whole thing). null if absent. */
export async function readFileHeader(dirHandle, name, n) {
  if (!dirHandle) return null;
  try {
    const fh = await dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    return new Uint8Array(await file.slice(0, n).arrayBuffer());
  } catch {
    return null;
  }
}

/** Prompt for a local video file (for "Use my video..."). Returns the File or null. */
export async function pickVideoFile() {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Videos', accept: { 'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ogg'] } }],
      });
      return await h.getFile();
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
  }
  return await new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'video/*';
    inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.click();
  });
}

/** Size in bytes without reading the whole file. */
export async function sizeOf(fileHandle) {
  const file = await fileHandle.getFile();
  return file.size;
}
