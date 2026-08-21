import { Injectable } from '@angular/core';
import { CardWriter } from './card-writer.service';
import {
  BUCKETED_ROOTS, SD_ROOT, BUCKET_LEN, PATCH_BASENAME_MAX, PATCH_PATH_MAX, PATCH_EXTS,
  bucketDirFor, ambiguousDirFor, bucketKeyForFile, isJunkFile, isJunkDir, nsOf, romStem, classifyRootChild,
  AssetNs, SGB_SEG, SFT_SEG,
  patchExtOf, patchStemOf, patchBelongsToRom, patchShadowsRom, patchRenameFor, type LayoutMode,
} from './sd-layout';

/**
 * Migrating a card to the two-letter bucket layout (firmware 2.15+), and sweeping the macOS
 * AppleDouble droppings that double every directory scan the firmware does.
 *
 * Safety is the whole point here. Saves are irreplaceable, so:
 *   - every file moves with CardWriter.moveFile(), whose native path is a metadata rename and
 *     whose fallback only deletes the source after the destination write closed. The failure
 *     window leaves a file in both places, never in neither;
 *   - a destination that already exists is reported as a conflict and skipped, never overwritten;
 *   - roots run in order of how replaceable they are (info -> cheats -> states -> saves), so if
 *     something is wrong it surfaces on regenerable data first;
 *   - there is no "already migrated" flag. The plan is re-derived from the filesystem every time,
 *     which makes the whole thing idempotent, safe to re-run, and correct even if someone
 *     reorganised the card by hand. A flag would start lying the moment that happened.
 */

/**
 * Which namespace a stem belongs to, decided by the ROMs actually on the card.
 *
 * A file already sitting on the card carries no evidence of its origin: .srm/.yml/.state/.gtc are
 * all system-agnostic container extensions, so "Tetris.srm" cannot say whether it came from
 * Tetris.gb or Tetris.sfc. The only source of truth is the scanned ROM library.
 */
export type StemClass = AssetNs | 'both';
export type RomIndex = ReadonlyMap<string, StemClass>;

/** Build the stem -> namespace map from the scanned ROM filenames. Keys are lowercased: FAT long
 *  names are case-insensitive, so TETRIS.srm must match Tetris.gb. */
export function buildRomIndex(romFilenames: Iterable<string>): Map<string, StemClass> {
  const out = new Map<string, StemClass>();
  for (const f of romFilenames) {
    const k = romStem(f).toLowerCase();
    const c: StemClass = nsOf(f);      // '' | 'sgb' | 'sft'
    const prev = out.get(k);
    out.set(k, prev === undefined || prev === c ? c : 'both');
  }
  return out;
}

/**
 * A file whose stem matches ROMs in two different namespaces (a .gb and a .sfc, or a .st and a
 * .sfc) -- the exact collision the namespaces exist to prevent, seen from the other side. We
 * cannot know which game the file belongs to, and guessing wrong hands one game's save to the
 * other, so it is left untouched and
 * reported. Distinct from `skipped` ("did not recognise this") and `conflicts` ("destination taken").
 */
export interface AmbiguousFile {
  root: string;
  path: string;
  name: string;
  stem: string;
}

export interface PlannedMove {
  root: string;
  /** directory path holding the file today, relative to the card root */
  fromPath: string;
  /** directory path it must end up in */
  toPath: string;
  name: string;
  size: number;
}

/** A file somewhere in the ROM tree, as the card scan found it. `folder` is the parent directory
 *  relative to the card root, '' for the root itself, the same shape scanTree reports. */
export interface ScannedName {
  folder: string;
  name: string;
}

/** A file renamed in place, never moved between directories. The only kind today is a stranded
 *  IPS/BPS patch; see planPatchRenames. */
export interface PlannedRename {
  /** directory holding the file, relative to the card root ('' = card root) */
  path: string;
  name: string;
  to: string;
}

/**
 * Rescue the IPS/BPS patches the firmware refuses to look at.
 *
 * Firmware 2.15+ skips a patch whose stem is exactly its ROM's (see patchShadowsRom): it cannot
 * tell a hand-made `Foo.sfc` + `Foo.ips` pair from the leftovers of "Create patched ROM", and
 * re-applying an IPS over an already-patched image corrupts it. So `Foo.ips` became dead weight,
 * and _repo/src/patch.c states outright that this migration is what brings it back:
 * it is renamed to `Foo - Patch 1.ips`, which the firmware then offers as "Patch 1".
 *
 * "Shares a ROM's stem" is not a safe enough condition on its own, and renaming on it alone would
 * corrupt saves instead of rescuing patches. What "Create patched ROM" leaves behind:
 *
 *     Zelda.sfc            the original
 *     Zelda - PT-BR.ips    the patch
 *     Zelda - PT-BR.sfc    the patched copy it wrote
 *
 * That .ips shares the patched copy's stem, so it looks like the case above, but renaming it to
 * `Zelda - PT-BR - Patch 1.ips` would make it visible on the already-patched copy, which is the
 * double-apply the firmware skips it to prevent.
 *
 * The tell: such a patch is still reachable from another ROM in the same directory (it is the patch
 * of `Zelda.sfc`, and the firmware offers it there), while a genuinely stranded patch is reachable
 * from nothing. So rename only what no ROM in the folder can still see.
 *
 * Pure and ignorant of the filesystem: it works off the card scan the library already did, which is
 * also what lets it be tested exhaustively without a fake FS.
 */
export function planPatchRenames(roms: readonly ScannedName[], patches: readonly ScannedName[]): PlannedRename[] {
  const romsByFolder = new Map<string, string[]>();
  for (const r of roms) {
    const list = romsByFolder.get(r.folder);
    if (list) list.push(r.name); else romsByFolder.set(r.folder, [r.name]);
  }

  const out: PlannedRename[] = [];
  const byFolder = new Map<string, ScannedName[]>();
  for (const p of patches) {
    const list = byFolder.get(p.folder);
    if (list) list.push(p); else byFolder.set(p.folder, [p]);
  }

  for (const [folder, inFolder] of byFolder) {
    const romNames = romsByFolder.get(folder);
    if (!romNames?.length) continue;                       // no ROM here -> nothing was ever offered
    /* Every name we know is spoken for in this folder, lowercased because FAT is case-insensitive.
       The scan only reports ROMs and patches, so this cannot see a stray .txt -- execute() checks
       the destination for real before renaming and reports a taken one as a conflict, exactly as
       it does for moves. */
    const taken = new Set([...romNames, ...inFolder.map((p) => p.name)].map((n) => n.toLowerCase()));

    for (const p of [...inFolder].sort((a, b) => a.name.localeCompare(b.name))) {
      const ext = patchExtOf(p.name);
      if (!ext) continue;
      if (!romNames.some((r) => patchShadowsRom(p.name, r))) continue;   // not stranded
      if (romNames.some((r) => patchBelongsToRom(p.name, r))) continue;  // still reachable -- see above

      const stem = patchStemOf(p.name);
      let to = '';
      for (let n = 1; n <= inFolder.length + 1; n++) {
        /* A number is free only when neither spelling of it is taken. The firmware's patch screen
           shows the suffix without the extension, so `Foo.ips` and `Foo.bps` both landing on
           "Patch 1" would put two identically-labelled rows on screen. */
        if (PATCH_EXTS.some((e) => taken.has(patchRenameFor(stem, e, n).toLowerCase()))) continue;
        const cand = patchRenameFor(stem, ext, n);
        /* ...and the new name must not land in another ROM's shadow. A card holding both
           `Zelda.sfc` and a `Zelda - Patch 1.sfc` would otherwise get a `Zelda - Patch 1.ips` that
           is invisible all over again -- a rename that changed the filename and nothing else. */
        if (romNames.some((r) => patchShadowsRom(cand, r))) continue;
        to = cand;
        break;
      }
      /* A name the firmware's own scan would drop is not a rescue. Leaving it alone keeps the file
         exactly as it is -- already invisible, but at least still named after its ROM. */
      if (!to || to.length >= PATCH_BASENAME_MAX || folder.length + 1 + to.length >= PATCH_PATH_MAX) continue;

      taken.add(to.toLowerCase());
      out.push({ path: folder, name: p.name, to });
    }
  }
  return out;
}

/**
 * Is this file junk we may delete, given where on the card it sits?
 *
 * `isJunkFile` answers "is this a system leftover"; this adds the one place where the answer is yes
 * but the deletion would be wrong.
 *
 * Desktop.ini in the volume root
 * In a subfolder, `desktop.ini` is Explorer's own per-folder view state: nothing the user chose,
 * regenerated at will, junk like the rest. In the root of a removable volume it is something else
 * entirely. It is how Windows gives the card its own icon and label in Explorer
 * (`[.ShellClassInfo]` IconResource / LocalizedResourceName). A user who named their card did that
 * by hand, and a sweep that silently threw it away would be deleting their work, not their litter.
 * So it is spared at the root and swept everywhere else.
 *
 * Pure and position-aware rather than folded into isJunkFile, because isJunkFile is also the
 * Indexer's rule ("skip this entry"), where skipping a root desktop.ini is still correct.
 */
export function isSweepableJunk(name: string, atVolumeRoot: boolean): boolean {
  if (atVolumeRoot && name.toLowerCase() === 'desktop.ini') return false;
  return isJunkFile(name);
}

/** How deep each junk walk goes. /sd2snes is a layout we own, so 5 covers it exactly
 *  (`/sd2snes/<root>/sgb/<bucket>/` is depth 4). The ROM tree is the user's, so it gets a looser
 *  cap, deep enough for any real collection, bounded so a symlink loop or a pathological tree
 *  cannot turn the scan into a hang. */
const SD_JUNK_DEPTH = 5;
const CARD_JUNK_DEPTH = 8;

/**
 * Refusals in one directory after which the sweep stops asking about that directory.
 *
 * Per folder, never card-wide. A read-only folder (the chmod-555 hack set) refuses every `._` in
 * it, and each refusal costs a retry pass, but it says nothing whatsoever about the next folder.
 * A global streak would have let one such folder silently truncate the sweep for the whole rest of
 * the card, and a re-run would stall on exactly the same folder again. The removals are isolated
 * and cannot latch anything, so this cap only ever buys time; correctness never depends on it.
 */
export const JUNK_GIVE_UP_STREAK = 8;

export interface MigrationPlan {
  moves: PlannedMove[];
  /** stranded IPS/BPS patches to rename in place, next to their ROM, see planPatchRenames */
  renames: PlannedRename[];
  /** files whose destination name is already taken, skipped, never overwritten */
  conflicts: PlannedMove[];
  /** entries deliberately left alone (unexpected directories, etc.) */
  skipped: string[];
  /** stems that exist as both a Game Boy and a SNES game, never guessed at */
  ambiguous: AmbiguousFile[];
  /** Files to delete. No size: nothing displays it, and reading it cost one getFile() per junk file
   *  across the whole card on every connect (probeMigration plans on each one). */
  junk: { path: string; name: string }[];
  /**
   * Recycle bins and volume metadata sitting in the card's root (`System Volume Information`,
   * `$RECYCLE.BIN`, `.Trashes`, ...). Names only, since they are removed whole.
   *
   * Offered, never done by default: `$RECYCLE.BIN` can hold files the user still believes they
   * have, and this is the only part of the Organizer that destroys data the user might want back.
   * execute() touches them only when explicitly asked (see MigrationOptions).
   */
  systemDirs: string[];
  /** Emptied holder directories (chiefly one-character legacy buckets) that execute() will remove.
   *  Counted so a card whose only remaining problem is dead folders still offers a run instead of
   *  reporting "nothing to do" and leaving them there forever. */
  emptyDirs: number;
  byRoot: Record<string, { files: number; bytes: number }>;
  totalBytes: number;
  /**
   * The layout the card is already in, by majority of files seen. null when there are no per-game
   * files at all. Used only as a fallback for deciding where to write when the card's firmware
   * version cannot be read. An organized card should stay organized, a legacy one readable.
   */
  observed: LayoutMode | null;
}

/**
 * Progress is reported per stage, not per file.
 *
 * The bar still advances per file (so it moves smoothly on a big card), but the label names the
 * stage. Showing each filename made the label flicker unreadably. Moves are metadata renames and
 * hundreds go by per second, so the text was never on screen long enough to read.
 */
export type MigrationStage = 'junk' | 'patches' | 'info' | 'cheats' | 'states' | 'saves' | 'sysdirs';

export interface MigrationProgress {
  done: number;
  total: number;
  stage: MigrationStage;
  /** 1-based position of this stage among the ones this run will actually perform. */
  stageIndex: number;
  stageCount: number;
}

export interface MigrationResult {
  moved: number;
  /** stranded IPS/BPS patches renamed back into view */
  renamed: number;
  junkRemoved: number;
  /** Junk files the card refused to delete (a read-only folder, almost always). Local and harmless
   * (the run carries on) but reported rather than swallowed, so a user who wonders why the count
   *  is short has an answer. */
  junkFailed: number;
  failed: { name: string; error: string }[];
  conflicts: number;
  aborted: boolean;
  /** The card stopped accepting writes mid-run (full, write-protected, or remounted read-only).
   *  Distinct from `aborted` (the user cancelled) and from a handful of `failed` entries: it means
   *  everything after the latch was refused, so the run is incomplete by a lot. */
  unwritable: boolean;
  /** Emptied legacy bucket directories removed afterwards. */
  prunedDirs: number;
  /** Root system folders actually deleted (only ever non-zero when the user opted in). */
  sysDirsRemoved: number;
  /** ...and how many the browser refused. Reported, never fatal, see the removal loop. */
  sysDirsFailed: number;
}

/** The one thing about a run the plan cannot decide, because it is the user's call. */
export interface MigrationOptions {
  /** Delete the root recycle bins / volume metadata listed in `plan.systemDirs`. Default off. */
  removeSystemDirs?: boolean;
}

const EMPTY_PLAN = (): MigrationPlan => ({
  moves: [], renames: [], conflicts: [], skipped: [], ambiguous: [], junk: [], systemDirs: [],
  emptyDirs: 0, byRoot: {}, totalBytes: 0, observed: null,
});

@Injectable({ providedIn: 'root' })
export class SdMigrationService {
  /* Constructor injection rather than inject(): plan()/scanJunk() are pure reads that never touch
     the writer, so a test can build this with a stub and exercise the risky planning logic
     without an Angular injection context. */
  constructor(private card: CardWriter) {}

  /** Native move() is a metadata rename; without it every file is copied byte-for-byte, which is
   *  slow on multi-MB .fmv clips. Worth telling the user before they start. */
  get hasNativeMove(): boolean {
    return typeof (FileSystemFileHandle.prototype as unknown as { move?: unknown }).move === 'function';
  }

  /**
   * Resolve a path, matching the way the card does.
   *
   * getDirectoryHandle() is case-sensitive, but FAT is not: a card whose folder is `Cheats` (an
   * older tool, a hand-made directory) made the exact lookup return null, and plan() then skipped
   * that whole root in silence -- the migration simply never mentioned cheats existed. So: exact
   * match first (the fast path, and what every card written by this app will hit), then one
   * case-insensitive sweep of the parent before giving up.
   *
   * `cache` is per-run. dirAt is called once per file for the conflict check, so without it a
   * 2000-entry root re-walks the whole path 2000 times.
   */
  private async dirAt(
    root: FileSystemDirectoryHandle,
    path: string,
    cache?: Map<string, FileSystemDirectoryHandle | null>,
  ): Promise<FileSystemDirectoryHandle | null> {
    const hit = cache?.get(path);
    if (hit !== undefined) return hit;
    let d: FileSystemDirectoryHandle = root;
    for (const seg of path.split('/')) {
      if (!seg) continue;
      let next: FileSystemDirectoryHandle | null = await d.getDirectoryHandle(seg).catch(() => null);
      if (!next) {
        const want = seg.toLowerCase();
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory' && name.toLowerCase() === want) { next = h as FileSystemDirectoryHandle; break; }
        }
      }
      if (!next) { cache?.set(path, null); return null; }
      d = next;
    }
    cache?.set(path, d);
    return d;
  }

  /**
   * Work out what needs to move. This is the dry run, it only reads.
   *
   * Per root it accepts these shapes, which is what makes a half-migrated card converge instead
   * of confusing it:
   *   <root>/<file>                 legacy flat        -> move into its bucket
   *   <root>/<B>/<file>             legacy 1-char      -> move into its two-letter bucket
   *   <root>/<BB>/<file>            current            -> verify, move only if the bucket is wrong
   *   <root>/sgb/<file>             GB, unbucketed     -> bucket it, stay in sgb/
   *   <root>/sgb/<B|BB>/<file>      GB, migrated       -> verify
   * Anything else is recorded in `skipped` and never touched.
   *
   * `roms` decides which namespace each file belongs to. It is a required argument with no
   * default on purpose: an accidentally-empty index would read every correctly-placed GB sidecar
   * as an orphan.
   *
   * `library` is the card scan the app already did, ROM and patch filenames with their folders.
   * It costs no I/O here and drives the patch renames, which happen out in the ROM tree rather
   * than under /sd2snes. Omitting it simply plans no renames.
   */
  async plan(
    root: FileSystemDirectoryHandle,
    roms: RomIndex,
    library?: { roms: readonly ScannedName[]; patches: readonly ScannedName[] },
  ): Promise<MigrationPlan> {
    const plan = EMPTY_PLAN();
    /* Tally where files actually sit, so `observed` can answer "which layout is this card in?"
       when the firmware version is unreadable. Counted per file, not per directory: one stray
       hand-made folder should not outvote a fully organized card. */
    let seenNew = 0, seenOld = 0;
    const cache = new Map<string, FileSystemDirectoryHandle | null>();

    for (const rootPath of BUCKETED_ROOTS) {
      /* Declared before the existence check, so every root always has a row. A root that is
         missing then reads as "0 files" in the dialog instead of vanishing from the list, which
         is the difference between "cheats is already organized" and "cheats was never looked at"
         -- previously indistinguishable. */
      plan.byRoot[rootPath] ??= { files: 0, bytes: 0 };
      const dir = await this.dirAt(root, rootPath, cache);
      if (!dir) continue;

      const consider = async (holderPath: string, name: string, h: FileSystemHandle, nsHere: AssetNs) => {
        if (h.kind !== 'file') return;
        if (isJunkFile(name)) return;      // collected by scanJunk() below, across the whole tree
        /* Which layout does this file's own position vote for? A two-letter holder (or anything
           under sgb/) is the new layout; the bare root or a one-letter holder is the old one. */
        const holder = holderPath.slice(rootPath.length + 1);   // '' | 'S' | 'su' | 'sgb' | 'sft/SU'
        if (nsHere || (holder.length === BUCKET_LEN)) seenNew++; else seenOld++;
        const stem = bucketKeyForFile(name);
        const cls = roms.get(stem.toLowerCase());
        /* Where does this file belong? In order of how much the evidence is worth:
             library says gb / snes  -> that wins outright, and self-heals a file put in the wrong
                                        namespace by hand or by an older rule;
             library says both       -> the stem matches a .gb and a SNES ROM, so the name proves
                                        nothing -- but the file's own position may. Under the new
                                        layout the two games live in different places, and only the
                                        firmware that loaded a ROM writes there: sgb/<BB> is the
                                        Game Boy one, a plain <BB> bucket is the SNES one. Either
                                        way the question is already answered and the file stays put.
                                        Only a file with no namespace to its name -- loose in the
                                        root, or in a one-character legacy bucket that both games
                                        shared -- is genuinely unattributable -> quarantine.
             not in the library      -> orphan; keep whatever namespace it already has.
           Quarantine is just another destination, which is what buys idempotency (a file already
           there computes the same `want` and stands still) and self-healing: rename one of the two
           ROMs and the stem stops being ambiguous, so the next run carries it on to its bucket.

           Getting this wrong is expensive in a way a unit test would not have shown: on a real
           card 259 already-filed info sidecars would have been yanked out into quarantine,
           breaking game info that works today for the SNES half of each pair. */
        const placed = !!nsHere || holder.length === BUCKET_LEN;
        let want: string;
        if (cls === 'both' && !placed) {
          plan.ambiguous.push({ root: rootPath, path: holderPath, name, stem });
          want = ambiguousDirFor(rootPath);
        } else {
          // library wins outright; 'both' or orphan keeps whatever namespace it is already in
          const ns: AssetNs = cls !== undefined && cls !== 'both' ? cls : nsHere;
          want = bucketDirFor(rootPath, { stem, ns, mode: 'buckets' });
        }
        if (want === holderPath) return;                      // already where it belongs
        const size = await (h as FileSystemFileHandle).getFile().then((f) => f.size).catch(() => 0);
        const move: PlannedMove = { root: rootPath, fromPath: holderPath, toPath: want, name, size };
        const dest = await this.dirAt(root, want, cache);
        const clash = dest ? await dest.getFileHandle(name).catch(() => null) : null;
        if (clash) { plan.conflicts.push(move); return; }
        plan.moves.push(move);
        plan.byRoot[rootPath].files++;
        plan.byRoot[rootPath].bytes += size;
        plan.totalBytes += size;
      };

      /* depth 2 is terminal: a bucket holds files and nothing else. Without that, two-character
         directories would nest forever (saves/AA/BB/CC/...) and files buried arbitrarily deep
         would be planned as if they were sidecars. */
      const walk = async (d: FileSystemDirectoryHandle, dPath: string, ns: AssetNs, depth: 0 | 1 | 2): Promise<void> => {
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'file') { await consider(dPath, name, h, ns); continue; }
          if (depth === 2) { plan.skipped.push(`${dPath}/${name}`); continue; }
          const kind = classifyRootChild(name, depth);
          if (kind === 'unknown') { plan.skipped.push(`${dPath}/${name}`); continue; }
          /* The quarantine is walked like any other holder -- that is what lets a file leave it
             once the user resolves the name clash. It is flat (depth 2 = files only) and never
             counts as a namespace. */
          const childNs: AssetNs = kind === 'sgb' ? SGB_SEG : kind === 'sft' ? SFT_SEG : ns;
          await walk(h as FileSystemDirectoryHandle, `${dPath}/${name}`, childNs,
                     kind === 'sgb' || kind === 'sft' ? 1 : 2);
        }
      };
      await walk(dir, rootPath, '', 0);
    }

    /* Junk comes from one place, and it covers the whole card -- not just the four bucketed roots,
       and not just /sd2snes. System leftovers (AppleDouble, .DS_Store, Thumbs.db, our own .crswap)
       sit next to the BIOS, the themes and config.yml, and above all next to the ROMs, where the
       `.cov` writes breed them. The dialog promises to remove the system leftovers, not some of
       them. What counts as junk is isJunkFile's call (sd-layout), narrowed by isSweepableJunk. */
    plan.junk = await this.scanJunk(root);
    /* Offered, not planned: nothing here is removed unless execute() is told to (see systemDirs). */
    plan.systemDirs = await this.scanSystemDirs(root);
    /* Out in the ROM tree, not under /sd2snes, and free, because it reasons over the scan the
       library already holds instead of walking the card again. */
    if (library) plan.renames = planPatchRenames(library.roms, library.patches);
    if (seenNew || seenOld) plan.observed = seenNew >= seenOld ? 'buckets' : 'legacy';
    /* Counted after the walk but reported as work to do, so a card whose only remaining problem is
       32 dead one-character folders still offers a run. Note this is the state before the moves --
       execute() prunes again at the end, once its own moves have emptied more. */
    plan.emptyDirs = await this.countEmptyHolders(root);
    return plan;
  }

  /**
   * Sweep junk files (AppleDouble/Finder/Windows droppings + orphaned .crswap, see isJunkFile)
   * across the whole card. Cheap and worth doing on its own: they are ~half the entries on a
   * Finder-copied card, and FAT walks them on every lookup, so removing them roughly halves the
   * firmware's directory-scan cost independent of bucketing.
   *
   * Why the ROM tree and not just /sd2snes
   * The biggest producer of `._<name>` is not the firmware's own folder. It is the ROM tree.
   * Chromium writes each `.cov` next to its ROM, and on macOS + exFAT the OS answers every such
   * write with an AppleDouble sidecar, so an auto-filled card ends up with one `._` per ROM folder
   * entry. Scanning only /sd2snes left every one of them in place, in exactly the directories the
   * firmware's game browser reads. Two walks rather than one because the depth caps differ (see
   * SD_JUNK_DEPTH / CARD_JUNK_DEPTH) and /sd2snes has to be reached case-insensitively.
   *
   * Directories that are junk in their own right (recycle bins, `.Trashes`, `System Volume
   * Information`) are not descended into: their contents are already condemned as a unit, listing
   * them would flood the plan with thousands of entries, and Chromium tends to refuse them anyway.
   * They are offered whole, separately, see scanSystemDirs.
   */
  async scanJunk(root: FileSystemDirectoryHandle): Promise<{ path: string; name: string }[]> {
    const out: { path: string; name: string }[] = [];
    const walk = async (d: FileSystemDirectoryHandle, path: string, depth: number, maxDepth: number): Promise<void> => {
      if (depth > maxDepth) return;
      for await (const [name, h] of d.entries()) {
        if (h.kind === 'file') {
          // `path === ''` is the volume root, the one place a desktop.ini is the user's own.
          // Name only, never getFile(): see MigrationPlan.junk.
          if (isSweepableJunk(name, path === '')) out.push({ path, name });
          continue;
        }
        if (isJunkDir(name)) continue;                                  // condemned whole, not per file
        if (depth === 0 && name.toLowerCase() === SD_ROOT) continue;    // walked separately, deeper
        // An unreadable subtree skips instead of aborting the whole scan (same rule as scanTree).
        try { await walk(h as FileSystemDirectoryHandle, path ? `${path}/${name}` : name, depth + 1, maxDepth); }
        catch { /* skip */ }
      }
    };
    const sd = await this.dirAt(root, SD_ROOT);
    if (sd) await walk(sd, SD_ROOT, 1, SD_JUNK_DEPTH);
    try { await walk(root, '', 0, CARD_JUNK_DEPTH); } catch { /* unreadable root -> keep what /sd2snes gave */ }
    return out;
  }

  /** The recycle bins / volume metadata sitting in the card's root, by name. Shallow on purpose:
   *  these are the ones the user can see and recognise, and the only ones worth offering to delete
   *  whole. See MigrationPlan.systemDirs for why this is opt-in. */
  async scanSystemDirs(root: FileSystemDirectoryHandle): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const [name, h] of root.entries()) {
        if (h.kind === 'directory' && isJunkDir(name)) out.push(name);
      }
    } catch { /* unreadable root -> offer nothing */ }
    return out.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Delete the junk-file sweep (AppleDouble &co, see isJunkFile). Returns how many actually went away.
   *
   * Every removal is isolated
   * The sweep reaches out into the ROM tree now, which is the user's own directory structure and
   * routinely contains read-only folders (a hack set extracted with dr-xr-xr-x dirs is the case
   * that bit production once already). A `._Zelda.sfc` we are not allowed to delete is cosmetic,
   * but four of them in a row would have grown CardWriter's card-wide streak and latched the whole
   * run, refusing every move that followed and leaving half-populated bucket folders. So the
   * removals never feed that streak: a stubborn file is skipped and the sweep carries on.
   *
   * The latch is not lost, only moved to where it means something: if the card really has stopped
   * accepting writes, the moves report it (they are not isolated) and execute() stops there.
   *
   * A folder that keeps refusing is dropped, and only that folder (see JUNK_GIVE_UP_STREAK), the
   * sweep carries straight on with the rest of the card. Everything it could not delete is counted
   * and reported, never swallowed.
   */
  async removeJunk(
    root: FileSystemDirectoryHandle,
    junk: { path: string; name: string }[],
    onProgress?: (done: number, total: number) => void,
    cancelled?: () => boolean,
  ): Promise<{ removed: number; failed: number }> {
    let removed = 0;   // actually deleted
    let failed = 0;    // refused (read-only folder, &c) -- reported, never fatal
    let seen = 0;      // considered, for progress -- a file already gone still advances the bar
    /* Junk is spread over hundreds of directories, and dirAt's miss path enumerates the parent to
       match case-insensitively. Without a cache that is one full re-resolve per file. */
    const cache = new Map<string, FileSystemDirectoryHandle | null>();
    const refusals = new Map<string, number>();   // per directory -- see JUNK_GIVE_UP_STREAK
    const givenUp = new Set<string>();
    for (const j of junk) {
      if (cancelled?.() || this.card.unwritable) break;
      if (givenUp.has(j.path)) { failed++; onProgress?.(++seen, junk.length); continue; }
      const d = await this.dirAt(root, j.path, cache);
      if (d) {
        try { await this.card.remove(d, j.name, { isolated: true }); removed++; refusals.delete(j.path); }
        catch (err) {
          const name = (err as { name?: string })?.name;
          if (name === 'CardUnwritableError') break;
          if (name !== 'NotFoundError') {          // already gone is not a refusal
            failed++;
            const n = (refusals.get(j.path) ?? 0) + 1;
            refusals.set(j.path, n);
            if (n >= JUNK_GIVE_UP_STREAK) {
              givenUp.add(j.path);
              console.warn('[migration] junk sweep: skipping the rest of', `"${j.path}"`, 'after', n, 'refusals', err);
            }
          }
        }
      }
      onProgress?.(++seen, junk.length);
    }
    return { removed, failed };
  }

  /**
   * Delete holder directories the migration left empty, chiefly the one-character legacy buckets,
   * which are what the old layout used and which nothing writes to any more.
   *
   * Moving a file never removed the directory it came from, so a migrated card kept a full set of
   * dead `info/A`, `info/B`, ... folders. They are not merely untidy: `info/` is walked on the way to
   * every asset, so ~32 dead entries is dead weight on every single lookup the firmware does.
   *
   * Deliberately conservative:
   *   - only directories with zero entries are touched (a stray `._` file keeps one alive, which is
   *     correct: the junk sweep runs first, so anything left is something we did not expect);
   *   - only recognised holders (bucket / sgb / quarantine). A folder the user made is left alone
   *     even when empty -- `classifyRootChild` calls it 'unknown' and we do not touch those;
   *   - names are collected before removing, never mutated mid-iteration.
   */
  /** Read-only twin of pruneEmptyHolders, for the dry run. */
  private async countEmptyHolders(root: FileSystemDirectoryHandle): Promise<number> {
    let n = 0;
    for (const rootPath of BUCKETED_ROOTS) {
      const dir = await this.dirAt(root, rootPath);
      if (!dir) continue;
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'directory') continue;
        if (classifyRootChild(name, 0) === 'unknown') continue;
        if (await isEmptyDir(h as FileSystemDirectoryHandle)) n++;
      }
    }
    return n;
  }

  private async pruneEmptyHolders(root: FileSystemDirectoryHandle): Promise<number> {
    let pruned = 0;
    for (const rootPath of BUCKETED_ROOTS) {
      const dir = await this.dirAt(root, rootPath);
      if (!dir) continue;
      const children: [string, FileSystemDirectoryHandle][] = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') children.push([name, h as FileSystemDirectoryHandle]);
      }
      for (const [name, h] of children) {
        const kind = classifyRootChild(name, 0);
        if (kind === 'unknown') continue;
        if (kind === 'sgb') {                       // prune its buckets first, then sgb/ itself
          const inner: string[] = [];
          for await (const [n2, h2] of h.entries()) {
            if (h2.kind === 'directory' && classifyRootChild(n2, 1) !== 'unknown'
                && await isEmptyDir(h2 as FileSystemDirectoryHandle)) inner.push(n2);
          }
          for (const n2 of inner) {
            try { await this.card.removeFolder(h, n2); pruned++; } catch { /* in use; leave it */ }
          }
        }
        if (await isEmptyDir(h)) {
          try { await this.card.removeFolder(dir, name); pruned++; } catch { /* leave it */ }
        }
      }
    }
    return pruned;
  }

  /**
   * Execute a plan. Roots run least-precious first so a systemic problem shows up on info before
   * it ever reaches saves. Saves and states move strictly one at a time, so a cancel has an exact
   * boundary and a partial run is always a clean prefix.
   */
  async execute(
    root: FileSystemDirectoryHandle,
    plan: MigrationPlan,
    onProgress?: (p: MigrationProgress) => void,
    cancelled?: () => boolean,
    opts?: MigrationOptions,
  ): Promise<MigrationResult> {
    const res: MigrationResult = {
      moved: 0, renamed: 0, junkRemoved: 0, junkFailed: 0, failed: [], conflicts: plan.conflicts.length,
      aborted: false, unwritable: false, prunedDirs: 0, sysDirsRemoved: 0, sysDirsFailed: 0,
    };
    /* Deleting a $RECYCLE.BIN whole is the slowest single thing here, so it has to be in the total:
       left out, the bar sat at 100% for the entire wait and the run looked hung. */
    const sysDirs = opts?.removeSystemDirs ? plan.systemDirs : [];
    const total = plan.moves.length + plan.junk.length + plan.renames.length + sysDirs.length;
    let done = 0;

    const order = [...BUCKETED_ROOTS];                          // info, cheats, saves, states...
    order.sort((a, b) => rank(a) - rank(b));                    // ...re-ranked by replaceability

    /* The stages this run will actually perform, so the UI can say "3 of 4" rather than counting
       stages that have nothing to do. */
    const stages: MigrationStage[] = [];
    if (plan.junk.length) stages.push('junk');
    if (plan.renames.length) stages.push('patches');
    for (const rootPath of order) {
      if (plan.moves.some((m) => m.root === rootPath)) stages.push(stageOf(rootPath));
    }
    if (sysDirs.length) stages.push('sysdirs');                 // last, and it runs last too
    const at = (s: MigrationStage) => stages.indexOf(s) + 1;

    // junk first: it is pure deletion of files nothing reads, and it shrinks every directory the
    // moves below have to walk.
    if (plan.junk.length) {
      const swept = await this.removeJunk(root, plan.junk, (d) => {
        onProgress?.({ done: done + d, total, stage: 'junk', stageIndex: at('junk'), stageCount: stages.length });
      }, cancelled);
      res.junkRemoved = swept.removed;
      res.junkFailed = swept.failed;
      done += plan.junk.length;
    }
    /* If the sweep latched the card, stop. Carrying on would refuse every single move and leave
       half-populated bucket folders with no explanation. */
    if (this.card.unwritable) { res.unwritable = true; return res; }

    /* Patches next, out in the ROM tree. Renames in place, one at a time, and a destination that
       already exists is a conflict, the same never-overwrite rule the moves below follow. */
    for (const r of plan.renames) {
      if (cancelled?.()) { res.aborted = true; return res; }
      if (this.card.unwritable) { res.unwritable = true; return res; }
      try {
        const dir = await this.dirAt(root, r.path);
        if (!dir) throw new Error('directory vanished');
        const fh = await dir.getFileHandle(r.name).catch(() => null);
        if (!fh) { done++; continue; }                          // renamed by an earlier run
        if (await dir.getFileHandle(r.to).catch(() => null)) {
          res.conflicts++;                                       // appeared since planning
          done++;
          continue;
        }
        await this.card.renameFile(dir, fh, r.to);
        res.renamed++;
      } catch (err) {
        if ((err as { name?: string })?.name === 'CardUnwritableError') { res.unwritable = true; return res; }
        res.failed.push({ name: `${r.path}/${r.name}`, error: err instanceof Error ? err.message : String(err) });
      }
      onProgress?.({ done: ++done, total, stage: 'patches', stageIndex: at('patches'), stageCount: stages.length });
    }

    for (const rootPath of order) {
      const moves = plan.moves.filter((m) => m.root === rootPath);
      if (!moves.length) continue;
      const stage = stageOf(rootPath);
      const idx = at(stage);
      onProgress?.({ done, total, stage, stageIndex: idx, stageCount: stages.length });
      for (const m of moves) {
        if (cancelled?.()) { res.aborted = true; return res; }
        if (this.card.unwritable) { res.unwritable = true; return res; }
        try {
          const from = await this.dirAt(root, m.fromPath);
          if (!from) throw new Error('source directory vanished');
          const fh = await from.getFileHandle(m.name).catch(() => null);
          if (!fh) { done++; continue; }                        // moved by an earlier run
          const to = await this.card.ensureDir(root, m.toPath);
          if (await to.getFileHandle(m.name).catch(() => null)) {
            res.conflicts++;                                     // appeared since planning
            done++;
            continue;
          }
          await this.card.moveFile(from, fh, to);
          res.moved++;
        } catch (err) {
          if ((err as { name?: string })?.name === 'CardUnwritableError') { res.unwritable = true; return res; }
          res.failed.push({ name: `${m.fromPath}/${m.name}`, error: err instanceof Error ? err.message : String(err) });
        }
        onProgress?.({ done: ++done, total, stage, stageIndex: idx, stageCount: stages.length });
      }
    }

    /* Opt-in, and last: it is the only irreversible thing here (a $RECYCLE.BIN may still hold files
       the user believes they have), so it happens once everything else has succeeded.

       Isolated, and failures are counted rather than thrown. Chromium refuses `System Volume
       Information` outright on Windows, a plain NoModificationAllowedError, every time, for
       reasons that have nothing to do with the card's health. Letting that feed the unwritable
       latch would turn a checkbox nobody needs into an aborted migration. */
    for (const name of sysDirs) {
      if (cancelled?.()) break;
      onProgress?.({ done, total, stage: 'sysdirs', stageIndex: at('sysdirs'), stageCount: stages.length });
      try { await this.card.removeFolder(root, name, { isolated: true }); res.sysDirsRemoved++; }
      catch (err) { res.sysDirsFailed++; console.warn('[migration] could not remove system folder', name, err); }
      done++;
    }

    res.prunedDirs = await this.pruneEmptyHolders(root);
    return res;
  }
}

function stageOf(root: string): MigrationStage {
  if (root.endsWith('/info')) return 'info';
  if (root.endsWith('/cheats')) return 'cheats';
  if (root.endsWith('/states')) return 'states';
  return 'saves';
}

/** True when a directory has no entries at all. */
async function isEmptyDir(d: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const _ of d.entries()) return false;
  return true;
}

/** info and cheats are regenerable; states and saves are not. Move the cheap things first. */
function rank(root: string): number {
  if (root.endsWith('/info')) return 0;
  if (root.endsWith('/cheats')) return 1;
  if (root.endsWith('/states')) return 2;
  return 3;                                                     // saves last
}
