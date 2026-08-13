import { Injectable } from '@angular/core';

/** FileSystemFileHandle.move() is experimental/non-standard (Chromium) and not in
 *  lib.dom. Type it optionally so we can capability-detect + fall back. */
type Movable = FileSystemFileHandle & {
  move?: (dirOrName: FileSystemDirectoryHandle | string, name?: string) => Promise<void>;
};

/**
 * Writes/deletes/moves files on the card via the File System Access API. The
 * picker was opened in 'readwrite' mode, so these need no extra permission
 * prompt. Overwrite is implicit, createWritable truncates an existing file.
 */
@Injectable({ providedIn: 'root' })
export class CardWriter {
  /** Two bounded-concurrency gates, chosen by payload size. Measured on a real (slow) SD card:
   *   - small files (.cov/.gcv/.gss/.yml, ≤~30KB): the cost is almost all `close()` (~430ms, the atomic
   *     flush+rename) which is latency-bound → running several at once overlaps the waits (~5× faster
   *     than strict serial, which gave ~0.1 games/s).
   *   - large files (.fmv/.pcm, hundreds of KB to MBs): bandwidth-bound, and SD cards thrash on concurrent
   *     large/random writes (close ballooned 430ms→5000ms+ at 6-way concurrency) → keep these nearly
   *     serial so they don't fight for the card's bandwidth.
   *  (The NoModificationAllowedError that once motivated strict serialization came from the card going
   *   read-only/full mid-run, not concurrency (phase 1 was already sequential then) so this is safe;
   *   withRetry + the unwritable latch still cover transient/terminal errors.) */
  private static readonly MAX_SMALL = 6;
  private static readonly MAX_LARGE = 2;
  private static readonly LARGE_BYTES = 128 * 1024;
  private readonly semSmall = CardWriter.makeSem(CardWriter.MAX_SMALL);
  private readonly semLarge = CardWriter.makeSem(CardWriter.MAX_LARGE);
  /** Build a counting semaphore: `sem(fn)` runs fn with at most `max` concurrent. */
  private static makeSem(max: number) {
    let permits = max;
    const waiters: Array<() => void> = [];
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      if (permits > 0) permits--;
      else await new Promise<void>((res) => waiters.push(res)); // woken == a permit was handed to us
      try {
        return await fn();
      } finally {
        const next = waiters.shift();
        if (next) next(); // pass our permit straight to the next waiter
        else permits++; // no waiter → return the permit to the pool
      }
    };
  }
  /** Run a card mutation under the small gate (metadata + small files). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    return this.semSmall(fn);
  }

  /** Consecutive write failures that look like the card itself is unwritable, full, write-protected,
   *  or (common on macOS + exFAT/SD under sustained writes) the OS remounted the volume read-only
   *  after an I/O error. Retrying can't fix any of those, so after a streak we latch `unwritable` and
   *  fail fast. A bulk run then stops with a clear message instead of grinding through hundreds more
   *  doomed writes (the "trava perto do final" symptom). */
  private fatalStreak = 0;
  private _unwritable = false;
  private static readonly ABORT_AFTER = 4;
  get unwritable(): boolean { return this._unwritable; }
  /** The real underlying error (name + message) behind the last persistent failure, so the UI can say
   *  What went wrong (NoModification / Quota / InvalidState / ...) instead of a generic "unwritable". */
  lastError = '';
  /** Clear write-health at the start of a new bulk run (or after the user re-seats the card). */
  resetWriteHealth(): void { this.fatalStreak = 0; this._unwritable = false; this.lastError = ''; }

  /** Retry a filesystem op a few times on transient errors (a momentary write/lock contention on
   *  removable media throws NoModificationAllowedError/InvalidStateError but clears on a quick retry).
   *  Hard errors (NotFound/permission) rethrow immediately. A persistent failure (retries exhausted,
   *  or QuotaExceeded=full) grows the unwritable streak and, past the threshold, throws a tagged
   *  `CardUnwritableError` so the caller can stop the whole run. */
  private async withRetry<T>(fn: () => Promise<T>, isolated = false): Promise<T> {
    if (this._unwritable) throw new DOMException('card is unwritable', 'CardUnwritableError'); // fail fast once latched
    let lastErr: unknown;
    const maxAttempts = isolated ? 2 : 5; // an isolated write into a read-only folder won't clear on retry
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await fn();
        // Only a non-isolated success clears the streak. An isolated op is one whose failure is local
        // and meaningless card-wide (a `.cov` into a read-only ROM folder, a junk `._x`, a swept guide
        // slot), and by the same token its success proves nothing card-wide either. Letting it reset
        // the counter weakens the unwritable latch exactly when a bulk run is interleaving isolated ops
        // with real writes, which is what the guide sweep now does on every affected game.
        if (!isolated) this.fatalStreak = 0;
        return r;
      } catch (e) {
        lastErr = e;
        const name = (e as { name?: string })?.name;
        if (name === 'QuotaExceededError') break; // disk full → fatal now, don't retry
        if (name !== 'NoModificationAllowedError' && name !== 'InvalidStateError') throw e;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); // 150/300/450/600ms backoff
      }
    }
    // Isolated write (the .cov that lands next to the ROM, in an arbitrary user folder that may be
    // read-only, e.g. a hack set extracted with dr-xr-xr-x dirs): a persistent failure there is local.
    // Never let it grow the card-wide streak or latch the whole run, bubble raw so write() returns false
    // and the caller records it in the fill report and moves on.
    if (isolated) throw lastErr;
    // Retries exhausted (or quota): a persistent failure, grow the streak; latch + abort past the cap.
    this.fatalStreak++;
    { const le = lastErr as { name?: string; message?: string } | undefined;
      this.lastError = `${le?.name || 'Error'}: ${(le?.message || '').slice(0, 200)}`; }
    if (this.fatalStreak >= CardWriter.ABORT_AFTER) {
      this._unwritable = true;
      throw new DOMException(
        'card appears unwritable (full, write-protected, or remounted read-only)',
        'CardUnwritableError',
      );
    }
    throw lastErr;
  }

  /** Running total of bytes written this session (for the auto-fill time-estimate calibration). */
  writtenBytes = 0;

  /** Write data to `name` in `dir` (created if absent). Concurrency-gated by size (large → near-serial
   *  to avoid SD thrashing on big .fmv/.pcm; small → overlap freely) + retried. */
  async write(
    dir: FileSystemDirectoryHandle,
    name: string,
    data: Uint8Array | string,
    opts?: { isolated?: boolean },
  ): Promise<boolean> {
    const bytes = typeof data === 'string' ? data.length : data.byteLength;
    const gate = bytes >= CardWriter.LARGE_BYTES ? this.semLarge : this.semSmall;
    try {
      await gate(() => this.withRetry(async () => {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        // Cast: TS 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>, which doesn't
        // narrow to BufferSource<ArrayBuffer>; the value is a valid write chunk.
        await w.write(data as FileSystemWriteChunkType);
        await w.close();
        this.writtenBytes += bytes; // count only fully-written files
      }, opts?.isolated));
      return true;
    } catch (e) {
      // Isolated write into a read-only folder → skip (caller records it), don't propagate as fatal.
      if (opts?.isolated && (e as { name?: string })?.name === 'NoModificationAllowedError') return false;
      throw e;
    }
  }

  /** Remove `name` from `dir` (no-op-safe: caller catches).
   *
   *  `isolated` marks a removal whose failure is local and inconsequential, the junk sweeps, which
   *  delete `._x`/`.crswap` leftovers out in arbitrary user folders that may well be read-only. Those
   *  must never grow the card-wide streak or latch `unwritable`: a `._` we cannot delete is cosmetic,
   *  and latching over it would abort the very run that is otherwise succeeding (see withRetry). */
  async remove(dir: FileSystemDirectoryHandle, name: string, opts?: { isolated?: boolean }): Promise<void> {
    return this.serialize(() => this.withRetry(() => dir.removeEntry(name), opts?.isolated));
  }

  /** Resolve (creating as needed) a nested directory under `root`. Serialized + retried so concurrent
   *  callers don't race on creating the same bucket dir. */
  async ensureDir(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
    return this.serialize(() => this.withRetry(async () => {
      let d = root;
      for (const seg of path.split('/')) {
        if (seg) d = await d.getDirectoryHandle(seg, { create: true });
      }
      return d;
    }));
  }

  /** Move a file into `destDir` (optionally renamed). Uses the native move()
   *  (instant, no byte copy) when available, else copy+delete. Returns the new
   *  handle. `srcDir` is the file's current parent (for the fallback delete). */
  async moveFile(
    srcDir: FileSystemDirectoryHandle,
    fileHandle: FileSystemFileHandle,
    destDir: FileSystemDirectoryHandle,
    newName?: string,
  ): Promise<FileSystemFileHandle> {
    return this.serialize(() => this.withRetry(async () => {
      const oldName = fileHandle.name;
      const name = newName ?? oldName;
      const mv = fileHandle as Movable;
      if (typeof mv.move === 'function') {
        try {
          await mv.move(destDir, name);
          return await destDir.getFileHandle(name);
        } catch {
          /* fall through to copy + delete */
        }
      }
      const file = await fileHandle.getFile();
      const fh = await destDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(file);
      await w.close();
      await srcDir.removeEntry(oldName);
      return fh;
    }));
  }

  /** Rename a file in place (move within the same directory). */
  async renameFile(
    srcDir: FileSystemDirectoryHandle,
    fileHandle: FileSystemFileHandle,
    newName: string,
  ): Promise<FileSystemFileHandle> {
    return this.moveFile(srcDir, fileHandle, srcDir, newName);
  }

  /** Create (or get) a subdirectory `name` in `parentDir`. */
  async createFolder(parentDir: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
    return this.serialize(() => this.withRetry(() => parentDir.getDirectoryHandle(name, { create: true })));
  }

  /** Recursively delete the subdirectory `name` (and everything in it).
   *  `isolated`: see remove(). The Organizer's optional system-folder cleanup uses it, Chromium
   *  routinely refuses `System Volume Information` outright, and that refusal must not read as
   *  "this card stopped accepting writes". */
  async removeFolder(parentDir: FileSystemDirectoryHandle, name: string, opts?: { isolated?: boolean }): Promise<void> {
    return this.serialize(() => this.withRetry(() => parentDir.removeEntry(name, { recursive: true }), opts?.isolated));
  }

  /** Copy a file into `destDir` under `name` (no native copy, stream the Blob). */
  async copyFile(
    srcFileHandle: FileSystemFileHandle,
    destDir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemFileHandle> {
    return this.serialize(() => this.withRetry(async () => {
      const file = await srcFileHandle.getFile();
      const fh = await destDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(file);
      await w.close();
      return fh;
    }));
  }

  /** Recursively move `srcDir`'s contents into a new `name` folder under
   *  `destParentDir`, removing emptied source subdirectories as it goes. The
   *  caller removes the now-empty top-level source dir. Returns the dest handle. */
  async moveFolderRecursive(
    srcDir: FileSystemDirectoryHandle,
    destParentDir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<FileSystemDirectoryHandle> {
    const dst = await destParentDir.getDirectoryHandle(name, { create: true });
    // Snapshot entries first. Moving files mutates srcDir, which would disturb a
    // live entries() iteration.
    const files: [string, FileSystemFileHandle][] = [];
    const subdirs: [string, FileSystemDirectoryHandle][] = [];
    for await (const [childName, child] of srcDir.entries()) {
      if (child.kind === 'file') files.push([childName, child as FileSystemFileHandle]);
      else subdirs.push([childName, child as FileSystemDirectoryHandle]);
    }
    for (const [n, fh] of files) await this.moveFile(srcDir, fh, dst, n);
    for (const [n, sub] of subdirs) {
      await this.moveFolderRecursive(sub, dst, n);
      try { await srcDir.removeEntry(n, { recursive: true }); } catch { /* */ }
    }
    return dst;
  }
}
