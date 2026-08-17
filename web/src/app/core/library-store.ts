import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LangService } from './lang.service';
import { buildFolderTree, findNode } from './folder-tree';
import { MOCK_ENTRIES } from './mock-data';
import { shortTitle, regionFromName, stemOf } from './format';
import { cdnUrl } from './env';
import { ToastService } from './toast.service';
import { GameDbService } from './gamedb.service';
import { CheatsService } from './cheats.service';
import { CardWriter } from './card-writer.service';
import { DialogService, type ConflictAction, type ConfirmCheckbox } from './dialog.service';
import { FirmwareService } from './firmware.service';
import { ThemesService, type Theme } from './themes.service';
import { PrefsStore } from './prefs-store';
import { downloadBlob } from './download';
import {
  fsAccessSupported,
  pickDirectory,
  ensureRwPermission,
  hasRwPermission,
  saveCardHandle,
  loadCardHandle,
  clearCardHandle,
  loadCardFwAssume,
  pickImageFile,
  pickVideoFile,
  pickPdfFile,
  pickImageFiles,
  scanTree,
  covKey,
  walkUsage,
  systemOf,
  readFileFrom,
  readFileHeader,
  getDirByPath,
  fileExists,
  dirExists,
  readTextFile,
} from '../lib/scan.js';
import { headerlessCrc32, crc32 } from '../lib/crc32.js';
import { snesHeaderChecksum } from '../lib/snes-header';
import { crcKey, loadCrcCache, getCrcCached, saveCrcCache, pruneCrcCache } from '../lib/crc-cache.js';
import { loadGamedbCache, saveGamedbCache, clearGamedbCache, pruneGamedbCache, isFresh } from '../lib/gamedb-cache.js';
import { BIOS_FILES, BIOS_DIR, type BiosFile } from './bios';
import { buildCovFromBytes, covToDataUrl } from '../lib/cov.js';
import { renderThmToDataUrl } from '../lib/thm.js';
import { fetchBytes, gdHasSnapshot } from '../lib/gd.js'; // .gd retired; only the on-card reader/back-compat scan remain
import { buildFmv, buildCoverFile, buildGcvFromCov, buildStaticShot, buildPcm } from '../lib/fmv.js';
import { fetchPackage, fetchInflate } from '../lib/package.js';
import { parseInfoYml, buildYml, syncTokensFromMatch, SYNC_KEYS, DESC_LANGS, DESC_LANG_KEYS,
         MAN_SLOTS_KEY, MAN_USER_TAG, manGroupTag, parseManSlots, serializeManSlots } from '../lib/yml.js';
/** yml.js is untyped JS: pin its language list to the DescLang union here (one cast, one place). */
const DESC_LANG_LIST = DESC_LANGS as readonly DescLang[];
import { readFwVersion, fwUsesBuckets, hasFirmwareFiles, layoutForFw, type FwVersion } from './fw-version';
import { SdMigrationService, buildRomIndex, isSweepableJunk, JUNK_GIVE_UP_STREAK, type MigrationResult, type MigrationPlan, type MigrationOptions, type RomIndex, type ScannedName } from './sd-migration.service';
import { infoDirFor, cheatsDirFor, bucketDirFor, isJunkFile, classifyRootChild, BUCKET_LEN,
         STATES_ROOT, SAVES_ROOT, CHEATS_ROOT, INFO_ROOT, BUCKETED_ROOTS, SGB_SEG, AMBIGUOUS_SEG, bucketKeyForFile,
         assetKeyOf, assetIndexKey, type AssetKey, type AssetIndexKey, type LayoutMode } from './sd-layout';
import { parseManHeader, buildManFromPdf, buildManFromImages, slugIdOfType, guideFileName, GUIDE_SLOTS, USER_GUIDE_SLOTS, MAX_USER_GUIDES } from '../lib/man.js';
import type {
  BoardCell,
  BoardCol,
  BoardRow,
  Cheat,
  DescLang,
  Entry,
  FillCategory,
  FillPlan,
  GameMatch,
  GuideInfo,
  ManSlotMap,
  StatusFilter,
  System,
  SystemFilter,
  ThemeFile,
} from './models';

function normalizeSnesCombo(value: string): string {
  const result = new Set<string>();
  const opposite: Record<string, string> = { u: 'd', d: 'u', l: 'r', r: 'l' };
  for (const key of value) {
    if (opposite[key]) result.delete(opposite[key]);
    result.add(key);
  }
  return [...result].join('');
}

/*  The firmware's YAML parser refills its line buffer with f_gets(line, YAML_BUFLEN, ...) where
 *  YAML_BUFLEN is 256 (src/yaml.c:130, src/yaml.h:17), so it reads the file in 255-byte chunks
 *  rather than in lines. A longer line is split mid-content: the tail arrives on the next read as
 *  its own logical line, without the leading '#' that made it a comment, and a ':' inside it is
 *  then parsed as a key whose value is the entry on the line below. savestate_inputs.yml warns
 *  about exactly this and keeps its entries under ~250 bytes, so trim our trailing comment until
 *  the whole line fits that budget. */
const YAML_LINE_BYTES = 250;
const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

export function clampYamlLine(line: string): string {
  if (utf8Length(line) <= YAML_LINE_BYTES) return line;
  const hash = line.indexOf('#');
  if (hash < 0) return line;
  const head = line.slice(0, hash + 1);
  const bare = line.slice(0, hash).trimEnd();
  const budget = YAML_LINE_BYTES - utf8Length(head);
  if (budget <= 0) return bare;
  // Byte budget caps the char count too, since no UTF-8 sequence is shorter than one byte.
  let comment = line.slice(hash + 1).slice(0, budget);
  while (comment && utf8Length(comment) > budget) comment = comment.slice(0, -1);
  comment = comment.replace(/[\uD800-\uDBFF]$/, '').trimEnd();
  return comment ? head + comment : bare;
}

/*  The value side of a savestate_inputs.yml entry, or null when the pair is half filled.
 *  The firmware splits it with strtok(";, \t") (src/savestate.c:258), which skips leading
 *  delimiters, so ",SL" comes back as the SAVE combo and the user gets the opposite of what
 *  they asked for. Both combos or neither. */
export function savestateInputsValue(save: string, load: string): string | null {
  const saveCombo = normalizeSnesCombo(save);
  const loadCombo = normalizeSnesCombo(load);
  if ((saveCombo === '') !== (loadCombo === '')) return null;
  return `${saveCombo},${loadCombo}`;
}
import { BOARD_COLS } from './models';
import { assetAvailable, assetPresent, FILL_CATS, fillModeActs, matchesStatus, needsGamedbRefresh, tallyBoard } from './board-stats';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** ROMs identified per gamedb request (one batch lookup instead of one-per-ROM). 50 keeps each
 *  request snappy. With 100 the server resolves too many games per call and it feels slow. */
const IDENTIFY_BATCH = 50;
/** How recent a cached GameDB answer must be for auto-fill's Atualizar/Substituir to trust it. Those
 *  modes compare the server's `sync_*`/`metaRev` tokens against the card's, so the answer only has to
 *  be newer than the card, not newer than everything. Minutes, so a run that is cancelled or dies
 *  half-way can be restarted without paying for the whole lookup pass a second time. */
const AUTOFILL_FRESH_MS = 10 * 60 * 1000;
/** How many games auto-fill processes at once. The per-file card write is latency-bound (close() is
 *  ~430ms on a slow SD), so overlapping a few games' writes multiplies throughput. CardWriter caps the
 *  total concurrent card ops. */
const AUTOFILL_CONCURRENCY = 6;
/** How many gamedb batch lookups identifyEntries keeps in flight. The pass used to be strictly
 *  sequential per chunk: checksum 50 ROMs (card busy, network idle), then POST and wait (network busy,
 *  card idle). Each side spent half the pass doing nothing. The stages now run as producer/consumer and
 *  two overlapping POSTs hide each other's ~1s latency. This does not raise the request rate, since
 *  lib/net.js's global 100ms gate still serializes the actual sends; it just stops them from stalling. */
const LOOKUP_CONCURRENCY = 2;
/** How many checksummed chunks may wait for a lookup slot. Backpressure, for the case where the CRC
 *  stage is instant (every checksum cached) and would otherwise run the whole library ahead of the
 *  lookups. */
const IDENTIFY_QUEUE_MAX = 4;
/** CRC concurrency for the main-thread fallback, used when the worker is unavailable (see
 *  core/crc.worker.ts). That path pulls each ROM whole into memory, so it mirrors the worker's read
 *  pool instead of the old 6, which could hold six entire ROMs at once. */
const CRC_FALLBACK_CONCURRENCY = 3;

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    // The per-item try/catch is load-bearing. Without it one rejecting item kills its worker, which
    // rejects the Promise.all, which throws out of the caller's `await pool(...)`, and the bulk stops
    // half-way with the progress bar stuck and no message. Items have to be independent: a bad game
    // is skipped and the rest keep going.
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); } catch (err) { console.error('[pool] item failed, continuing', err); }
    }
  });
  await Promise.all(workers);
}

/** One ROM handed to core/crc.worker.ts. `id` is a correlation token, deliberately not the cache key:
 *  two entries sharing a path would collide and strand a waiter forever. */
interface CrcJobMsg { id: number; name: string; fileHandle: FileSystemFileHandle }
/** What the worker posts back per job: the checksum plus the (size, mtime) of the very File it read, or
 *  the reason it produced none. */
interface CrcResultMsg { id: number; crc?: string; size?: number; mtime?: number; error?: string }

/** Main-thread half of core/crc.worker.ts: streams jobs in and resolves each as its result arrives. One
 *  instance per identify pass. Every failure mode (spawn refused, worker crashed, single job errored)
 *  surfaces as a result with `error` set, so the caller has exactly one fallback path, which is to
 *  checksum that ROM inline, and no way to hang waiting for a worker that will never answer. */
class CrcWorkerClient {
  private readonly waiters = new Map<number, (r: CrcResultMsg) => void>();
  private nextId = 1;
  private dead = false;

  /** null when the worker can't be created (no module workers, CSP, and so on); the caller goes inline. */
  static spawn(): CrcWorkerClient | null {
    try {
      return new CrcWorkerClient(new Worker(new URL('./crc.worker', import.meta.url), { type: 'module' }));
    } catch (e) {
      console.error('[identify] crc worker spawn failed; checksumming on the main thread', e);
      return null;
    }
  }

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as CrcResultMsg;
      const w = this.waiters.get(m.id);
      if (w) { this.waiters.delete(m.id); w(m); }
    };
    worker.onerror = (e) => { console.error('[identify] crc worker died; checksumming on the main thread', e); this.kill(); };
  }

  /** Checksum a batch. Resolves to one result per job, in the order given. */
  run(jobs: { name: string; fileHandle: FileSystemFileHandle }[]): Promise<CrcResultMsg[]> {
    if (!jobs.length) return Promise.resolve([]);
    if (this.dead) return Promise.resolve(jobs.map(() => ({ id: 0, error: 'crc worker unavailable' })));
    const msgs: CrcJobMsg[] = jobs.map((j) => ({ id: this.nextId++, name: j.name, fileHandle: j.fileHandle }));
    // Waiters go in before the post, so a synchronous failure (or a result that races back) always
    // finds them.
    const out = Promise.all(msgs.map((m) => new Promise<CrcResultMsg>((res) => this.waiters.set(m.id, res))));
    try { this.worker.postMessage({ type: 'jobs', jobs: msgs }); }
    catch (e) { console.error('[identify] crc worker postMessage failed', e); this.kill(); }
    return out;
  }

  /** Settle everything pending as failed and stop the worker: end of pass, cancel, or a crash. Cancel
   *  goes through here too, since terminate() drops the reads in flight instead of letting them finish. */
  kill(): void {
    this.dead = true;
    for (const [id, w] of this.waiters) w({ id, error: 'crc worker unavailable' });
    this.waiters.clear();
    try { this.worker.terminate(); } catch {  }/* already gone */
  }
}

interface ScanState { pct: number; label: string; }
interface BulkState { done: number; total: number; label: string; cancelable?: boolean; startedAt?: number; }

/** Per-category tallies for the auto-fill dialog: `present` on the card, `available` from the GameDB. */
type FillTally = Record<FillCategory, number>;
/** `stale` means present on the card but with a newer version on the GameDB (token diff against the
 *  `sync_*` keys in the on-card `.yml`). It is what the "Atualizar" mode ('update') would rewrite. */
interface FillCounts { present: FillTally; available: FillTally; missing: FillTally; stale: FillTally; }
/** "Preencher automaticamente" dialog state: the scope, whether we're still analysing, and the counts. */
interface AutoFillState {
  ids: ReadonlySet<string> | null; // null = whole card
  total: number;
  analyzing: boolean;
  counts: FillCounts | null;
  /** Analyze-phase progress (identifying the not-yet-identified games so availability is known). */
  done?: number;          // games identified so far
  analyzeTotal?: number;  // games being identified this analyze (the not-yet-identified subset)
  startedAt?: number;     // epoch ms when the analyze began (for the live rate/ETA)
}

/** One game's work order for the auto-fill write worker (see core/autofill.worker.ts).
 *  `packageUrl` is null for a game with no `.s2pkg` (still a valid job when `manualUrl` alone is
 *  set. The manual is a direct download, independent of the package). `manualUrl` is the ready-made
 *  `.man` (with zoom) to write AS-IS to slot 0 (`<stem>.man`), never derived from the package. */
interface AutofillJob {
  id: string;
  packageUrl: string | null;
  fallbackPackageUrl: string | null; // base .s2pkg retried when packageUrl (legacy no-audio variant) 404s
  manualUrl: string | null;
  pcmUrl: string | null; // separated audio (`.pcm.zst`) for new audio-less packages; null when embedded/legacy
  file: string; // ROM filename with its extension: the extension decides the sgb/ namespace
  mode: LayoutMode; // which layout to write (the card's firmware decides)
  stem: string;
  folder: string; // ROM dir relative to the card root ('' = root)
  want: { cov: boolean; gcv: boolean; gss: boolean; fmv: boolean; pcm: boolean };
  cheatsText: string | null; // serialized cheats .yml fallback (when the package carries none)
  infoYml: string | null;    // pre-built game info .yml (fmv flag already baked in)
}
/** Progress message the worker posts back per game. */
interface WriterProgress {
  type: 'progress';
  id: string;
  done: number;
  wrote: { cov: boolean; gcv: boolean; gss: boolean; fmv: boolean; pcm: boolean; info: boolean; cheats: boolean; manual: boolean };
  missing: { cov: boolean; gcv: boolean; gss: boolean; fmv: boolean; man: boolean };
  hadPackage: boolean;
  bytes: number; // cumulative bytes the worker has written this run (for the live throughput readout)
  cov?: Uint8Array; // the written .cov bytes (only when wrote.cov) → main renders the list thumbnail live
  err?: { asset: string; reason: string }; // a per-folder write skip (e.g. read-only ROM folder), reported, not fatal
  manErr?: string; // why the `.man` fetch/write failed (empty when it didn't), logged + reported, never swallowed
}

/** A per-game artifact that could not be written during a fill run but did not abort it, surfaced in an
 *  on-screen report (with CSV export) so the user can act. The common case: the ROM's own folder is
 *  read-only, so the `.cov` (written next to the ROM) can't be created. */
export interface FillError {
  id: string;
  title: string;
  file: string;   // ROM filename
  folder: string; // ROM folder relative to the card root ('' = root)
  asset: string;  // which artifact failed ('cov')
  reason: string; // reason code ('readonly')
  /** Free-form specifics for a row that needs them, CSV-only. The guide sweep uses it to name exactly
   *  which slots were deleted and why (`dup:6 obsolete:3+4`). A deletion the user can audit. */
  detail?: string;
}

/**
 * Which /sd2snes/info sidecars a single game has, from one enumeration of that root.
 *
 * `man` holds the guide slot numbers present (0 = the official `<stem>.man`, 2..8 = `<stem>.0N.man`),
 * so `size` is the guide count and `has(0)` is the manual badge, the two answers the per-slot
 * fileExists loop used to buy with eight lookups per game.
 */
export interface InfoSidecars {
  gcv: boolean;
  fmv: boolean;
  yml: boolean;
  gss: boolean;
  gd: boolean;
  man: Set<number>;
}

/** The slots man.js actually names. Anything else on the card is not a guide the app can address. */
const GUIDE_SLOT_SET = new Set<number>(GUIDE_SLOTS as number[]);
const INFO_FLAG_EXTS = ['gcv', 'fmv', 'yml', 'gss', 'gd'] as const;

/**
 * Which sidecar a filename under /sd2snes/info denotes, the whole extension rule of the index, in
 * one pure function so it can be pinned against man.js's own naming (see info-index.spec.ts).
 *
 * Case-insensitive because FAT is: this replaces `fileExists(infoDir, stem + '.gcv')`, which matches
 * regardless of case on the card. `.man` carries its guide slot, mirroring guideFileName: a bare
 * `<stem>.man` is slot 0, `<stem>.0N.man` is slot N. A two-digit group that is not a slot the app
 * addresses (`.01.man`, `.99.man`) returns null, the per-slot fileExists loop never asked about
 * those either, and counting them would inflate the guides badge.
 */
export function infoFileKind(name: string): { kind: 'gcv' | 'fmv' | 'yml' | 'gss' | 'gd' | 'man'; slot: number } | null {
  const n = name.toLowerCase();
  for (const e of INFO_FLAG_EXTS) if (n.endsWith('.' + e)) return { kind: e, slot: -1 };
  if (!n.endsWith('.man')) return null;
  const m = /\.(\d{2})\.man$/.exec(n);
  const slot = m ? Number(m[1]) : 0;
  return GUIDE_SLOT_SET.has(slot) ? { kind: 'man', slot } : null;
}

/**
 * The `<rom>.yml` text that carries the `fmv: 1` flag, given what the file holds now (null = the file
 * does not exist); returns null when the flag is already there and nothing has to be written.
 *
 * Split out of ensureFmvFlag so the patch itself is pure and pinned by a spec: the caller's whole job
 * is to decide where "what the file holds now" comes from (the text it just wrote, in memory, vs a
 * read off the card), and it must not be able to change the bytes that land while doing so. The flag
 * is appended, never rebuilt through buildYml. The file may be hand-edited and this must not
 * normalize/reorder anything else in it.
 */
export function ymlWithFmvFlag(existing: string | null): string | null {
  if (existing == null) return 'fmv: 1\n';
  if (/^\s*fmv\s*:/im.test(existing)) return null;
  return existing + (existing.endsWith('\n') ? '' : '\n') + 'fmv: 1\n';
}

/**
 * The same game info file without the `fmv: 1` flag (null = nothing to write: no file, or no flag in it).
 *
 * The counterpart of ymlWithFmvFlag, and needed for the same reason it exists: auto-fill hands the
 * write worker a game info file with the flag already baked in when a preview is part of the plan (the worker
 * writes the `.yml` and the `.fmv` in one pass, so it cannot ask afterwards). When the package turns
 * out not to carry the clip, that flag is left pointing at files that were never written. The
 * firmware would probe `<rom>.fmv`/`.gss` on every visit and find nothing. Only the flag line is
 * dropped; every other byte of a possibly hand-edited game info file is preserved.
 */
export function ymlWithoutFmvFlag(existing: string | null): string | null {
  if (existing == null || !/^[ \t]*fmv[ \t]*:/im.test(existing)) return null;
  const out = existing.replace(/^[ \t]*fmv[ \t]*:[^\n]*(\n|$)/gim, '');
  return out === existing ? null : out;
}

/**
 * The `fmv` game info field for a game, decided from what the card holds: `1` when either the animated
 * clip (`.fmv`) or the static snapshot (`.gss`) is there, `null` when neither is.
 *
 * The flag is named after the clip but gates both. The firmware reads `fmv:` out of the `.yml` into
 * `fmv_eligible` (sd2snes-next `src/gameinfo.c:522`) and then probes `<rom>.fmv` and, when no clip
 * plays, `<rom>.gss`, both inside the same `if(fmv_eligible)` (gameinfo.c:563-577). So rebuilding a
 * game info file with `fmv: g.fmv === 'has' ? 1 : null`, as every game info rewrite used to, switches off a
 * snapshot sitting right there on the card. Silently, and with nothing to bring it back: the `.gss`
 * file still exists, so the category never reads as "missing" and no run ever revisits it.
 *
 * The two ways to be wrong are not symmetric. Flag set with no media: one directory probe each time
 * the user opens that game's info screen. Flag clear with media: an asset the user paid for is
 * invisible until they notice and delete-and-refill it. This errs towards setting it.
 */
export function fmvFlagFor(g: Pick<Entry, 'fmv' | 'snapshot'>): 1 | null {
  return g.fmv === 'has' || g.snapshot === 'has' ? 1 : null;
}

/**
 * The `man_slots` game info field for a game, from the slot→document map the app holds in memory.
 *
 * Same doctrine as `fmvFlagFor`, and for the same reason: three different code paths rebuild a game's
 * `.yml` from scratch (saveInfoYml, persistSyncTokens, and the game info file auto-fill bakes for the write
 * worker), and every one of them drops any key it doesn't name. A single source of truth is what stops
 * one of them from quietly wiping the map, which would put the card straight back to sha-only dedup
 * and hand the next GameDB re-encode the same duplicate-slots bug (see yml.js MAN_SLOTS_KEY).
 */
export function manSlotsFor(g: Pick<Entry, 'manSlots'>): string | null {
  return (serializeManSlots(g.manSlots ?? null) as string | null) ?? null;
}

/**
 * The `man_slots` value a game info rewrite must write, given what the entry knows and what the file on the
 * card currently says. The whole three-writer rule, in one pure place.
 *
 * `undefined` on the entry means nobody looked, not "there is no map". The distinction is the whole
 * point: a rewrite that treats the two the same erases the map, and erasing it is invisible (the card
 * keeps working, it just silently drops back to sha-only manual dedup and hands the next GameDB
 * re-encode the duplicate-slots bug again).
 */
export function manSlotsField(g: Pick<Entry, 'manSlots'>, onCard: string | null | undefined): string | null {
  return g.manSlots !== undefined ? manSlotsFor(g) : (onCard ?? null);
}

/** What to do with one of the GameDB's manuals: write it to `slot`, skip it (the card already holds
 *  it), or fail with a report reason. `slot` is -1 on a failure, nothing was addressed. */
export interface ManualSlotStep {
  index: number;
  action: 'write' | 'skip' | 'fail';
  slot: number;
  reason: string;
}

/** A `.man` file the pass may delete, always with a receipt for its bytes and a surviving copy. */
export interface ManualSlotDrop {
  slot: number;
  /** 'dup' = another slot holds the same document; 'obsolete' = bytes auto-fill installed at an earlier
   *  sync that the GameDB no longer serves, replaced collectively by the set this pass installs. */
  reason: 'dup' | 'obsolete';
  /** When it may go. `null`. A surviving copy is already on the card and this pass does not touch it,
   *  so the delete can happen straight away (and free the slot). A slot number. That slot's write is
   *  the surviving copy and must land first. `'all'`, no single slot replaces this one, so every
   *  planned write must have landed, with nothing failed, before it goes. */
  after: number | 'all' | null;
}

export interface ManualSlotPlan {
  /** One step per GameDB manual, in server order (`manuals[0]` = the primary). */
  steps: ManualSlotStep[];
  /** Slots to delete, in the order they were decided (see ManualSlotDrop.after for when). */
  drops: ManualSlotDrop[];
  /** slot → document tag as the card will stand once the plan has run, what `man_slots` records. */
  map: Map<number, string>;
  /** Slots taken over by type adoption: an older copy of that document, recognized by the `.man`
   *  header's type slug and rewritten in place. Reported per game. The user has to see it. */
  adopted: Array<{ slot: number; type: string }>;
  /** Occupied slots that look like an older copy of a document installed elsewhere but could not be
   *  proven to be one. Never touched, only reported, so the user can clear them from the guides editor. */
  leftovers: number[];
}

/**
 * Slot policy for one game's manuals: which slot each GameDB document goes to, and which slots may be
 * swept. Pure, so a spec can pin it instead of it only being observable by writing to an SD card.
 *
 * Background: a slot is just `<stem>.NN.man` and carries no mark of which document is in it, so the
 * old rule used the sha as identity ("primary to slot 0, extras dedup by sha256, else first free").
 * The GameDB re-encode of 2026-08-08 broke that: every extra stopped matching, took a free slot next
 * to the copy it should have replaced, and the 222 games with 2+ manuals (5 for Zelda ALTTP and Super
 * Metroid) ran out and reported `slotsfull` to users who owned no duplicates.
 *
 * Recognizing a document already on the card, strongest first:
 *   1. exact bytes (sha256): the card holds this very version;
 *   2. the game info file's `man_slots` map (`groupUuid`, stable across re-encodes, written by this app);
 *   3. the `.man` header's type slug, 40 bytes off the front, the same read `listGuides` uses to
 *      label a slot "Mapa"/"Guia"/"Encarte".
 * (3) carries the repair. The map only exists after a run has written it, so on the run that has to
 * fix the damage there is nothing to look up in, and without the header a re-encoded document is
 * unrecognizable and eats another slot. Measured on v1.21.0: Zelda ALTTP went from 5 correct slots to
 * `Manual · Outro · Mapa · Guia · Encarte · Outro · Mapa · Guia` plus a `slotsfull`.
 *
 * Adoption: a served document with no byte match and no slot in the map takes over the single occupied
 * slot whose header declares the same type, as long as that slot is not the user's, not in the map,
 * and does not hold bytes the GameDB serves. It is rewritten in place, never deleted. Two such slots,
 * or none, and nothing is adopted.
 *
 * Deletion is stricter, deliberately: the slot's bytes must be provably auto-fill's own (`receipt`,
 * either served now or recorded in the game info file's `sync_man`) and a surviving copy must already be on the
 * card or land in this same pass. No hash means no proof means no deletion. An unexplained slot is
 * reported as `leftovers`, never guessed away.
 *
 * A user's guide is out of reach of both: `addGuide` marks its slot with MAN_USER_TAG, and an unmarked
 * one has neither a receipt nor adoption candidacy.
 *
 * An obsolete slot needed for room is reclaimed by writing straight over it, never by deleting first,
 * so a failed download cannot leave the card with neither version.
 */
export function planManualSlots(
  manuals: ReadonlyArray<{ manualUrl?: string | null; sha256?: string | null; groupUuid?: string | null; type?: string | null }>,
  card: {
    /** false = the card was never listed this pass (see installManuals' no-slots shortcut): nothing is
     *  known, so no slot may be swept and the stored map must be carried over untouched. */
    probed: boolean;
    occupied: ReadonlySet<number>;
    hashBySlot: ReadonlyMap<number, string>;
    /** The `.man` header of each occupied slot (40 bytes), `slug` is the document type. This is the
     *  identity a card carries without any help from us; see the adoption rule above. */
    headBySlot?: ReadonlyMap<number, { slug: number | null }>;
    groups: ManSlotMap;
    /** sha256[:16] of every manual the game info file's `sync_man` recorded at the last successful sync. */
    synced: ReadonlySet<string>;
  },
  opts: { force?: boolean } = {},
): ManualSlotPlan {
  const slots = GUIDE_SLOTS as number[];
  const tagOf = (m: { groupUuid?: string | null }): string | null => manGroupTag(m.groupUuid) as string | null;
  const serveShas = new Set(manuals.map((m) => m.sha256).filter((s): s is string => !!s));
  const serveTags = new Set(manuals.map(tagOf).filter((t): t is string => !!t));
  /** The proof (see the header): the slot's exact bytes are auto-fill's own. Null = hands off. */
  const receipt = (nn: number): string | null => {
    const h = card.hashBySlot.get(nn);
    return h && (serveShas.has(h) || card.synced.has(h.slice(0, 16))) ? h : null;
  };
  /** May this pass write over slot `nn`? Only if it is empty or holds bytes we can prove are ours,
   *  and never at all on an unprobed pass, where "empty" only means "we did not look". */
  const ours = (nn: number): boolean => card.probed && (!card.occupied.has(nn) || !!receipt(nn));
  // A truncated GameDB answer must not read as "those documents were retired". The 2026-08 package
  // sweep is the precedent for the server briefly serving less than it has.
  const setIntact = manuals.filter((m) => m.manualUrl && m.sha256).length >= card.synced.size;
  const isObsolete = (nn: number): boolean => {
    const h = card.hashBySlot.get(nn);
    return !!h && !serveShas.has(h) && card.synced.has(h.slice(0, 16)) && setIntact;
  };

  const map = new Map<number, string>();   // slot → document, as it will stand after the plan
  const where = new Map<string, number>(); // document → its slot, the inverse of `map` (see `bind`)
  const userSlots = new Set<number>();     // MAN_USER_TAG: the user's own guides, out of bounds entirely
  /** Slots that look like a second copy of something. Suspicion only: what each one actually holds, and
   *  whether deleting it is safe, is settled after the steps loop (see the drops section). */
  const cand = new Set<number>();
  // The card's stored map, sanitized. Out-of-range slots never enter (we walk GUIDE_SLOTS); a slot the
  // card does not hold is a phantom reservation (a write that failed, or a file deleted behind our back)
  // and is forgotten instead of blocking that slot forever; a document listed twice keeps its lowest
  // slot. Only when we actually probed, an unprobed pass knows nothing and must carry the map over.
  // The user marker is kept in `map` (so it survives the rewrite and keeps reserving the slot) but never
  // in `where`: two slots marked `u` are two different guides, not a document duplicated.
  for (const nn of slots) {
    const tag = card.groups.get(nn);
    if (!tag) continue;
    if (card.probed && !card.occupied.has(nn)) continue;
    if (tag === MAN_USER_TAG) { userSlots.add(nn); map.set(nn, tag); continue; }
    if (where.has(tag)) cand.add(nn);
    else { where.set(tag, nn); map.set(nn, tag); }
  }
  // Byte-identical slots: the same file twice. The lowest is the one that is not suspected, which of
  // them survives for real is still decided later, against where its document actually lands.
  const firstByHash = new Map<string, number>();
  for (const nn of slots) {
    const h = card.hashBySlot.get(nn);
    if (!h || cand.has(nn) || userSlots.has(nn)) continue;
    if (firstByHash.has(h)) cand.add(nn);
    else firstByHash.set(h, nn);
  }

  const taken = new Set<number>(card.occupied);
  const hashes = new Map<number, string>(card.hashBySlot);
  const written = new Set<number>();
  const adopted: Array<{ slot: number; type: string }> = [];
  const steps: ManualSlotStep[] = [];
  /** Point `slot` at `tag`, keeping `map` and `where` exact inverses of each other for the duration of
   *  The steps loop. (The drops section below then deletes from `map` alone, on purpose: `where` has to
   *  keep answering "where did this document end up" while entries are being pruned out of the map.)
   *
   *  Both directions matter. Forgetting the reverse entry of the slot's previous occupant is how a
   *  document could vanish for good: with `0:A` on card and the GameDB promoting B to primary, B took
   *  slot 0 while `where` still said "A is in slot 0", so the extra a hit the "that is the primary"
   *  shortcut, was never written, and the run still stamped a complete `sync_man`, so the category read
   *  as up to date forever and A was simply gone. Silently, with nothing in the report. */
  const bind = (slot: number, tag: string | null): void => {
    const prevTag = map.get(slot);
    if (prevTag && prevTag !== tag && where.get(prevTag) === slot) where.delete(prevTag);
    if (!tag) { map.delete(slot); return; }
    const prevSlot = where.get(tag);
    if (prevSlot !== undefined && prevSlot !== slot) {
      map.delete(prevSlot);
      cand.add(prevSlot); // the document moved; whether its old copy may go is decided after the loop
    }
    map.set(slot, tag); where.set(tag, slot);
  };
  /** The slots that could be an older copy of a document of type `type`, see the adoption rule. */
  const adoptable = (type: string | null | undefined): number[] => {
    if (!type || !card.headBySlot) return [];
    const want = slugIdOfType(type) as number | null;
    if (!want) return [];
    return slots.filter((nn) => {
      if (nn === 0 || !taken.has(nn) || written.has(nn)) return false;
      if (userSlots.has(nn) || map.has(nn)) return false;   // the user's, or already a known document
      const h = hashes.get(nn);
      if (!h || serveShas.has(h)) return false;             // unreadable (never touch), or a current version
      /* The same proof a delete needs. The `u` marker only protects guides added from this version on,
         and the cards that need adopting are precisely the ones with no map at all, so on every card
         in the field today the type check alone was the only thing standing between a user's own
         scanned map and being written over (a fuzz put that at ~52k cards). `sync_man` is the game info file's
         own receipt for bytes auto-fill installed, it survives the server re-encode (it records what
         the card holds, not what the server serves), and every card auto-fill ever filled has one.
         so the repair keeps working and an unproven file is left alone as a reported leftover. */
      if (!card.synced.has(h.slice(0, 16))) return false;
      return card.headBySlot?.get(nn)?.slug === want;
    });
  };
  for (let i = 0; i < manuals.length; i++) {
    const m = manuals[i];
    const fail = (reason: string): void => { steps.push({ index: i, action: 'fail', slot: -1, reason }); };
    if (!m.manualUrl) { fail('nofile'); continue; } // listed by the GameDB but no `.man` published
    const tag = tagOf(m);
    if (i === 0) {
      // Primary → slot 0, in place. Skip only when the card already holds these exact bytes; with no sha
      // to compare, rewrite when the caller forced it (update/replace) or slot 0 is empty.
      const same = m.sha256 ? hashes.get(0) === m.sha256 : taken.has(0) && !opts.force;
      steps.push({ index: i, action: same ? 'skip' : 'write', slot: 0, reason: '' });
      taken.add(0);
      if (!same) { hashes.delete(0); written.add(0); }
      bind(0, tag);
      continue;
    }
    // Extra. (1) Byte-identical anywhere → already installed; record which slot, so a card that is
    // already correct ends this pass with a map and never has to be recognized by sha again.
    // A slot the user claimed is skipped even on a byte hit: `.man` is a byte-exact port of the
    // backend encoder, so the same PDF scanned by the user can land on the same bytes as the served
    // document. Binding it would hand the user's slot to that document, and the next re-encode would
    // then write straight over the `u` marker, since the map now says the slot is ours.
    const at = m.sha256 ? slots.find((nn) => hashes.get(nn) === m.sha256 && !userSlots.has(nn)) : undefined;
    if (at !== undefined) { steps.push({ index: i, action: 'skip', slot: at, reason: '' }); taken.add(at); bind(at, tag); continue; }
    // An extra with no known sha can't be deduped by bytes. Installing it would duplicate on every re-run.
    if (!m.sha256) { fail('nosha'); continue; }
    let slot: number | undefined;
    // (2) the game info file's map.
    const mapped = tag ? where.get(tag) : undefined;
    if (mapped === 0) {
      // The same document twice in the server list, the second copy being the primary. Only trust it
      // when the map agrees (bind keeps the two exact, so a mismatch means something is off).
      if (map.get(0) === tag) { steps.push({ index: i, action: 'skip', slot: 0, reason: '' }); continue; }
    } else if (mapped !== undefined) {
      // The map says this document already owns a slot → rewrite that slot. Unless the bytes sitting
      // there are not provably ours: a stale map entry must never silently destroy a file the app did
      // not write. Forget the entry and take a free slot instead.
      if (ours(mapped)) slot = mapped;
      else { map.delete(mapped); if (tag) where.delete(tag); }
    }
    // (3) the `.man` header's type, the only identity a card carries on its own, and the one that makes
    // the first run on any card recognize what the re-encode renamed out from under it.
    if (slot === undefined) {
      const c = adoptable(m.type);
      if (c.length === 1) { slot = c[0]; adopted.push({ slot, type: m.type as string }); }
      // c.length > 1 → two slots of that type and nothing to tell them apart: do not guess, take a free
      // slot (or report slotsfull) and leave both alone.
    }
    // `taken` already covers every claimed slot on a probed card; the explicit test is what keeps that
    // true for an unprobed one, where the `u` markers survive but nothing has been marked taken.
    if (slot === undefined) slot = USER_GUIDE_SLOTS.find((nn: number) => !taken.has(nn) && !userSlots.has(nn));
    // Out of free slots: reclaim an obsolete one by writing straight over it. Never a delete-then-write.
    // a download that fails would leave the card with neither version.
    if (slot === undefined) {
      slot = USER_GUIDE_SLOTS.find((nn: number) => {
        if (written.has(nn) || userSlots.has(nn) || !isObsolete(nn)) return false;
        const t = map.get(nn);
        return !(t && serveTags.has(t)); // that document's own slot. It is rewritten in place, not stolen
      });
    }
    if (slot === undefined) { fail('slotsfull'); break; }
    // Two served manuals sharing a groupUuid would resolve to the same slot and the second would
    // silently overwrite the first (the GameDB's unique index makes this impossible, which is exactly
    // why it must not pass unnoticed if it ever happens).
    if (written.has(slot)) { fail('dupdoc'); continue; }
    steps.push({ index: i, action: 'write', slot, reason: '' });
    taken.add(slot); hashes.delete(slot); written.add(slot);
    bind(slot, tag);
  }

  /* ---- what may be deleted (see the one rule above) ----
     The suspects above are only suspects. Which document each of them holds, and whether a copy of that
     document survives, is decided here, from the slot's own bytes, and only once the steps loop has
     settled where every document actually ends up.
     Both halves matter, and getting either wrong deletes the last copy of a real manual:
       · identity from bytes, not from the stored map. The map is a claim about the past; the bytes are
         what is in the file now. Two ROMs sharing a stem share one game info file, so one game's `man_slots` can
         describe the other's slots, and a suspect named only by that map is not a duplicate of anything.
       · the survivor resolved after the loop. Electing it up front is what let this through: with `0:B`
         and `8:B` on the card and the GameDB promoting A to primary, slot 8 was condemned as a duplicate
         of slot 0 and `after: 0` was "satisfied" by the write that turned slot 0 into A, deleting the
         only remaining copy of B. Silently, and for good: the pass reports a clean write, `sync_man` is
         stamped complete, fillStale then reads the category as up to date and never offers B again.
     A suspect whose bytes name no served document is not a `dup`; if it has a `sync_man` receipt it is
     picked up by the obsolete sweep below instead, later, and behind the "every write landed" gate. */
  const drops: ManualSlotDrop[] = [];
  const dropped = new Set<number>();
  const keep = new Set<number>(); // survivors: never sweep the copy another drop is counting on
  const shaToTag = new Map<string, string>();
  for (const m of manuals) { const t = tagOf(m); if (m.sha256 && t) shaToTag.set(m.sha256, t); }
  for (const nn of [...cand].sort((a, b) => a - b)) {
    if (nn === 0 || dropped.has(nn) || written.has(nn) || userSlots.has(nn)) continue;
    const h = receipt(nn);
    if (!h) continue;
    const tag = shaToTag.get(h);                    // these exact bytes are this document
    const home = tag ? where.get(tag) : undefined;  // ...and this is where it ends up
    if (home === undefined || home === nn || dropped.has(home)) continue;
    drops.push({ slot: nn, reason: 'dup', after: written.has(home) ? home : null });
    dropped.add(nn); keep.add(home); map.delete(nn);
  }
  for (const nn of slots) {
    if (nn === 0 || dropped.has(nn) || written.has(nn) || keep.has(nn) || userSlots.has(nn) || !isObsolete(nn)) continue;
    const tag = map.get(nn);
    if (tag && serveTags.has(tag)) continue; // that document's own slot, kept and rewritten in place
    drops.push({ slot: nn, reason: 'obsolete', after: 'all' });
    dropped.add(nn); map.delete(nn);
  }
  /* Everything still unexplained that looks like an old copy of a document this pass installed elsewhere:
     right type, not the user's, not in the map, bytes nobody serves, but no receipt, so the delete rule
     refuses it and (being one of several of its type, or already superseded by a byte match) adoption
     did not claim it either. Reported, never touched: the guides dialog shows the type, so the user can
     decide. This is what a card damaged by the old code has left over once the correct set is back. */
  const servedTypes = new Set(manuals.map((m) => m.type).filter((t): t is string => !!t).map((t) => slugIdOfType(t) as number));
  const leftovers = slots.filter((nn) => {
    if (nn === 0 || written.has(nn) || dropped.has(nn) || userSlots.has(nn) || map.has(nn)) return false;
    if (!card.occupied.has(nn)) return false;
    const h = hashes.get(nn);
    if (!h || serveShas.has(h)) return false;
    const slug = card.headBySlot?.get(nn)?.slug;
    return slug != null && servedTypes.has(slug);
  });
  return { steps, drops, map, adopted, leftovers };
}

/**
 * Group the games a run will install manuals for by the bucket their `.man` files live in, and elect
 * one owner per bucket.
 *
 * Why. `<stem>.NN.man` is addressed by stem (see `infoDirFor`), never by the ROM's folder, so every
 * copy of a game, the same filename under `_CONTROL`, under a patch folder, under its letter folder,
 * shares one set of eight slots and one `<rom>.yml`. Installing per entry has them compete: a sibling's
 * freshly written document is not among the ones this entry serves, so it reads as an unprovable
 * leftover, its own extras spill into the next free slots, and enough copies exhaust the card and
 * report `slotsfull` on a library with no duplicate documents at all.
 *
 * Electing an owner is not a compromise. The firmware resolves the manual by stem too, so those copies
 * can only ever display the same documents. One install per bucket is what the layout means.
 *
 * The owner is the entry offering the most documents (the fullest set for files they all share), ties
 * broken by id so a re-run elects the same one and the card converges instead of oscillating.
 */
/**
 * The identity of the `<stem>.yml` an entry's assets are recorded in. The game info file path, which is all
 * the card can tell apart. Folded to lower case for the same reason `infoIndexKey` is: FAT resolves
 * case-insensitively, so two stems differing only in case are one file.
 */
export function gameInfoKeyOf(k: AssetKey): string {
  return infoDirFor(k).toLowerCase() + '/' + k.stem.toLowerCase();
}

/**
 * Elect one entry per shared `<stem>.yml`. The copy that may be reported as out of date.
 *
 * Why. Everything on the card is addressed by the ROM's filename, and `sgb/` is the only namespace
 * that splits it (the firmware builds the same path, `fileops.c` path_asset). So a SNES release and
 * its Satellaview counterpart under one filename, or three builds of a hack sitting in `sfc choice/`,
 * are different GameDB games sharing one game info file and one set of assets. Judged one at a time, each reads
 * the version the other recorded as "outdated": a run stamps one, the other goes stale, the next run
 * stamps it back. Forever, on a card that is already correct.
 *
 * The rule, strongest first:
 *   1. `namedByGameInfo` (the game info file's `rom:` field), a hint, never the answer: it records only the
 *      filename, which is exactly what these copies have in common, so it cannot separate three copies
 *      of `Contra SNES.sfc`. A copy the game info file does not name yields to one it does, and no further.
 *   2. the shallowest folder. The game info file carries the owner's title and description, and the console
 *      shows them for every copy, so the owner should be the one you actually play, not the spare in
 *      `bkup/` or the regional build in `sfc choice/JPN/`. Reorganising the card can re-elect, but a
 *      card that was reorganised has changed anyway; within one layout this is fixed.
 *   3. the lowest id, so there is always exactly one answer.
 *
 * Determinism is the whole point. The same input must elect the same owner in any order, or the card
 * never settles and auto-fill re-offers the same games forever.
 */
export function electGameInfoOwners<T>(
  entries: readonly T[],
  gameInfoKey: (e: T) => string,
  idOf: (e: T) => string,
  namedByGameInfo: (e: T) => boolean,
  depthOf: (e: T) => number = () => 0,
): Map<string, string> {
  const best = new Map<string, T>();
  for (const e of entries) {
    const k = gameInfoKey(e);
    const cur = best.get(k);
    if (!cur) { best.set(k, e); continue; }
    const en = namedByGameInfo(e), cn = namedByGameInfo(cur);
    const ed = depthOf(e), cd = depthOf(cur);
    if (en !== cn ? en : ed !== cd ? ed < cd : idOf(e) < idOf(cur)) best.set(k, e);
  }
  return new Map([...best].map(([k, e]) => [k, idOf(e)]));
}

export function groupManualBuckets<T extends { id: string }>(
  entries: readonly T[],
  bucketOf: (e: T) => string,
  docsOf: (e: T) => number,
): Array<{ bucket: string; owner: T; members: readonly T[] }> {
  const by = new Map<string, T[]>();
  for (const e of entries) {
    const k = bucketOf(e);
    const list = by.get(k);
    if (list) list.push(e); else by.set(k, [e]);
  }
  return [...by].map(([bucket, members]) => ({
    bucket,
    owner: members.reduce((a, b) => (docsOf(b) > docsOf(a) || (docsOf(b) === docsOf(a) && b.id < a.id) ? b : a)),
    members,
  }));
}

/**
 * Key into the /sd2snes/info index: `assetIndexKey` (so the Game Boy namespace still separates
 * `sgb/Tetris` from `Tetris`) folded to lower case.
 *
 * The fold is what makes the index bit-identical to the `fileExists(infoDir, stem + '.gcv')` it
 * replaces: that call resolves on FAT, which is case-insensitive, so a sidecar written as
 * `TETRIS.gcv` beside a `Tetris.gb` matched before and must still match. Two stems differing only in
 * case cannot coexist on FAT, so folding cannot merge two real games' assets.
 */
export function infoIndexKey(k: Pick<AssetKey, 'stem' | 'sgb'>): string {
  return assetIndexKey(k).toLowerCase();
}

/**
 * Walk a sidecar root once, visiting every file under it. Exactly four shapes are accepted, all
 * terminal:
 *     <root>/<file>                 legacy flat
 *     <root>/<B|BB>/<file>          legacy one-char bucket, current bucket
 *     <root>/sgb/<file>
 *     <root>/sgb/<B|BB>/<file>      the Game Boy namespace
 * so a half-migrated card still indexes correctly. Which namespace a file was found in is
 * handed to `visit`, because the file's own name cannot tell you: only the ROM's extension can,
 * and that is long gone by the time a .srm sits on the card.
 *
 * `opts.withText` reads each file's contents for the roots that want them (cheats); everything else
 * only needs presence, so the read is skipped.
 *
 * `opts.skipAmbiguous` leaves the migration's `_ambiguous/` quarantine out of the index. A file lands
 * there when its stem matches both a Game Boy and a SNES game, and the firmware cannot read it there
 * (see sd-layout's note). Indexing it lights a badge on whichever of the two games is asked about
 * first, for an asset the console does not have, and it is the case refreshAfterMigrate clears the
 * flags for. It is opt-in because cheats, saves and states have shipped counting that folder, and
 * dropping a user's visible cheat list is a UI change, not a performance one.
 *
 * A plain function rather than a method: it reads no store state, and being callable without the
 * injector is what lets the traversal be tested (info-index.spec.ts).
 */
export async function indexSidecarRoot(
  root: FileSystemDirectoryHandle,
  path: string,
  visit: (name: string, text: string, sgb: boolean) => void,
  opts: { withText?: boolean; skipAmbiguous?: boolean } = {},
): Promise<void> {
  try {
    const dir = await getDirByPath(root, path);
    if (!dir) return;
    // depth 2 is terminal: a bucket holds files and nothing else. Without that, two-character
    // directories would nest forever (saves/AA/BB/CC/...).
    const eat = async (d: FileSystemDirectoryHandle, sgb: boolean, depth: 0 | 1 | 2): Promise<void> => {
      for await (const [name, h] of d.entries()) {
        if (isJunkFile(name)) continue;
        if (h.kind === 'file') {
          visit(name, opts.withText ? ((await readTextFile(d, name)) ?? '') : '', sgb);
          continue;
        }
        if (depth === 2) continue;
        const kind = classifyRootChild(name, depth);
        if (kind === 'unknown') continue;                              // a user folder; never followed
        if (kind === 'ambiguous' && opts.skipAmbiguous) continue;      // quarantine: unreadable by the firmware
        await eat(h as FileSystemDirectoryHandle, sgb || kind === 'sgb', kind === 'bucket' ? 2 : 1);
      }
    };
    await eat(dir, false, 0);
  } catch {  }/* root absent -> nothing indexed */
}

/**
 * Enumerate /sd2snes/info once into `stem -> which sidecars exist`, the same way indexSidecars does
 * for cheats/saves/states. This root was the last one still probed per game, at 2-3
 * `getDirectoryHandle` calls plus ~13 `fileExists` (each miss an exception) for every ROM.
 *
 * Ephemeral by contract: the only caller builds it, hands it to the probes, and drops it. Nothing may
 * cache it, a `.gcv` written a second later would still read as absent.
 */
export async function indexInfoRoot(dir: FileSystemDirectoryHandle): Promise<Map<string, InfoSidecars>> {
  const idx = new Map<string, InfoSidecars>();
  // bucketKeyForFile, exactly as the other three roots (and the migration planner) use it: it is the
  // one place that knows `<stem>.02.man` belongs to `<stem>`, not to `<stem>.02`.
  const at = (name: string, sgb: boolean): InfoSidecars => {
    const k = infoIndexKey({ stem: bucketKeyForFile(name), sgb });
    let s = idx.get(k);
    if (!s) { s = { gcv: false, fmv: false, yml: false, gss: false, gd: false, man: new Set<number>() }; idx.set(k, s); }
    return s;
  };
  await indexSidecarRoot(dir, INFO_ROOT, (name, _text, sgb) => {
    const f = infoFileKind(name);
    if (!f) return;
    const s = at(name, sgb);
    if (f.kind === 'man') s.man.add(f.slot);
    else s[f.kind] = true;
  }, { skipAmbiguous: true });
  return idx;
}

/**
 * The index entry a game's badges come from.
 *
 * ⚠️ the legacy trap. The index derives `sgb` from where a file was found, but the pre-2.15 layout
 * has no `sgb/` segment at all (see bucketDirFor): a Game Boy game's game info sits in
 * `sd2snes/info/T/Tetris.yml`, so it indexes under `tetris` while the ROM `Tetris.gb` asks for
 * `sgb/tetris`. Keyed strictly, that is a permanent miss, every badge reads 'none' on a legacy card
 * and "Completar" rewrites every Game Boy game's assets on every session.
 *
 * So in legacy mode a Game Boy game consults both keys and merges. That is not a widening: it is
 * exactly what the `fileExists(infoDirFor(key), ...)` it replaces did, because `infoDirFor` on a legacy
 * key resolves to the un-namespaced `info/<B>` for GB and SNES alike. The two colliding on one stem is
 * the very ambiguity the 2.15 layout introduced `sgb/` to end, and `_ambiguous/` to quarantine.
 */
export function infoSidecarsFor(idx: ReadonlyMap<string, InfoSidecars>, key: AssetKey): InfoSidecars | null {
  const own = idx.get(infoIndexKey(key)) ?? null;
  if (key.mode !== 'legacy' || !key.sgb) return own;
  const flat = idx.get(infoIndexKey({ stem: key.stem, sgb: false })) ?? null;
  if (!own || !flat) return own ?? flat;
  return {
    gcv: own.gcv || flat.gcv,
    fmv: own.fmv || flat.fmv,
    yml: own.yml || flat.yml,
    gss: own.gss || flat.gss,
    gd: own.gd || flat.gd,
    man: new Set([...own.man, ...flat.man]),
  };
}

/**
 * Central library state: scanned entries + all interaction state (filters,
 * folder navigation, selection) as signals, with derived `computed` views.
 * `connect()` runs the real scan→identify→status pipeline; `demo()` loads the
 * mock fixture. The UI is identical for both.
 */
@Injectable({ providedIn: 'root' })
export class LibraryStore {
  private readonly toast = inject(ToastService);
  private readonly gamedb = inject(GameDbService);
  private readonly cheats = inject(CheatsService);
  private readonly card = inject(CardWriter);
  private readonly dialog = inject(DialogService);
  private readonly fw = inject(FirmwareService);
  private readonly themes = inject(ThemesService);
  private readonly prefs = inject(PrefsStore);
  private readonly migration = inject(SdMigrationService);
  private readonly i18n = inject(TranslocoService);
  // Re-emits whenever the active language's translations finish (re)loading, so the `rootName`
  // computed re-translates its key. langChanges$ alone fires *before* the new lang's JSON is
  // fetched, so a plain translate() would briefly return the key, we key off the load event.
  private readonly _i18nReady = inject(LangService).ready;

  /* File System Access handles (real pipeline). */
  private rootHandle: FileSystemDirectoryHandle | null = null;
  /* Bucketing (fw 2.15+) splits cheats/ and saves/ across ~300 subdirectories, so a single cached
     handle no longer exists. Enumerating each root once into a set keeps probeOnCard at zero
     directory resolutions per game. cheatsRaw is kept alongside because probeOnCard wants the
     file's text, not just its presence.
     Keyed by AssetIndexKey, not by bare stem: Game Boy sidecars live in their own sgb/ namespace,
     so saves/TE/Tetris.srm and saves/sgb/TE/Tetris.srm are different games' saves and must not
     collapse into one key. The branded type makes any surviving `.has(stem)` a compile error. */
  private cheatText = new Map<AssetIndexKey, string>();
  private saveKeys = new Set<AssetIndexKey>();
  /** Games with at least one save state (<stem>NN.state) under /sd2snes/states. Enumerated once on
   *  connect (scanning per-game would be O(n^2)), so probeOnCard can flag `state` cheaply. */
  private stateKeys = new Set<AssetIndexKey>();
  /** `covKey(folder, stem)` of every `.cov` in the ROM tree, collected by the scan walk (scan.js),
   *  the fourth "enumerate once" index, and the only one outside /sd2snes. Replaces probeOnCard's
   *  per-game `fileExists(dirHandle, stem + '.cov')`, whose miss cost an exception per coverless
   *  game. Always the current tree: it is replaced wherever scanTree runs (applyScan +
   *  refreshAfterMigrate) and cleared on eject. */
  private covStems: ReadonlySet<string> = new Set();
  /** Resolved directory handles, keyed 'r:'/'c:' + path, the main-thread twin of autofill.worker's
   *  getDir. Bucketing spread the asset roots over ~300 subdirectories, so every per-game path costs
   *  2-4 `getDirectoryHandle` calls that a library-wide pass (probe, loadOnCardYml, persistSyncTokens)
   *  then repeats for each of its ~10 neighbours in the same bucket. Handles stay valid across file
   *  writes/removes, only a new root or a mass reshuffle invalidates them, so it is dropped in
   *  openCard / rescan / refreshAfterMigrate / runMigration / eject (see clearDirCache callers). */
  private dirCache = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
  private corsWarned = false;
  private readonly thumbPending = new Set<string>();
  private copySeq = 0;

  /* ---- raw state ---- */
  private readonly _entries = signal<Entry[]>([]);
  /** Menu-theme files (`.thm`/`.skin`) found on the card, shown in the browser alongside ROMs. */
  private readonly _themeFiles = signal<ThemeFile[]>([]);
  /** Absolute path of the currently-selected menu theme (from /sd2snes/config.yml `SkinName`), or null
   *  when none/default. Drives the "ativo" marker on a theme row. */
  private readonly _activeSkin = signal<string | null>(null);
  /** Rendered preview data-URL per on-card theme (keyed by `ThemeFile.path`). Generated locally from the
   *  `.thm` bytes (no network). Works for any theme, gallery or custom. */
  private readonly _themePreviews = signal<ReadonlyMap<string, string>>(new Map());
  /** Theme paths whose render has already been attempted this scan (a failure caches no preview, so
   *  without this the read-through in themePreviewUrl would retry a broken `.thm` forever). Cleared
   *  with the previews themselves, so a re-scan does re-try. */
  private readonly themeRenders = new Set<string>();
  /** Known directory paths (incl. empty folders) so the tree shows them too. */
  private readonly _folders = signal<ReadonlySet<string>>(new Set());
  /** Ids of chip-BIOS files present in /sd2snes/ (probed on connect). */
  private readonly _biosPresent = signal<ReadonlySet<string>>(new Set());
  private readonly _biosProbed = signal(false);
  /** Firmware version read out of /sd2snes/firmware.im3 on the card (the Manager has no device
   *  link, so the image itself is the only honest source). */
  private readonly _fw = signal<FwVersion>({ kind: 'unknown' });
  /** Files that still need moving into the two-letter bucket layout, + AppleDouble junk.
   *  Mirrors the _biosProbed pattern: 0 until a real card has been scanned, so demo mode and the
   *  moment before the probe never raise a false alarm. */
  private readonly _migrateCount = signal(0);
  private readonly _junkCount = signal(0);
  private readonly _migrateProbed = signal(false);
  /** The layout the card is already in, observed during the migration probe. Only consulted when
   *  the firmware version cannot be read. */
  private readonly _cardLayout = signal<LayoutMode | null>(null);
  /** The user's answer to "is this card's firmware 2.15 or newer?", asked once, only when neither
   *  the version nor the card's own folders can settle it, and remembered with the card handle. */
  private readonly _fwAssume = signal<LayoutMode | null>(null);
  /** Non-null only when the layout came from the user's answer rather than from the card. */
  readonly fwAssumed = this._fwAssume.asReadonly();
  /** The most recent plan, published by probeMigration so the dialog can reuse it instead of
   *  walking the whole card again. */
  private readonly _lastPlan = signal<MigrationPlan | null>(null);
  readonly lastPlan = this._lastPlan.asReadonly();
  /** True while runMigration() is executing. Lives in the store, not in the dialog, so the run
   *  survives the dialog being closed mid-way, which is exactly what the user does after starting
   *  it (the progress is on the bulk bar behind the modal). */
  private readonly _migrateRunning = signal(false);
  readonly migrateRunning = this._migrateRunning.asReadonly();
  /** Outcome of the last run, kept until the user dismisses it. Published here (rather than merely
   *  returned to the caller) so the result screen can be shown even when the dialog that started
   *  the run is long gone. */
  private readonly _migrateResult = signal<MigrationResult | null>(null);
  readonly migrateResult = this._migrateResult.asReadonly();
  clearMigrateResult(): void { this._migrateResult.set(null); }
  /** Display name of the opened root (the folder/volume name, neutral). */
  private readonly _rootName = signal('Library');
  /** Translation key backing _rootName when it's a *translated* label (demo / fallback), else null
   *  for real filesystem names. Drives re-translation on language change (see constructor effect). */
  private readonly _rootNameKey = signal<string | null>(null);
  private readonly _connected = signal(false);
  /** A previously-used card handle (from IndexedDB) whose permission needs a user gesture to re-grant,
   * drives the "Reconnect <card>" button on the connect screen. Null = nothing to offer. */
  private readonly _reconnectHandle = signal<FileSystemDirectoryHandle | null>(null);
  /** Name of the card we can 1-click reconnect to (or null). */
  readonly reconnectName = computed(() => this._reconnectHandle()?.name ?? null);
  private readonly _scan = signal<ScanState | null>(null);
  private readonly _bulk = signal<BulkState | null>(null);
  private readonly _bulkTick = signal(0); // ~2 Hz heartbeat while a bulk runs (drives the live rate/ETA)
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private bulkBytesBase = 0; // card.writtenBytes at the start of this bulk (to measure main-thread writes)
  private workerBytes = 0;   // bytes the write worker has reported this bulk (main-thread writes are separate)

  /** The `<rom>.yml` text this session last put on the card, per entry id. Written by every game info file write
   *  (saveInfoYml, persistSyncTokens, ensureFmvFlag, and the worker's own `.yml` once it reports the
   *  write), read by ensureFmvFlag so placing a preview right after writing the game info patches the text
   *  we already have instead of reading the file back. Keyed by entry id, so it must be dropped whenever
   *  the library is rebuilt (ids are positional, see applyScan). */
  private readonly ymlMemo = new Map<string, string>();
  /** Cap on the above: a whole-card fill would otherwise hold one game info file (up to a few KB with the
   *  localized descriptions) per game for the rest of the session. Eviction is insertion-order and costs
   *  only performance, a miss simply reads the file, exactly as before this cache existed, and the
   *  read it saves happens moments after the write, within one game's processing. */
  private static readonly YML_MEMO_MAX = 256;

  /** Lowercased `.man` file names per info-directory path, or null when the cache is disarmed.
   *
   *  Armed only for the window inside an auto-fill run where the manual passes run, between the write
   *  worker finishing (it writes `.man` files of its own, behind this cache's back) and the end of the
   *  run. Hundreds of games share one bucket directory, so that window is exactly where listing it once
   *  instead of once per game matters; outside it, installManuals runs for a single game and lists
   *  directly. Kept in sync by the only writer that can run inside the window, installManuals' own
   *  `put()`. Same doctrine as the /sd2snes/info index (see indexInfoRoot): an existence cache is only
   *  trustworthy while nothing else can be writing. */
  /* Memoizes the promise, not the resolved Set: with the pool of 6, several games of the same bucket
   * can ask for the listing before the first one resolves. A value cache would run up to 6 walks and
   * the last `set` would clobber a Set a put() had already amended. */
  private manDirNames: Map<string, Promise<Set<string>>> | null = null;

  /** Record the game info file text now on the card for `id` (only ever called after a successful write). */
  private rememberYml(id: string, text: string): void {
    this.ymlMemo.delete(id); // re-insert so the newest entry is always last (insertion-order eviction)
    this.ymlMemo.set(id, text);
    if (this.ymlMemo.size > LibraryStore.YML_MEMO_MAX) {
      const oldest = this.ymlMemo.keys().next().value;
      if (oldest !== undefined) this.ymlMemo.delete(oldest);
    }
  }

  /** Screen Wake Lock held while a bulk runs, so the OS doesn't sleep the screen mid-run. It only holds
   *  while the tab is visible (the API auto-releases on hide), so we re-acquire on visibilitychange.
   *  Background-tab throttling (the "para na metade quando troco de aba" symptom) is handled separately
   *  by running the write pipeline in a Web Worker (core/autofill.worker.ts), which isn't throttled. */
  private wakeLock: { release: () => Promise<void> } | null = null;
  private async acquireWakeLock(): Promise<void> {
    try {
      if (this.wakeLock || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void>; addEventListener?: (e: string, cb: () => void) => void }> } }).wakeLock;
      if (!wl?.request) return;
      const sentinel = await wl.request('screen');
      this.wakeLock = sentinel;
      sentinel.addEventListener?.('release', () => { this.wakeLock = null; }); // dropped on hide → clear so we re-acquire
    } catch {  }/* unsupported / denied → ignore (the bulk still runs, just without the lock) */
  }
  private releaseWakeLock(): void {
    const wl = this.wakeLock;
    this.wakeLock = null;
    void wl?.release().catch(() => undefined);
  }

  constructor() {
    // Hold the wake lock for the lifetime of any bulk run; release when it ends. (Background-tab
    // throttling is handled by running the write pipeline in a Web Worker, see core/autofill.worker.ts.)
    effect(() => {
      if (this._bulk()) void this.acquireWakeLock();
      else this.releaseWakeLock();
    });
    /* Drop the progress-modal latch as soon as no phase is up.
       Two things depend on it. (1) The modal must close by itself at the end of the run, the user
       opened it to watch something that no longer exists. (2) The latch must never survive the run
       that raised it, or the next bulk (a move, the Organizer, ...) would come up with a modal the
       user never asked for; the same guard also covers a `runAutoFill` that bails out before ever
       raising a bar. It does not flicker between the run's phases: `runAutoFill` hands the bar
       straight from one `bulkBegin` to the next (identify → write → junk sweep) and only nulls it in
       its `finally`, so `_bulk` stays non-null for the whole chain. */
    effect(() => { if (!this._bulk()) this._progressModal.set(false); });
    // The lock drops when the tab is hidden. Re-acquire when it comes back if a bulk is still running.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this._bulk()) void this.acquireWakeLock();
      });
    }
    // Reconnect the last-used card on load (auto if permission persisted, else offer a 1-click button).
    void this.tryRestoreCard();
  }

  /** Bytes used on the card (background full-tree sum), or null until computed / not connected. */
  private readonly _cardUsedBytes = signal<number | null>(null);
  readonly cardUsedBytes = this._cardUsedBytes.asReadonly();
  /** requestIdleCallback/timeout id of a pending usage reconciliation (see scheduleUsageReconcile). */
  private usageReconcileAt: ReturnType<typeof setTimeout> | null = null;

  /** Fold a known byte delta into the "No cartão: X GB" total instead of re-walking the whole card.
   *  A full walk `getFile()`s every file on the card (~20 s on a full one), which is far too much to
   *  pay for "we just wrote 40 MB". No baseline yet (never connected, or the connect walk is still
   *  running) → the delta is dropped: there is nothing to add it to, and a walk still in flight will
   *  publish its own total anyway, one that predates this write and therefore ignores it, which is
   *  the reconciliation's job to correct, not this one's. */
  private addUsage(bytes: number): void {
    if (!bytes) return;
    this._cardUsedBytes.update((v) => (v == null ? v : Math.max(0, v + bytes)));
  }

  /** How long the reconciliation backs off for when it wakes up while the card is busy. */
  private static readonly USAGE_RECONCILE_RETRY_MS = 30000;

  /** Bound the drift the incremental accounting above can accumulate (an overwrite is counted as if it
   *  were new, and a deleted file (the junk sweep) isn't subtracted at all, since nothing read its
   *  size). One real walk is scheduled for when the browser is idle, so the number self-corrects
   *  without any of it landing on the run. Coalesced: many folds → one walk. */
  private scheduleUsageReconcile(): void {
    if (this.usageReconcileAt != null || !this.rootHandle) return;
    const run = (): void => {
      this.usageReconcileAt = null;
      /* Walking the whole card while it is busy would fight the run for the same SD, and the analyze
         phase (CRC worker + loadOnCardYml) is card-bound without any `_bulk` up, so it has to be named
         here too, as does a scan in progress. Backing off uses a real timer, never a re-armed idle
         callback: idle fires again on the very next free frame, which would spin this check.
         `isBulkRunning`, not `bulkBusy`. The latter is the user-facing guard and shows a toast, which
         from a background poll would mean a "operação em andamento" toast per idle frame. */
      if (this.isBulkRunning() || this._autoFill()?.analyzing || this._scan()) {
        this.usageReconcileAt = setTimeout(run, LibraryStore.USAGE_RECONCILE_RETRY_MS);
        return;
      }
      void this.sumUsage();
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    // A timer id either way: the handle is only used as an "already scheduled" flag, never cancelled.
    this.usageReconcileAt = (ric
      ? (ric(run, { timeout: 60000 }) as unknown as ReturnType<typeof setTimeout>)
      : setTimeout(run, LibraryStore.USAGE_RECONCILE_RETRY_MS));
  }

  private readonly _query = signal('');
  private readonly _sysFilter = signal<SystemFilter>('all');
  private readonly _statusFilter = signal<StatusFilter>('all');

  private readonly _cwd = signal('');
  private readonly _expanded = signal<ReadonlySet<string>>(new Set(['SNES']));
  private readonly _recursive = signal(false);

  private readonly _selId = signal<string | null>(null);
  private readonly _selected = signal<ReadonlySet<string>>(new Set());
  /** Entry ids currently being dragged (drag-and-drop move). */
  private readonly _dragging = signal<string[]>([]);
  /** Folder path being dragged (folder reparent), or null. */
  private readonly _dragFolder = signal<string | null>(null);

  /* ---- readonly exposure ---- */
  readonly entries = this._entries.asReadonly();
  /** id -> entry index over the current library. Built once per `_entries` transition and reused by
   *  every hot id lookup (the worker's progress stream, the probe, `sel`, ...), which used to be a
   *  linear `entries().find()` each time: on a 3000-ROM card an auto-fill run did that thousands of
   *  times per second. Cheap because the entry objects are shared, only the Map is new. */
  readonly entriesById = computed(() => {
    const m = new Map<string, Entry>();
    for (const e of this._entries()) m.set(e.id, e);
    return m as ReadonlyMap<string, Entry>;
  });
  readonly connected = this._connected.asReadonly();
  /** Connected to a real card, as opposed to the demo fixture (which also sets `connected`). Derived
   *  from the entries rather than a second flag: only a scanned ROM carries a `fileHandle`, and every
   *  card-touching action is gated on exactly that. Guards UI that would be a dead end in demo mode. */
  readonly hasCard = computed(() => this._connected() && this._entries().some((g) => !!g.fileHandle));
  readonly scan = this._scan.asReadonly();
  readonly bulk = this._bulk.asReadonly();

  /* ---- detailed progress modal -------------------------------------------------------------- */
  /** User-facing "show me the details" latch for the bulk progress modal. Presentation only: it is
   *  deliberately not part of `BulkState`, so closing the modal cannot touch the run (that is
   *  `cancelBulk`, and only that). The bar keeps reporting either way. */
  private readonly _progressModal = signal(false);
  /** Render the modal? Only while a phase is actually up. The latch alone would leave an empty
   *  modal on screen for the frame between the run ending and the effect below clearing it. */
  readonly progressOpen = computed(() => this._progressModal() && this._bulk() != null);
  /** Raised automatically when an auto-fill is confirmed, and by hand from the bar (any operation). */
  openProgress(): void { this._progressModal.set(true); }
  /** Hide the details, the run carries on; the bulk bar is still there. Never cancels. */
  closeProgress(): void { this._progressModal.set(false); }

  /** Live throughput for the running bulk: jogos/s + ETA seconds + bytes/s (null until a usable sample). */
  readonly bulkRate = computed<{ perSec: number; etaSec: number; bytesPerSec: number } | null>(() => {
    this._bulkTick(); // re-evaluate on each heartbeat so the clock advances between item updates
    const b = this._bulk();
    if (!b || !b.startedAt || b.done <= 0) return null;
    const elapsed = (Date.now() - b.startedAt) / 1000;
    if (elapsed < 0.6) return null;
    const perSec = b.done / elapsed;
    const etaSec = perSec > 0 ? Math.max(0, b.total - b.done) / perSec : 0;
    // bytes written this run = main-thread writes (card.writtenBytes delta) + what the worker reported
    const bytes = Math.max(0, this.card.writtenBytes - this.bulkBytesBase) + this.workerBytes;
    const bytesPerSec = bytes / elapsed;
    return { perSec, etaSec, bytesPerSec };
  });

  /** Live throughput for the auto-fill analyze phase (identifying), so the dialog can show a rate/ETA
   *  instead of a blank spinner on a big folder. Re-evaluates on each `done` update (per ~50-CRC batch). */
  readonly autoFillRate = computed<{ perSec: number; etaSec: number } | null>(() => {
    const s = this._autoFill();
    if (!s || !s.analyzing || !s.startedAt || !s.analyzeTotal || (s.done ?? 0) <= 0) return null;
    const elapsed = (Date.now() - s.startedAt) / 1000;
    if (elapsed < 0.6) return null;
    const perSec = (s.done ?? 0) / elapsed;
    const etaSec = perSec > 0 ? Math.max(0, s.analyzeTotal - (s.done ?? 0)) / perSec : 0;
    return { perSec, etaSec };
  });
  /** Cooperative cancel flag for the in-progress import. */
  private cancelImport = false;
  private writerWorker: Worker | null = null; // the dedicated auto-fill write worker, while a run is active
  /** Real underlying reason of the last "card unwritable" (from the worker or the CardWriter), so the
   *  toast/console name the actual DOMException (NoModification / Quota / InvalidState / ...). */
  private fillFailReason = '';
  cancelBulk(): void { this.cancelImport = true; this.writerWorker?.postMessage({ type: 'cancel' }); }

  /** True while any card-writing operation is in flight (bulk op or a per-ROM
   *  cover/cheat/fmv task), used to warn before the page is closed/refreshed. */
  readonly working = computed(
    () => this._bulk() !== null || this._entries().some((e) => e.busy != null),
  );
  readonly query = this._query.asReadonly();
  readonly sysFilter = this._sysFilter.asReadonly();
  readonly statusFilter = this._statusFilter.asReadonly();
  readonly cwd = this._cwd.asReadonly();
  readonly expanded = this._expanded.asReadonly();
  readonly recursive = this._recursive.asReadonly();
  /** Sidebar open/closed, persisted via PrefsStore (localStorage). */
  readonly sidebarOpen = this.prefs.sidebarOpen;
  readonly selId = this._selId.asReadonly();
  readonly selected = this._selected.asReadonly();
  readonly dragging = this._dragging.asReadonly();
  readonly draggingFolder = this._dragFolder.asReadonly();
  readonly dragActive = computed(() => this._dragging().length > 0 || this._dragFolder() !== null);
  /** Parent path the inline "new folder" input is open under (null = closed). */
  private readonly _newFolderParent = signal<string | null>(null);
  readonly newFolderParent = this._newFolderParent.asReadonly();

  readonly folders = this._folders.asReadonly();
  /** Displayed root label. Real filesystem names (rootNameKey === null) are returned verbatim;
   *  translated labels (demo ROMs / fallback) re-translate when the language changes. The guard keeps
   *  the previous label instead of flashing the raw key during the new language's async load. */
  readonly rootName = computed(() => {
    this._i18nReady(); // recompute once the active language's translations are available
    const key = this._rootNameKey();
    if (!key) return this._rootName();
    const t = this.i18n.translate(key);
    return t === key ? this._rootName() : t;
  });

  /** The firmware version detected on the card. (`fw` above is the FirmwareService, which lists
   *  Downloadable releases -- a different thing entirely.) */
  readonly cardFw = computed(() => this._fw());
  /** True only for a positively-identified release >= 2.15 -- never for snapshot/absent/unknown. */
  readonly fwUsesBuckets = computed(() => fwUsesBuckets(this._fw()));
  /** How many files are in the wrong place for the installed firmware. */
  readonly migrateCount = computed(() => (this._migrateProbed() ? this._migrateCount() : 0));
  readonly junkCount = computed(() => (this._migrateProbed() ? this._junkCount() : 0));
  /**
   * Which layout new files are written in, driven by the firmware on the card, never by which
   * version of this app is loaded. A 2.14 console must keep finding what the Manager writes.
   *
   * The rule itself lives in `layoutForFw` (fw-version.ts) so it can be tested without standing up
   * the whole store; this is only the wiring of the two signals it reads.
   */
  readonly layoutMode = computed<LayoutMode>(() => layoutForFw(this._fw(), this._cardLayout(), this._fwAssume()));

  /** Does the firmware this card will run read the two-letter layout? Either it says so itself, or
   *  the user told us because it could not be read. This (not `fwUsesBuckets` alone) is what
   *  decides whether moving files is safe. */
  readonly readsBuckets = computed(() => this.fwUsesBuckets() || this._fwAssume() === 'buckets');

  /** `assetKeyOf` with the card's layout injected. Every write path goes through this. It is the
   *  single point where the mode enters, which is why adding it touched no call site. */
  private key(romFilename: string): AssetKey {
    return assetKeyOf(romFilename, this.layoutMode());
  }

  /** Short firmware label for the topbar: the fork version is what matters to this project
   *  ("2.15b3"); the upstream base goes in the tooltip. */
  readonly cardFwLabel = computed(() => {
    this._i18nReady(); // same reason as rootName: translate() is not a signal, so without this the
                       // label freezes in whatever language was active the first time it was read.
    const v = this._fw();
    if (v.kind === 'release') return v.fork;
    // The official firmware has no fork version, so the base is the version, shown with a word that
    // says which firmware it is, because "1.11.2" alone reads like a fork number to nobody's benefit.
    if (v.kind === 'official') return this.i18n.translate('topbar.fwOfficial', { base: v.base });
    if (v.kind === 'snapshot') return this.i18n.translate('topbar.fwDev');
    if (v.kind === 'absent') return this.i18n.translate('topbar.fwAbsent');
    return this.i18n.translate('topbar.fwUnknown');
  });

  /** No firmware.im3 at all. The card will not boot the console. Worth flagging, not just stating. */
  readonly cardFwMissing = computed(() => this._migrateProbed() && this._fw().kind === 'absent');

  readonly cardFwDetail = computed(() => {
    this._i18nReady(); // idem. This one is the tooltip, and a stale tooltip is just as wrong
    const v = this._fw();
    if (v.kind === 'release') return this.i18n.translate('topbar.fwDetailRelease', { raw: v.raw, base: v.base });
    if (v.kind === 'official') return this.i18n.translate('topbar.fwDetailOfficial', { base: v.base });
    const head =
      v.kind === 'snapshot' ? this.i18n.translate('topbar.fwDetailDev', { raw: v.raw })
      : v.kind === 'absent' ? this.i18n.translate('topbar.fwDetailAbsent')
      : this.i18n.translate('topbar.fwDetailUnknown');
    /* Say which layout we settled on when the version is a guess, otherwise the only way to find
       out is to look at where a downloaded cover landed. */
    const a = this._fwAssume();
    return a ? `${head} ${this.i18n.translate(a === 'buckets' ? 'migrate.fwAssumedNew' : 'migrate.fwAssumedOld')}` : head;
  });

  /* The card is actively broken: the firmware reads only buckets and this card is not bucketed.
     This is what earns the badge and the automatic pop-up; the button itself is always there.
     Junk alone is merely slow, not broken, so it never raises the badge. */
  readonly migrationRequired = computed(() => this.readsBuckets() && this.migrateCount() > 0);

  /** Moving files is only safe once the card's firmware is known to read the new layout, read off
   *  the image, or answered by the user when the image could not be read. */
  readonly canMoveFiles = computed(() => this.readsBuckets());

  /** Chip-BIOS status: each required file + whether it's present on the card. */
  readonly bios = computed(() => {
    const present = this._biosPresent();
    return BIOS_FILES.map((b) => ({ ...b, present: present.has(b.id) }));
  });
  // 0 until a real card has been probed (so demo / pre-probe don't false-alarm). SGB needs only one
  // version: a complete v1 pair (boot+snes) or a complete v2 pair satisfies it, so a full set of one
  // version doesn't flag the other as missing, it counts as a single requirement either way.
  readonly biosMissing = computed(() => {
    if (!this._biosProbed()) return 0;
    const present = this._biosPresent();
    const pairOk = (v: 'v1' | 'v2') =>
      BIOS_FILES.filter((b) => b.sgbPair === v).every((b) => present.has(b.id));
    const sgbOk = pairOk('v1') || pairOk('v2');
    const others = BIOS_FILES.filter((b) => !b.sgbPair && !present.has(b.id)).length;
    return others + (sgbOk ? 0 : 1);
  });

  /** Destination picker (move/copy), shared by the bulk bar and context menu. */
  private readonly _picker = signal<{ mode: 'move' | 'copy'; ids: ReadonlySet<string> } | null>(null);
  readonly picker = this._picker.asReadonly();
  openPicker(mode: 'move' | 'copy', ids: ReadonlySet<string>): void {
    if (ids.size) this._picker.set({ mode, ids });
  }
  closePicker(): void { this._picker.set(null); }

  /** "Preencher automaticamente" dialog (analysis + per-category choice), or null when closed. */
  private readonly _autoFill = signal<AutoFillState | null>(null);
  private autoFillEpoch = 0; // bumped on open/close so a stale analysis can't overwrite a newer dialog
  readonly autoFill = this._autoFill.asReadonly();
  closeAutoFill(): void { this.autoFillEpoch++; this._autoFill.set(null); }

  /** Post-run report of games whose artifacts couldn't be written (but the run continued), e.g. a
   *  read-only ROM folder rejecting the `.cov`. Null when there's nothing to report. */
  private readonly _fillReport = signal<FillError[] | null>(null);
  readonly fillReport = this._fillReport.asReadonly();
  closeFillReport(): void { this._fillReport.set(null); }
  /** Accumulates skipped-artifact errors during a fill run; snapshotted into `_fillReport` at the end. */
  private runErrors: FillError[] = [];
  private pushFillError(g: Entry | undefined, asset: string, reason: string, detail?: string): void {
    if (!g) return;
    const prev = this.runErrors.find((e) => e.id === g.id && e.asset === asset); // de-dup (id, asset)
    if (prev) {
      // ...but never at the cost of losing the second row's specifics. One game can reach installManuals
      // twice in a run (stranded → the main-thread pool, then the manual pass), and the slots a second
      // sweep deleted would otherwise be counted in the summary and named nowhere.
      if (detail) prev.detail = prev.detail ? `${prev.detail} ${detail}` : detail;
      return;
    }
    this.runErrors.push({ id: g.id, title: g.title || stemOf(g.file), file: g.file, folder: g.folder || '', asset, reason, detail });
  }
  /** Export the current fill report as a CSV file (bom + crlf so Excel opens it cleanly). */
  exportFillReportCsv(): void {
    const errs = this._fillReport() ?? [];
    const cell = (s: string): string => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const head = ['title', 'file', 'folder', 'asset', 'reason', 'detail'];
    const lines = [head.join(','), ...errs.map((e) => [e.title, e.file, e.folder || '/', e.asset, e.reason, e.detail ?? ''].map(cell).join(','))];
    downloadBlob('autofill-erros.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /** Cheat editor target (the entry whose .yml is being edited), or null. */
  private readonly _cheatEdit = signal<Entry | null>(null);
  readonly cheatEdit = this._cheatEdit.asReadonly();
  openCheatEditor(g: Entry): void { this._cheatEdit.set(g); }
  closeCheatEditor(): void { this._cheatEdit.set(null); }

  /** Game-info (metadata) editor target. The entry whose .yml game info is being edited, or null. */
  private readonly _infoEdit = signal<Entry | null>(null);
  readonly infoEdit = this._infoEdit.asReadonly();
  openInfoEditor(g: Entry): void { this._infoEdit.set(g); }
  closeInfoEditor(): void { this._infoEdit.set(null); }
  /** Bumped whenever a game-info .yml is written, so open views re-read the game info file. */
  private readonly _infoRev = signal(0);
  readonly infoRev = this._infoRev.asReadonly();

  /** Guides (in-game manual/PDF) editor target, the entry whose `.man` files are being managed. */
  private readonly _guidesEdit = signal<Entry | null>(null);
  readonly guidesEdit = this._guidesEdit.asReadonly();
  openGuidesEditor(g: Entry): void { this._guidesEdit.set(g); }
  closeGuidesEditor(): void { this._guidesEdit.set(null); }

  /** "Available in GameDB" dialog target, held by id so it tracks live entry updates (busy, etc.). */
  private readonly _identifyId = signal<string | null>(null);
  readonly identifyEntry = computed(() => {
    const id = this._identifyId();
    return id ? (this.entriesById().get(id) ?? null) : null;
  });
  /** Intentional per-ROM Identify: look up CRC→gamedb, then open the "available" dialog. The lookup is
   *  a `refresh` one, the click asks the server about this ROM. (Already identified this session? Then
   *  what is on screen came from the server minutes ago; showing it is not answering from a cache.) */
  async identifyAndShow(g: Entry): Promise<void> {
    if (!g.identified) await this.identify(g, { refresh: true });
    this._identifyId.set(g.id);
  }
  closeIdentify(): void { this._identifyId.set(null); }

  /* ---- derived ---- */
  readonly tree = computed(() =>
    buildFolderTree(this._entries(), this._folders(), this._themeFiles().map((t) => t.folder)),
  );

  /** Searching/filtering switches to flat whole-card results. */
  readonly flat = computed(
    () => !!this._query() || this._sysFilter() !== 'all' || this._statusFilter() !== 'all',
  );

  readonly filtered = computed(() => {
    const cwd = this._cwd();
    const recursive = this._recursive();
    const sys = this._sysFilter();
    const status = this._statusFilter();
    const q = this._query().toLowerCase();

    // Text search flattens to the whole card. Status/system filters stay strictly scoped to the
    // current folder, honouring "Incluir subpastas", even at the root (toggle off at root → only
    // direct-root items; toggle on → the whole card). No filter = folder navigation: direct children.
    const inScope = (g: Entry): boolean => {
      if (q) return true;
      if (recursive) return cwd === '' || g.folder === cwd || g.folder.startsWith(cwd + '/');
      return g.folder === cwd;
    };

    return this._entries().filter((g) => {
      if (!inScope(g)) return false;
      if (sys !== 'all' && g.system !== sys) return false;
      // Shared with the statbar board (see matchesStatus/assetPresent), so a cell that reads
      // "20 missing" always opens a list of exactly 20, including the capa's .cov and .gcv rule.
      if (!matchesStatus(g, status)) return false;
      if (q && !g.title.toLowerCase().includes(q) && !g.file.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  readonly visibleFolders = computed(() => {
    if (this.flat() || this._recursive()) return [];
    return findNode(this.tree(), this._cwd())?.childList ?? [];
  });

  /** Theme files (`.thm`) to show in the current view, scoped like the ROM list: text search flattens
   *  to the whole card; otherwise the current folder (honouring "Incluir subpastas"). Hidden while a
   *  ROM system/status filter is active (those don't apply to themes). */
  readonly themesInCwd = computed(() => {
    const q = this._query().toLowerCase();
    if (q) return this._themeFiles().filter((t) => t.stem.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
    if (this._sysFilter() !== 'all' || this._statusFilter() !== 'all') return [];
    const cwd = this._cwd();
    const recursive = this._recursive();
    return this._themeFiles().filter((t) =>
      recursive ? cwd === '' || t.folder === cwd || t.folder.startsWith(cwd + '/') : t.folder === cwd,
    );
  });

  /** True when this theme is the one currently selected in /sd2snes/config.yml. */
  isThemeActive(t: ThemeFile): boolean {
    return this._activeSkin() === '/' + t.path;
  }

  /** Locally-rendered preview data-URL for an on-card `.thm`, or null → the view shows the palette icon
   *  (until the async render lands, or if the file is unreadable/not a valid theme).
   *
   *  Lazy, read-through: the render is kicked off here, when a view first asks for this theme's tile.
   *  Connect used to render every `.thm` on the card up front (each a full file read + decode) for
   *  folders the user may never open. The views only ask for `themesInCwd()`, so what this scopes the
   *  work to is the current folder, not the viewport: the theme tiles are a plain `@for` with no
   *  IntersectionObserver and no virtualization, so opening a folder holding 50 themes still kicks off
   *  50 renders at once. Accepted. A theme folder is small and browsed on purpose, unlike the ROM list
   *  (thousands of entries), which is why that one observes visibility per tile (see cover-art).
   *  The kick-off is async (the signal is written from a later microtask, never during this read). */
  themePreviewUrl(t: ThemeFile): string | null {
    const url = this._themePreviews().get(t.path);
    if (url === undefined) void this.renderThemePreview(t);
    return url ?? null;
  }

  /** Render a theme's preview from its raw `.thm` bytes (read locally from the card) and cache the data
   *  URL. Idempotent; best-effort. A bad/unreadable file just stays on the icon fallback. */
  private async renderThemePreview(t: ThemeFile): Promise<void> {
    // `themeRenders` is what makes the read-through above safe to call from a template: without it an
    // unreadable/invalid `.thm` (which caches nothing) would be re-read on every change detection.
    if (this._themePreviews().has(t.path) || this.themeRenders.has(t.path)) return;
    this.themeRenders.add(t.path);
    try {
      const bytes = new Uint8Array(await (await t.fileHandle.getFile()).arrayBuffer());
      const url = await renderThmToDataUrl(bytes);
      this._themePreviews.update((m) => new Map(m).set(t.path, url));
    } catch {  }/* leave unrendered → palette icon */
  }

  /** Whole-card tallies. The top statbar is always general (the filter only changes the list, never
   *  these totals); also used by the topbar summary and the bulk-bar tip. */
  readonly stats = computed(() => this.tally(this._entries()));

  private tally(g: Entry[]) {
    return {
      total: g.length,
      // .cov and .gcv, same as the board and auto-fill, the board sits directly under this number,
      // and the two disagreeing about what "capas" means is worse than either definition alone.
      covers: g.filter((x) => assetPresent(x, 'capa')).length,
      snapshots: g.filter((x) => x.snapshot === 'has').length,
      previews: g.filter((x) => x.fmv === 'has').length,
      infos: g.filter((x) => x.info === 'has').length,
      cheats: g.filter((x) => x.cheats === 'has').length,
      // any `.man` slot on the card, the official manual (0) or the user's guides (2..8)
      guides: g.filter((x) => (x.guides ?? 0) > 0).length,
      needCover: g.filter((x) => x.cover === 'available').length,
      needCheat: g.filter((x) => x.cheats === 'available').length,
      unmatched: g.filter((x) => !x.matched).length,
    };
  }

  /** Whole-card asset tally broken down by platform, the statbar's per-system board. */
  readonly systemStats = computed<BoardRow[]>(() => tallyBoard(this._entries()));

  /** Systems actually present on the card, in canonical order, drives the toolbar's system chips
   *  so a SNES-only card doesn't show six dead filters. */
  readonly presentSystems = computed<System[]>(() =>
    this.systemStats().filter((r) => r.system !== null).map((r) => r.system as System),
  );

  readonly selStats = computed(() => {
    const sel = this._selected();
    const list = this._entries().filter((g) => sel.has(g.id));
    return {
      count: list.length,
      needCover: list.filter((g) => g.cover === 'available').length,
      needCheat: list.filter((g) => g.cheats === 'available').length,
    };
  });

  /** How many fillable ROMs live in the current folder (and its subfolders), drives the default
   *  "Preencher automaticamente" button's enabled state and scope. */
  /** The games the default "Preencher automaticamente" button will act on.
   *
   *  With a filter/search active it is exactly what you see: after clicking a board cell for "SNES ·
   *  926 missing previews", the button has to offer those 926, offering the whole folder instead
   *  silently does far more work than was asked for.
   *
   *  With no filter it stays the folder and its subfolders, which is deliberately more than the
   *  visible rows (folder browsing shows direct children only), that's the button's long-standing
   *  promise, and `filtered()` can't express it. */
  readonly fillScope = computed(() => {
    if (this.flat()) return this.filtered().filter((g) => !!g.fileHandle);
    const cwd = this._cwd();
    return this._entries().filter(
      (g) => !!g.fileHandle && (cwd === '' || g.folder === cwd || g.folder.startsWith(cwd + '/')),
    );
  });

  readonly folderFillCount = computed(() => this.fillScope().length);

  readonly sel = computed(() => {
    const id = this._selId();
    return id ? (this.entriesById().get(id) ?? null) : null;
  });

  readonly allFilteredOn = computed(() => {
    const f = this.filtered();
    const s = this._selected();
    return f.length > 0 && f.every((g) => s.has(g.id));
  });
  readonly someFilteredOn = computed(() => {
    const s = this._selected();
    return this.filtered().some((g) => s.has(g.id));
  });

  /* ---- connect / scan (real File System Access pipeline) ---- */
  async connect(): Promise<void> {
    if (!fsAccessSupported()) {
      this.toast.show(this.i18n.translate('store.noFsApi'), 'warn');
      return;
    }
    let dir: FileSystemDirectoryHandle | null;
    try {
      dir = await pickDirectory();
    } catch (err) {
      this.toast.show(this.i18n.translate('store.openFolderFailed', { error: msg(err) }), 'warn');
      return;
    }
    if (!dir) return; // cancelled
    await this.openCard(dir, { interactive: true });
  }

  /** Open a folder dragged in from the OS file manager (Finder/Explorer). */
  async connectFromHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    if (!handle || handle.kind !== 'directory') {
      this.toast.show(this.i18n.translate('store.dropFolderNotFile'), 'warn');
      return;
    }
    await this.openCard(handle, { interactive: true });
  }

  /**
   * Shared scan/identify pipeline for both the picker and dropped handles.
   *
   * `interactive` is set only when the user just chose this folder, and gates the two questions
   * this pipeline can ask (no firmware in the folder; which firmware to assume). Reopening a card
   * they already accepted (reload-resume, the 1-click reconnect) must not re-ask on every page
   * load; the firmware answer is remembered with the handle instead.
   */
  private async openCard(dir: FileSystemDirectoryHandle, opts: { interactive?: boolean } = {}): Promise<void> {
    // Re-confirm read/write permission (a fresh pick/drop, or cleared site data,
    // can leave the grant in a state we must re-request).
    if (!(await ensureRwPermission(dir))) {
      this.toast.show(this.i18n.translate('store.folderAccessDenied'), 'warn');
      return;
    }

    /* Ask before mounting anything: no rootHandle, no scan, no saved handle. Refusing here leaves
       the connect screen exactly as it was, so the user can just pick again. */
    if (opts.interactive && !(await hasFirmwareFiles(dir, getDirByPath))) {
      const r = await this.dialog.confirm({
        title: this.i18n.translate('store.noFirmwareTitle'),
        body: this.i18n.translate('store.noFirmwareBody', { name: dir.name || this.i18n.translate('store.rootFolder') }),
        confirmLabel: this.i18n.translate('store.noFirmwareContinue'),
        cancelLabel: this.i18n.translate('store.noFirmwarePick'),
      });
      if (!r.ok) return;
    }

    this.rootHandle = dir;
    this.clearDirCache(); // handles from the previous card are meaningless (and would resolve into it)
    this.resetCardProbes(); // ...and so are the previous card's probe answers, see the method header
    this._rootNameKey.set(dir.name ? null : 'store.rootFolder');
    this._rootName.set(dir.name || this.i18n.translate('store.rootFolder'));
    this._scan.set({ pct: 4, label: this.i18n.translate('store.reading') });

    try {
      // scanTree reports every ROM it finds: one signal set (and one re-render of the scan overlay,
      // plus one translate()) per file, 3000 of them on a full card, for a counter nobody can read
      // that fast. Publish at ~10 Hz and stamp the exact total once the walk is done.
      let seen = 0, lastTick = 0;
      const tree: ScannedTree = await scanTree(dir, {
        onProgress: (n: number) => {
          seen = n;
          const now = Date.now();
          if (now - lastTick < 100) return;
          lastTick = now;
          this._scan.set({ pct: 8, label: this.i18n.translate('store.scanningRoms', { count: n }) });
        },
      });
      if (seen) this._scan.set({ pct: 8, label: this.i18n.translate('store.scanningRoms', { count: seen }) });
      await this.indexSidecars(dir);

      // Show the library immediately (filenames only), then fill in on-card status
      // + thumbnails progressively. CRC32 + gamedb are deferred to Identify.
      const entries = this.applyScan(tree);
      await this.readActiveSkin(dir); // which theme (if any) is selected in /sd2snes/config.yml
      /* Awaited, before anything can write: layoutMode() decides whether a downloaded cover lands
         where this card's firmware will look for it, and getting that wrong is silent -- the file
         is written, the console just never sees it. probeMigration() also resolves the layout, but
         it is fire-and-forget and its full card walk takes ~20s, which is a wide window for the
         user to hit Auto-fill in. This probe is cheap: one file read plus one shallow listing. */
      await this.probeLayout(dir);
      await this.resolveFwAssumption(dir, !!opts.interactive);
      this._connected.set(true);
      this._reconnectHandle.set(null); // we're connected now, drop any pending reconnect offer
      // remember this card (+ the firmware answer) so a reload can reconnect without re-picking or re-asking
      void saveCardHandle(dir, this._fwAssume());
      this._scan.set(null);
      this.toast.show(this.i18n.translate('store.gamesReadingStatus', { count: entries.length }));
      void this.probeAllOnCard(entries);
      void this.probeBios();
      void this.probeMigration();
      void this.sumUsage();
    } catch (err) {
      this.rootHandle = null;
      this.clearDirCache();
      this.cheatText = new Map();
      this.saveKeys = new Set();
      this.stateKeys = new Set();
      this.covStems = new Set();
      this._connected.set(false);
      this._scan.set(null);
      const m = msg(err);
      if (/InvalidStateError|state had changed|cached in an interface/i.test(m)) {
        this.toast.show(this.i18n.translate('store.cardRefExpired'), 'warn');
      } else {
        this.toast.show(this.i18n.translate('store.cardReadFailed', { error: m }), 'warn');
      }
    }
  }

  /** Build pending entries from a scan result and set them as the library. */
  private applyScan(tree: ScannedTree): Entry[] {
    // Entry ids are positional ('e0', 'e1', ...): anything keyed by id belongs to the library being
    // replaced and would attach to a different game here.
    this.ymlMemo.clear();
    this.themeRenders.clear(); // a re-scan re-attempts the themes whose preview failed to render
    this._folders.set(new Set(tree.dirs));
    this.patchFiles = tree.patches;
    this.covStems = tree.covStems; // covers of this walk, probeOnCard reads it instead of probing per game
    this._themeFiles.set(
      tree.themes.map((t) => ({
        id: t.path,
        name: t.name,
        stem: stemOf(t.name),
        folder: t.folder,
        path: t.path,
        fileHandle: t.fileHandle,
        dirHandle: t.dirHandle,
      })),
    );
    // Not rendered here: a preview costs a full read + decode of the `.thm`, and connect used to pay it
    // for every theme on the card. themePreviewUrl renders the ones a view actually shows (read-through).
    const entries: Entry[] = tree.roms.map((f, i) => ({
      id: 'e' + i,
      title: stemOf(f.name),
      file: f.name,
      folder: f.folder,
      system: (f.system ?? 'SNES') as System,
      crc: '',
      size: 0,
      matched: false,
      cover: 'none',
      cheats: 'none',
      save: false,
      region: regionFromName(f.name),
      fileHandle: f.fileHandle,
      dirHandle: f.dirHandle,
      busy: null,
    }));
    this.discardPendingUpdates(); // a queued patch belongs to the library being replaced (ids are positional)
    this._entries.set(entries);
    // Forget cached checksums for ROMs that are no longer on the card, so a reorganized/replaced
    // library doesn't leave the store growing forever. Fire-and-forget: purely housekeeping.
    void pruneCrcCache(new Set(entries.map((e) => crcKey(e.folder, e.file))));
    // The gamedb cache is keyed by CRC, not by path, so "still on the card" says nothing about it (the
    // same answer serves a second card, or the same ROM renamed). It is trimmed by age instead: drop
    // what is long past every TTL so a browser that has seen several libraries doesn't grow forever.
    void pruneGamedbCache();
    return entries;
  }

  /** Re-walk the open root after a disk change (e.g. an import). */
  private async rescan(): Promise<void> {
    if (!this.rootHandle) return;
    this.clearDirCache(); // the disk changed under us: a folder cached as absent may now exist
    const tree: ScannedTree = await scanTree(this.rootHandle);
    const entries = this.applyScan(tree);
    this._selId.set(null);
    this._selected.set(new Set());
    void this.probeAllOnCard(entries);
    void this.sumUsage();
  }

  /** Import dropped OS handles (files + folders) into `destFolderPath` by copying.
   *  Flattens the drop into a per-file plan first so progress reflects real files
   *  (not just the dropped top-level items) and copies run concurrently. */
  async importDropped(handles: FileSystemHandle[], destFolderPath: string): Promise<void> {
    if (!this.rootHandle || !handles.length) return;
    if (this.bulkBusy()) return; // don't stomp an in-flight bulk op (shared progress + cancel flag)
    this.cancelImport = false;

    // Phase 1, walk the drop into a flat copy plan (no data read yet).
    this._bulk.set({ done: 0, total: 0, label: this.i18n.translate('store.readingFiles'), cancelable: true });
    const plan: { src: FileSystemFileHandle; dir: string; name: string }[] = [];
    try {
      for (const h of handles) {
        if (this.cancelImport) break;
        if (h.kind === 'directory') {
          const sub = destFolderPath ? `${destFolderPath}/${h.name}` : h.name;
          await this.collectFiles(h as FileSystemDirectoryHandle, sub, plan);
        } else if (systemOf(h.name)) { // a loose ROM file
          plan.push({ src: h as FileSystemFileHandle, dir: destFolderPath, name: h.name });
        }
      }
    } catch (err) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.importReadItemsFailed', { error: msg(err) }), 'warn');
      return;
    }
    if (this.cancelImport) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.importCancelled'), 'info');
      return;
    }
    if (!plan.length) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.nothingToImport'), 'warn');
      return;
    }

    // Pre-create every destination dir once (avoids races during concurrent copy).
    const dirCache = new Map<string, FileSystemDirectoryHandle>();
    try {
      for (const path of new Set(plan.map((p) => p.dir))) {
        dirCache.set(path, path ? await this.card.ensureDir(this.rootHandle, path) : this.rootHandle);
      }
    } catch (err) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.importCreateFoldersFailed', { error: msg(err) }), 'warn');
      return;
    }

    // Phase 2, copy with real per-file progress (cancel stops starting new copies).
    this.bulkBegin(plan.length, this.i18n.translate('store.importing'), true);
    let done = 0, ok = 0;
    await pool(plan, 4, async (item) => {
      if (!this.cancelImport) {
        try {
          const dir = dirCache.get(item.dir)!;
          await this.card.copyFile(item.src, dir, item.name);
          ok++;
        } catch (err) {
          this.toast.show(this.i18n.translate('store.importFileFailed', { name: item.name, error: msg(err) }), 'warn');
        }
      }
      done++;
      this._bulk.update((b) => (b ? { ...b, done } : b));
    });

    this._bulk.set(null);
    if (ok) await this.rescan();
    if (this.cancelImport) {
      this.toast.show(
        this.i18n.translate(ok === 1 ? 'store.importCancelledCopiedOne' : 'store.importCancelledCopiedMany', { count: ok }),
        'info',
      );
    } else if (ok) {
      this.toast.show(
        this.i18n.translate(ok > 1 ? 'store.importedFilesMany' : 'store.importedFilesOne', { count: ok, dest: destFolderPath || this._rootName() }),
        'ok',
      );
    } else {
      this.toast.show(this.i18n.translate('store.importFailedNothing'), 'warn');
    }
  }

  /** Recursively collect file handles from a dropped directory into the plan. */
  private async collectFiles(
    dir: FileSystemDirectoryHandle,
    destDir: string,
    plan: { src: FileSystemFileHandle; dir: string; name: string }[],
  ): Promise<void> {
    for await (const [name, child] of dir.entries()) {
      if (this.cancelImport) return;
      if (name.startsWith('.') || name.toLowerCase() === 'sd2snes') continue;
      if (child.kind === 'file') {
        plan.push({ src: child as FileSystemFileHandle, dir: destDir, name });
      } else {
        await this.collectFiles(child as FileSystemDirectoryHandle, `${destDir}/${name}`, plan);
      }
    }
  }

  /** Download a sd2snes+ firmware zip (from the mirror) and write it into
   *  /sd2snes/ on the card. Scoped to the firmware folder, ROMs are untouched. */
  async installFirmware(assetId: number, label: string): Promise<void> {
    if (!this.rootHandle) {
      this.toast.show(this.i18n.translate('store.connectCardOrFolderFirst'), 'warn');
      return;
    }
    if (this.bulkBusy()) return;
    this._bulk.set({ done: 0, total: 0, label: this.i18n.translate('store.downloadingFirmware') });
    let files: { path: string; data: Uint8Array }[];
    try {
      const bytes = await this.fw.fetchZip(assetId);
      files = this.fw.unzip(bytes);
    } catch (err) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.firmwareDownloadFailed', { error: msg(err) }), 'warn');
      return;
    }
    if (!files.length) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.firmwarePackageEmpty'), 'warn');
      return;
    }

    this._bulk.set(null);
    const r = await this.dialog.confirm({
      title: this.i18n.translate('store.installFirmwareTitle', { label }),
      body: this.i18n.translate('store.installFirmwareBody', { count: files.length, name: this._rootName() }),
      confirmLabel: this.i18n.translate('store.install'),
    });
    if (!r.ok) return;

    this.bulkBegin(files.length, this.i18n.translate('store.installingFirmware'));
    let done = 0, ok = 0;
    for (const f of files) {
      try {
        const slash = f.path.lastIndexOf('/');
        const dirPath = slash >= 0 ? f.path.slice(0, slash) : '';
        const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
        const dir = dirPath ? await this.card.ensureDir(this.rootHandle, dirPath) : this.rootHandle;
        await this.card.write(dir, base, f.data);
        ok++;
      } catch (err) {
        this.toast.show(this.i18n.translate('store.writeFileFailed', { path: f.path, error: msg(err) }), 'warn');
      }
      done++;
      this._bulk.update((b) => (b ? { ...b, done } : b));
    }
    this._bulk.set(null);
    this.toast.show(
      this.i18n.translate(ok > 1 ? 'store.firmwareInstalledMany' : 'store.firmwareInstalledOne', { label, count: ok }),
      'ok',
    );
    /* We just replaced firmware.im3, so the version -- and with it layoutMode() and the migration
       warning -- is stale. Re-probing here is the whole point: crossing 2.14 -> 2.15 is exactly
       when a card silently stops being readable by the console, and it is also when the Manager
       must switch which layout it writes. Without this the user would have to eject and reconnect
       to get correct behaviour, with no hint that they should. */
    if (this.rootHandle) {
      await this.probeLayout(this.rootHandle);
      await this.probeMigration();
    }
  }

  /* ---- menu themes (.thm from the Landing gallery) ---- */

  /** Destination folder chosen for the last theme install (session default for the picker). The
   *  firmware reads a `.thm` from any visible card folder, so `_themes` at the root is the default. */
  readonly lastThemeDir = signal('_themes');

  /** Create the `_themes` folder at the card root if it doesn't exist yet; returns its path. */
  async ensureThemesRoot(): Promise<string> {
    if (this.rootHandle) await this.card.ensureDir(this.rootHandle, '_themes');
    return '_themes';
  }

  /** Download a gallery theme's `.thm`, write it into `destPath` on the card, and apply it by
   *  upserting `SkinName: /<destPath>/<file>` into /sd2snes/config.yml (every other key preserved).
   *  `destPath` '' = card root. */
  async installTheme(theme: Theme, destPath: string): Promise<void> {
    if (!this.rootHandle) {
      this.toast.show(this.i18n.translate('store.connectCardOrFolderFirst'), 'warn');
      return;
    }
    if (this.bulkBusy()) return;
    this._bulk.set({ done: 0, total: 0, label: this.i18n.translate('store.installingTheme', { name: theme.name }) });
    let bytes: Uint8Array;
    try {
      bytes = await this.themes.fetchTheme(theme.file);
    } catch (err) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.themeDownloadFailed', { error: msg(err) }), 'warn');
      return;
    }
    try {
      const dir = destPath ? await this.card.ensureDir(this.rootHandle, destPath) : this.rootHandle;
      await this.card.write(dir, theme.file, bytes);
      this.lastThemeDir.set(destPath);
      // Register the file so it shows in the browser immediately (no full re-scan) + make its folder visible.
      const path = [destPath, theme.file].filter(Boolean).join('/');
      const fh = await dir.getFileHandle(theme.file).catch(() => null);
      if (fh) this.upsertThemeFile({ id: path, name: theme.file, stem: stemOf(theme.file), folder: destPath, path, fileHandle: fh, dirHandle: dir });
      if (destPath) this._folders.update((s) => (s.has(destPath) ? s : new Set(s).add(destPath)));
      // Render its preview from the bytes we just fetched (no re-read) so it shows immediately.
      this.themeRenders.add(path); // already rendered → the tile's read-through must not read it again
      void renderThmToDataUrl(bytes).then((url) => this._themePreviews.update((m) => new Map(m).set(path, url))).catch(() => {  });/* keep icon */
      // Apply: the firmware selects the theme by the full absolute path in /sd2snes/config.yml. The copy
      // above already succeeded; applying is best-effort (a card without /sd2snes → warn, don't fabricate it).
      const full = '/' + path;
      const outcome: 'applied' | 'no-sd2snes' | 'no-config' | 'too-long' =
        full.length > 127 ? 'too-long' : await this.applyThemeConfig(full);
      if (outcome === 'applied') this._activeSkin.set(full);
      this._bulk.set(null);
      // Known delta (this one file) instead of a full-card walk; the idle pass settles an overwrite.
      this.addUsage(bytes.byteLength);
      this.scheduleUsageReconcile();
      const folder = destPath || this.rootName();
      const key =
        outcome === 'applied' ? 'store.themeInstalledApplied'
        : outcome === 'no-sd2snes' ? 'store.themeInstalledNoSd2snes'
        : outcome === 'no-config' ? 'store.themeInstalledNoConfig'
        : 'store.themeInstalledPathLong';
      this.toast.show(this.i18n.translate(key, { name: theme.name, folder, file: theme.file }), outcome === 'applied' ? 'ok' : 'warn');
    } catch (err) {
      this._bulk.set(null);
      this.toast.show(this.i18n.translate('store.writeFileFailed', { path: theme.file, error: msg(err) }), 'warn');
    }
  }

  /** Upsert `SkinName: <path>` into an existing /sd2snes/config.yml, preserving every other line/comment.
   *  Never creates /sd2snes (a card without it has no firmware to read the key), returns 'no-sd2snes'.
   *  Never creates config.yml from scratch either: a bare file with only `SkinName` isn't a valid config
   *  and the firmware may leave it as-is instead of writing its real defaults, returns 'no-config' so the
   *  caller can tell the user to boot the firmware once (which creates config.yml) or pick the .thm by hand. */
  /** Read every scalar setting from config.yml. Comments and document markers are ignored. */
  async readConfigSettings(): Promise<Record<string, string> | null> {
    if (!this.rootHandle) return null;
    const dir = await getDirByPath(this.rootHandle, 'sd2snes');
    const raw = dir ? await readTextFile(dir, 'config.yml') : null;
    if (raw == null) return null;
    const values: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2];
    }
    return values;
  }

  async saveConfigSettings(values: Record<string, string>): Promise<boolean> {
    if (!this.rootHandle || this.card.unwritable) return false;
    const dir = await getDirByPath(this.rootHandle, 'sd2snes');
    const raw = dir ? await readTextFile(dir, 'config.yml') : null;
    if (!dir || raw == null) return false;
    const comboKeys = new Set(['IngameButtonsSaveState', 'IngameButtonsLoadState', 'IngameButtonsChangeState', 'IngameButtonsMenu']);
    const safeValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, comboKeys.has(key) ? normalizeSnesCombo(value) : value]));
    const ending = raw.includes('\r\n') ? '\r\n' : '\n';
    const out = Object.entries(safeValues).reduce((text, [key, value]) => {
      const line = new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:)\\s*.*$`, 'm');
      // Append rather than drop when the key is not in the file: older config.yml files predate
      // several of these keys, and one of them has no menu entry in the firmware at all, so the
      // setting would silently do nothing. The parser reads `key: value` in any order, and the
      // firmware rewrites the whole file in its own order at the next cfg_save().
      // Replacement callback, not "$1 value": a '$' in a path value must not be expanded.
      if (!line.test(text)) return text.replace(/\s*$/, '') + `${ending}${key}: ${value}${ending}`;
      return text.replace(line, (_match: string, head: string) => `${head} ${value}`);
    }, raw);
    return await this.card.write(dir, 'config.yml', out);
  }

  /** Read this ROM's internal 16-bit checksum and its optional custom save/load inputs. */
  async readSavestateInputs(g: Entry): Promise<{ checksum: string; save: string; load: string } | null> {
    if (!this.rootHandle || !g.fileHandle || g.system !== 'SNES') return null;
    const checksum = await snesHeaderChecksum(await g.fileHandle.getFile());
    if (!checksum) return null;
    const dir = await getDirByPath(this.rootHandle, 'sd2snes');
    const raw = dir ? await readTextFile(dir, 'savestate_inputs.yml') : null;
    const match = raw?.match(new RegExp(`^\\s*${checksum}\\s*:\\s*([^,#\\r\\n]*)\\s*,\\s*([^#\\r\\n]*?)\\s*(?:#.*)?$`, 'mi'));
    return { checksum, save: normalizeSnesCombo(match?.[1]?.trim() ?? ''), load: normalizeSnesCombo(match?.[2]?.trim() ?? '') };
  }

  /** Upsert one checksum entry while retaining the file's comments, order and line endings.
   *  Rejects a half-filled pair: the firmware splits the value with strtok(";, \t")
   *  (src/savestate.c:258), which skips leading delimiters, so an entry written as ",SL" comes
   *  back as the SAVE combo instead of the load one. */
  async saveSavestateInputs(checksum: string, save: string, load: string, gameName: string): Promise<boolean> {
    if (!this.rootHandle || this.card.unwritable || !/^[0-9A-F]{4}$/i.test(checksum)) return false;
    const value = savestateInputsValue(save, load);
    if (value == null) return false;
    const dir = await getDirByPath(this.rootHandle, 'sd2snes');
    if (!dir) return false;
    const raw = await readTextFile(dir, 'savestate_inputs.yml');
    const comment = gameName.replace(/[\r\n]+/g, ' ').trim() || 'unknown game';
    const empty = value === ',';
    const entry = clampYamlLine(`${checksum.toUpperCase()}: ${value} # ${comment}`);
    let out: string;
    if (raw == null) {
      if (empty) return true;
      out = `---\n# Savestate Custom Inputs\n# CKSUM: SAVE,LOAD\n${entry}\n`;
    } else {
      const line = new RegExp(`^([ \\t]*${checksum}[ \\t]*:[ \\t]*)[^#\\r\\n]*?([ \\t]*(?:#.*)?)$`, 'mi');
      const ending = raw.includes('\r\n') ? '\r\n' : '\n';
      if (empty) {
        const wholeLine = new RegExp(`^[ \\t]*${checksum}[ \\t]*:[^\\r\\n]*(?:\\r?\\n|$)`, 'mi');
        if (!wholeLine.test(raw)) return true;
        out = raw.replace(wholeLine, '');
      } else {
        // Replacement callback, not a "$1..$2" string: it keeps the entry's own comment and
        // alignment, re-fits the rebuilt line, and stops '$' inside a value being expanded.
        out = line.test(raw)
          ? raw.replace(line, (_match: string, head: string, tail: string) => clampYamlLine(`${head}${value}${tail}`))
          : raw.replace(/\s*$/, '') + `${ending}${entry}${ending}`;
      }
    }
    return await this.card.write(dir, 'savestate_inputs.yml', out);
  }

  private async applyThemeConfig(skinPath: string): Promise<'applied' | 'no-sd2snes' | 'no-config'> {
    if (!this.rootHandle) return 'no-sd2snes';
    const dir = await getDirByPath(this.rootHandle, 'sd2snes');
    if (!dir) return 'no-sd2snes';
    const existing = await readTextFile(dir, 'config.yml');
    if (existing == null) return 'no-config';                                // firmware never booted → no config yet
    const line = `SkinName: ${skinPath}`;
    const out = /^SkinName:.*$/m.test(existing)
      ? existing.replace(/^SkinName:.*$/m, line)             // replace in place
      : existing.replace(/\s*$/, '') + '\n' + line + '\n';   // append, keeping other keys
    await this.card.write(dir, 'config.yml', out);
    return 'applied';
  }

  /** Read the currently-selected menu theme from /sd2snes/config.yml (`SkinName`). A value that isn't an
   *  absolute path (e.g. the default `sd2snes.skin`) means "no theme" → null. Best-effort, never throws. */
  private async readActiveSkin(root: FileSystemDirectoryHandle): Promise<void> {
    try {
      const dir = await getDirByPath(root, 'sd2snes');
      const cfg = dir ? await readTextFile(dir, 'config.yml') : null;
      const m = cfg?.match(/^SkinName:\s*(.+?)\s*$/m);
      this._activeSkin.set(m && m[1].startsWith('/') ? m[1] : null);
    } catch { this._activeSkin.set(null); }
  }

  private upsertThemeFile(t: ThemeFile): void {
    this._themeFiles.update((list) => [...list.filter((x) => x.path !== t.path), t].sort((a, b) => a.path.localeCompare(b.path)));
  }

  /** Set an already-on-card `.thm` as the menu theme (writes `SkinName` into /sd2snes/config.yml). */
  async setActiveTheme(t: ThemeFile): Promise<void> {
    if (!this.rootHandle || this.bulkBusy()) return;
    const skin = '/' + t.path;
    if (skin.length > 127) { this.toast.show(this.i18n.translate('store.themeSetPathLong', { name: t.stem }), 'warn'); return; }
    const outcome = await this.applyThemeConfig(skin);
    if (outcome === 'applied') {
      this._activeSkin.set(skin);
      this.toast.show(this.i18n.translate('store.themeSet', { name: t.stem }), 'ok');
    } else {
      const key = outcome === 'no-config' ? 'store.themeSetNoConfig' : 'store.themeSetNoSd2snes';
      this.toast.show(this.i18n.translate(key, { name: t.stem, file: t.name }), 'warn');
    }
  }

  /** Delete a `.thm` from the card. If it was the active theme, clears `SkinName` back to the default. */
  async removeTheme(t: ThemeFile): Promise<void> {
    if (!this.rootHandle || this.bulkBusy()) return;
    const r = await this.dialog.confirm({
      title: this.i18n.translate('store.removeThemeTitle', { name: t.stem }),
      body: this.i18n.translate('store.removeThemeBody', { name: t.name }),
      confirmLabel: this.i18n.translate('store.remove'),
      danger: true,
    });
    if (!r.ok) return;
    try {
      // Size first: the handle can't answer once the file is gone, and one getFile() is what lets the
      // usage total be adjusted by a known delta instead of re-walking the whole card.
      const freed = await t.fileHandle.getFile().then((f) => f.size).catch(() => 0);
      await this.card.remove(t.dirHandle, t.name);
      this._themeFiles.update((list) => list.filter((x) => x.path !== t.path));
      if (this._activeSkin() === '/' + t.path) {
        await this.applyThemeConfig('sd2snes.skin'); // non-path value = baked-in default (clears the theme)
        this._activeSkin.set(null);
      }
      this.addUsage(-freed);
      this.toast.show(this.i18n.translate('store.themeRemoved', { name: t.stem }), 'ok');
    } catch (err) {
      this.toast.show(this.i18n.translate('store.writeFileFailed', { path: t.path, error: msg(err) }), 'warn');
    }
  }

  /* ---- SD layout migration (two-letter buckets, firmware 2.15+) ---- */

  /** Which namespace each stem on this card belongs to, from the scanned ROMs. The only thing
   *  that can tell a GB game's Tetris.srm from a SNES game's. One accessor so the three plan()
   *  call sites below cannot drift apart. */
  private romIndex(): RomIndex {
    return buildRomIndex(this._entries().map((e) => e.file));
  }

  /** Every `.ips`/`.bps` on the card, from the last scan. Not a signal: nothing renders it, it
   *  exists only so the migration can spot the patches firmware 2.15+ refuses to offer. */
  private patchFiles: ScannedName[] = [];

  /** The scanned ROM/patch filenames the patch renames are planned from. Same rationale as
   *  romIndex(): one accessor, so the plan() call sites cannot drift apart. */
  private libraryFiles(): { roms: ScannedName[]; patches: ScannedName[] } {
    return {
      roms: this._entries().map((e) => ({ folder: e.folder, name: e.file })),
      patches: this.patchFiles,
    };
  }

  /**
   * Resolve which layout to write, cheaply enough to await before the library goes live.
   *
   * Two reads, both bounded:
   *   1. /sd2snes/firmware.im3 -> the version, which is authoritative when it is a release;
   *   2. a shallow listing of the bucketed roots, used only when the version cannot be identified
   *      (development build, no firmware.im3, original sd2snes): a two-letter subdirectory means
   *      the card is already organized, a file sitting directly in the root means it is not.
   *
   * (2) walks all four roots rather than just saves because it now carries more weight: with no
   * observation at all an unidentified firmware writes legacy, so an already-bucketed card whose
   * saves folder happens to be empty must still be recognized -- info/cheats/states can say so.
   *
   * The full plan in probeMigration() supersedes (2) with a proper per-file majority once it
   * finishes; this is just enough to stop the first write from guessing.
   */
  private async probeLayout(dir: FileSystemDirectoryHandle): Promise<void> {
    try {
      this._fw.set(await readFwVersion(dir, getDirByPath));
      if (this._fw().kind === 'release') return;         // version decides; no need to look further
      for (const root of BUCKETED_ROOTS) {
        const observed = await this.observeRootLayout(dir, root);
        if (observed) { this._cardLayout.set(observed); return; }
      }
    } catch {  }/* leave it unknown -> layoutMode() falls back on the firmware kind */
  }

  /**
   * When the version could not be read off the card, get the answer from the person holding it.
   *
   * The Manager has no device link, so on a card whose image it cannot parse (the original sd2snes
   * firmware.img, a development build, no firmware at all) it would otherwise have to guess which
   * layout the console reads, and a wrong guess is silent: the files are written, the console just
   * never opens that folder. Asking costs one dialog, once per card.
   *
   * Only asked as a last resort, and only when the user is right there:
   *   - a release version settles it -> never ask;
   *   - an answer already given for this card (stored beside the handle) -> reuse it;
   *   - the card's own folders showing a layout -> trust the card, stay quiet;
   *   - reload-resume / reconnect -> no answer, fall back to the safe default (see `layoutForFw`).
   *
   * Dismissing the dialog (scrim, Esc) counts as "2.14 or older": that is the answer that cannot
   * orphan anything, since nothing gets promoted to two-letter folders.
   */
  private async resolveFwAssumption(dir: FileSystemDirectoryHandle, interactive: boolean): Promise<void> {
    this._fwAssume.set(null);
    if (this._fw().kind === 'release') return;

    const stored = await loadCardFwAssume(dir);
    if (stored) { this._fwAssume.set(stored); return; }
    if (this._cardLayout()) return;
    if (!interactive) return;

    // The official firmware is identified. Saying "I could not read the version" there would be a
    // plain lie, and it hides the one fact that explains the question: the stock build knows neither
    // of this fork's layouts, so what matters is which firmware the card is going to run.
    const fw = this._fw();
    const r = await this.dialog.confirm({
      title: this.i18n.translate('store.fwAssumeTitle'),
      body: fw.kind === 'official'
        ? this.i18n.translate('store.fwAssumeBodyOfficial', { version: fw.base })
        : this.i18n.translate('store.fwAssumeBody'),
      confirmLabel: this.i18n.translate('store.fwAssumeNew'),
      cancelLabel: this.i18n.translate('store.fwAssumeOld'),
    });
    this._fwAssume.set(r.ok ? 'buckets' : 'legacy');
  }

  /**
   * Which layout one root is in, or null when it holds nothing conclusive (missing, empty, or only
   * junk). Shallow: stops at the first entry that settles it.
   *
   * `info` is the odd one out, the old layout bucketed it too, by a single character, so there a
   * one-char subdirectory is positive evidence of legacy while in the other roots the legacy shape
   * is a loose file. `sgb/` only ever existed in the new layout, so it settles either way.
   */
  private async observeRootLayout(dir: FileSystemDirectoryHandle, root: string): Promise<LayoutMode | null> {
    const h = await getDirByPath(dir, root);
    if (!h) return null;
    for await (const [name, child] of h.entries()) {
      if (isJunkFile(name)) continue;
      if (child.kind === 'file') return root === INFO_ROOT ? null : 'legacy'; // info never held loose files
      if (name === SGB_SEG) return 'buckets';                                 // new layout only
      if (name === AMBIGUOUS_SEG) continue;                                   // migration quarantine, says nothing
      if (name.length === BUCKET_LEN) return 'buckets';
      if (root === INFO_ROOT && name.length === 1) return 'legacy';
    }
    return null;
  }

  /** Read the card's firmware version and count what the new layout still needs moved. Runs on
   *  connect beside probeBios(). Everything here is read-only. */
  async probeMigration(): Promise<void> {
    if (!this.rootHandle) return;
    try {
      this._fw.set(await readFwVersion(this.rootHandle, getDirByPath));
      const plan = await this.migration.plan(this.rootHandle, this.romIndex(), this.libraryFiles());
      /* Renames count too: they are files the Organizer will fix, and the badge is the only thing
         that tells a user there is anything to fix. What they must not do is drive the dialog's
         "this card uses the old layout" warning -- a stranded patch says nothing about the layout,
         which is why that message reads the plan's `observed` instead (see outOfLayout). */
      this._migrateCount.set(plan.moves.length + plan.renames.length);
      this._junkCount.set(plan.junk.length);
      this._cardLayout.set(plan.observed);   // fallback for layoutMode() when the fw is unreadable
      this._migrateProbed.set(true);
      /* Published so the dialog can render this plan instead of walking the card again. A full
         scan is ~20s on a loaded card, and a run used to trigger four of them: the dialog's
         initial preview, runMigration's own re-derive, this probe, and the dialog's post-run
         refresh. Two are genuinely needed; the other two were pure waiting. */
      this._lastPlan.set(plan);
    } catch (err) {
      console.error('[migration] probe failed', err);
    }
  }

  /** Plan the migration without touching anything (the dialog's preview). */
  async planMigration(): Promise<MigrationPlan | null> {
    return this.rootHandle ? this.migration.plan(this.rootHandle, this.romIndex(), this.libraryFiles()) : null;
  }

  /** Run the migration. Driven through bulkBegin so it inherits the existing beforeunload guard
   *  and the wake lock -- closing the tab mid-run is survivable anyway (every move is independently
   *  durable and the next connect re-plans), but the browser should still ask. */
  async runMigration(opts?: MigrationOptions): Promise<MigrationResult | null> {
    if (!this.rootHandle) return null;
    if (this.bulkBusy()) return null;      // don't stomp an in-flight bulk (shared progress + cancel flag)
    this.cancelImport = false;
    this.card.resetWriteHealth();
    this._migrateResult.set(null);          // a new run supersedes whatever the last one reported
    this._migrateRunning.set(true);
    /* Enter the busy state before planning. Re-deriving the plan walks the whole card and takes
       ~20s on a full one, and canRun()/working() key off this signal -- so without it the button
       stayed live and the dialog looked frozen for the entire scan, with nothing to say it had
       even started. */
    this.bulkBegin(0, this.i18n.translate('migrate.scanning'), false);
    let plan: MigrationPlan;
    try {
      const full = await this.migration.plan(this.rootHandle, this.romIndex(), this.libraryFiles());
      /* Never move files on a card whose firmware is not confirmed to read the new layout -- that
         would hide the user's saves from their own console. Sweeping junk stays available: it is
         safe under every firmware, and it is half the directory-scan cost on its own.
         Patch renames go with the moves: it is 2.15+ that stopped offering a same-stem patch, so
         on anything older the rename would rewrite the user's filenames for no gain at all. */
      plan = this.canMoveFiles() ? full : { ...full, moves: [], conflicts: [], renames: [] };
    } catch (err) {
      this._bulk.set(null);
      this._migrateRunning.set(false);
      this.toast.show(this.i18n.translate('migrate.failed', { error: msg(err) }), 'warn');
      return null;
    }
    /* Deleting the root system folders is work in its own right: a card whose only problem is a
       stale $RECYCLE.BIN must still be allowed to run, or the checkbox would silently do nothing. */
    const sysDirs = opts?.removeSystemDirs ? plan.systemDirs.length : 0;
    if (!plan.moves.length && !plan.junk.length && !plan.emptyDirs && !plan.renames.length && !sysDirs) {
      this._bulk.set(null);
      this._migrateRunning.set(false);
      // ambiguous files are not "nothing to do" -- there is something wrong the user must resolve,
      // and claiming the card is clean would bury it. The dialog lists them; say so here too.
      this.toast.show(this.i18n.translate(plan.ambiguous.length ? 'migrate.ambiguousOnly' : 'migrate.nothingToDo'), plan.ambiguous.length ? 'warn' : 'info');
      return null;
    }
    this.bulkBegin(plan.moves.length + plan.junk.length + plan.renames.length, this.i18n.translate('migrate.running'), true);
    try {
      const res = await this.migration.execute(
        this.rootHandle,
        plan,
        /* The label names the stage, not the file. Moves are metadata renames -- hundreds go by a
           second, so a per-file label was never legible, just a flicker. */
        /* update(), not set(): startedAt must survive, or the live rate/ETA (bulkEta) is dead --
           it needs the epoch bulkBegin stamped, and a fresh object silently drops it. */
        (p) => this._bulk.update((b) => ({
          ...b,
          done: p.done,
          total: p.total,
          label: this.i18n.translate('migrate.stage', {
            stage: this.i18n.translate('migrate.stage_' + p.stage),
            n: p.stageIndex,
            of: p.stageCount,
          }),
          cancelable: true,
        })),
        () => this.cancelImport,
        opts,
      );
      // Re-probe rather than trusting the counters we just changed: the filesystem is the source
      // of truth, and a partial run must leave an honest count behind.
      await this.probeMigration();
      /* Published before the toasts so the result screen is already up when they land -- and so it
         survives the dialog having been closed mid-run. */
      this._migrateResult.set(res);
      if (res.unwritable) {
        this.toast.show(this.i18n.translate('migrate.unwritable', { moved: res.moved, error: this.card.lastError }), 'warn');
      } else if (res.failed.length) {
        this.toast.show(this.i18n.translate('migrate.partial', { moved: res.moved, failed: res.failed.length }), 'warn');
      } else if (res.aborted) {
        this.toast.show(this.i18n.translate('migrate.aborted', { moved: res.moved }), 'warn');
      } else {
        this.toast.show(this.i18n.translate('migrate.doneSummary', { moved: res.moved }), 'ok');
      }
      return res;
    } catch (err) {
      this.toast.show(this.i18n.translate('migrate.failed', { error: msg(err) }), 'warn');
      return null;
    } finally {
      this._migrateRunning.set(false);
      // the card layout changed under us -> re-index the sidecar roots, then refresh what moved
      if (this.rootHandle) {
        this._bulk.set({ done: 0, total: 0, label: this.i18n.translate('migrate.refreshing') });
        try {
          this.clearDirCache();                        // every sidecar just moved: cached bucket dirs are stale
          await this.indexSidecars(this.rootHandle);   // probeOnCard reads these maps -> must land first
          await this.refreshAfterMigrate();
        } catch (err) {
          console.error('[migration] refresh after run failed', err);
        }
      }
      this._bulk.set(null);
    }
  }

  /**
   * Re-derive what a migration actually changed, and nothing else.
   *
   * A full rescan() was the first answer and it is mostly waste: apart from renaming patches the
   * migration only moves files inside /sd2snes, which scanTree skips, so the ROM list, every
   * entry's file/dir handle, the `.cov` next to each ROM and the theme previews cannot have
   * changed. Rebuilding them cost a second walk, a theme re-render and the selection, for
   * guaranteed-identical results.
   *
   * What did change is where every sidecar lives, so this refreshes exactly that:
   *   - the folder set, from one directory walk (entries() only, no file reads, no ROM re-listing),
   *     so a tree built before the run cannot linger;
   *   - the patch list, the one thing out in the ROM tree the run does touch. Without it the next
   *     probe re-plans renames that already happened and the badge never clears;
   *   - each game's on-card badges. The flags are cleared first because probeOnCard only ever sets
   *     'has'/true: without the reset, a sidecar the run pushed into _ambiguous/ would keep showing
   *     as present forever;
   *   - the usage total, which the junk sweep just shrank.
   * The last two run in the background, exactly as on connect. They are the slow half, and nothing
   * on screen has to wait for them.
   */
  private async refreshAfterMigrate(): Promise<void> {
    if (!this.rootHandle) return;
    this.clearDirCache();
    // Every sidecar just moved (and some landed in _ambiguous/): what this session remembers writing is
    // no longer a description of any file at the path it would be looked for at.
    this.ymlMemo.clear();
    const tree: ScannedTree = await scanTree(this.rootHandle);
    this._folders.set(new Set(tree.dirs));
    this.patchFiles = tree.patches;
    // A migration never touches a `.cov` (they sit next to the ROM, outside /sd2snes), but this field
    // must always mirror the walk it came from, otherwise the probe below reads the previous tree's.
    this.covStems = tree.covStems;
    // A queued probe patch surviving into the reset below would resurrect the very 'has' badges
    // the reset exists to erase (a sidecar the run moved to _ambiguous/ would look present forever).
    this.discardPendingUpdates();
    this._entries.update((es) =>
      es.map((e) => ({
        ...e,
        cheats: 'none' as const, cheatList: undefined, cheatsRaw: undefined,
        save: false, state: 'none' as const,
        gcv: 'none' as const, fmv: 'none' as const, snapshot: 'none' as const, info: 'none' as const,
        guides: 0, manual: 'none' as const,
      })),
    );
    void this.probeAllOnCard(this._entries());
    void this.sumUsage();
  }

  /* ---- chip BIOS (user-supplied, validated by CRC32) ---- */

  /** Check which BIOS files exist in /sd2snes/ on the card. */
  async probeBios(): Promise<void> {
    if (!this.rootHandle) { this._biosPresent.set(new Set()); this._biosProbed.set(false); return; }
    const dir = await getDirByPath(this.rootHandle, BIOS_DIR);
    const present = new Set<string>();
    if (dir) {
      await Promise.all(
        BIOS_FILES.map(async (b) => {
          if (await fileExists(dir, b.file)) present.add(b.id);
        }),
      );
    }
    this._biosPresent.set(present);
    this._biosProbed.set(true);
  }

  /** CRC32 (plain, whole-file) of bytes as uppercase 8-hex. */
  private plainCrc(bytes: Uint8Array): string {
    return (crc32(bytes) >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  /** Validate a dropped file's CRC32 against the slot, and on success write it to
   *  /sd2snes/<file>. Returns the computed CRC + outcome (no write on mismatch). */
  async addBios(id: string, file: File): Promise<{ ok: boolean; crc: string; error?: string }> {
    const spec: BiosFile | undefined = BIOS_FILES.find((b) => b.id === id);
    if (!spec) return { ok: false, crc: '', error: 'unknown BIOS slot' };
    if (!this.rootHandle) {
      this.toast.show(this.i18n.translate('store.connectCardFirst'), 'warn');
      return { ok: false, crc: '', error: 'no card' };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const crc = this.plainCrc(bytes);

    // A known-good CRC32 verifies the file outright. Otherwise fall back to the firmware's structural
    // rule (exact size, or ST-010's minimum): the firmware loads DSP/ST-010/BS-X by fixed offsets, not
    // CRC, so a same-sized but unlisted dump is still usable. SGB has no size rule → CRC is mandatory.
    const crcMatch = spec.crc32.length > 0 && spec.crc32.includes(crc);
    const hasSizeRule = !!(spec.size?.length || spec.minSize);
    if (!crcMatch) {
      if (spec.size?.length && !spec.size.includes(bytes.length)) {
        const e = this.i18n.translate('store.biosInvalidSize', { actual: bytes.length, expected: spec.size.join(' / ') });
        this.toast.show(`${spec.file}: ${e}`, 'warn');
        return { ok: false, crc, error: e };
      }
      if (spec.minSize && bytes.length < spec.minSize) {
        const e = this.i18n.translate('store.biosTooSmall', { actual: bytes.length, min: spec.minSize });
        this.toast.show(`${spec.file}: ${e}`, 'warn');
        return { ok: false, crc, error: e };
      }
      if (!hasSizeRule && spec.crc32.length) {
        const e = this.i18n.translate('store.biosCrcMismatch', { crc, expected: spec.crc32.join(' / ') });
        this.toast.show(`${spec.file}: ${e}`, 'warn');
        return { ok: false, crc, error: e };
      }
    }

    try {
      const dir = await this.card.ensureDir(this.rootHandle, BIOS_DIR);
      await this.card.write(dir, spec.file, bytes);
    } catch (err) {
      const e = msg(err);
      this.toast.show(`${spec.file}: ${this.i18n.translate('store.biosWriteFailed', { error: e })}`, 'warn');
      return { ok: false, crc, error: e };
    }
    this._biosPresent.update((s) => new Set(s).add(id));
    const how = crcMatch
      ? this.i18n.translate('store.biosVerifyCrc')
      : spec.size?.length || spec.minSize
        ? this.i18n.translate('store.biosVerifySize')
        : this.i18n.translate('store.biosVerifyNone');
    this.toast.show(this.i18n.translate('store.biosAdded', { file: spec.file, how }), 'ok');
    return { ok: true, crc };
  }

  /** Identify a dropped BIOS automatically (by filename, then CRC32, then a unique size match) and
   *  write it to the right slot. Returns the matched slot id + result, or null (and toasts) when it
   *  can't be recognized. The DSP variants share a size, so filename is what disambiguates them. */
  async addBiosAuto(file: File): Promise<{ id: string; result: { ok: boolean; crc: string; error?: string } } | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const crc = this.plainCrc(bytes);
    const size = bytes.length;
    const name = file.name.toLowerCase();
    // Identify by filename → CRC32 (known-good dump, even if renamed) → a uniquely-sized slot. DSP
    // variants share 8192 bytes, so size alone can't disambiguate them (matches >1 → ignored).
    const bySize = BIOS_FILES.filter((b) => b.size?.includes(size) ?? false);
    const slot =
      BIOS_FILES.find((b) => b.file.toLowerCase() === name) ??
      BIOS_FILES.find((b) => b.crc32.includes(crc)) ??
      (bySize.length === 1 ? bySize[0] : undefined);
    if (!slot) {
      this.toast.show(this.i18n.translate('store.biosNotRecognized', { name: file.name, size }), 'warn');
      return null;
    }
    return { id: slot.id, result: await this.addBios(slot.id, file) };
  }

  /** Background pass: cheap on-card existence checks (no .cov decode, no CRC). */
  private async probeAllOnCard(entries: Entry[]): Promise<void> {
    // One enumeration of /sd2snes/info, then every badge is a Map lookup. It is deliberately a local,
    // not a field: an existence index goes stale the moment anything writes, and a stale "the .fmv is
    // already there" is exactly the bug that makes auto-fill skip a game forever. Built here, read by
    // the probes below it, and unreachable the instant this method returns.
    const info = this.rootHandle ? await indexInfoRoot(this.rootHandle) : new Map<string, InfoSidecars>();
    // Each probe queues its patch (see queueUpdate): one game per signal set meant ~3000 full-library
    // rebuilds + re-tallies on connect. The 100 ms flush still fills the badges in visibly, and the
    // final flush guarantees the last (partial) batch lands even if it was queued a millisecond ago.
    // The pool stays at 8 even though only the size `getFile()` (and the rare legacy `.gd` read) still
    // touch the disk. Those are exactly what benefits from overlapping.
    try { await pool(entries, 8, (e) => this.probeOnCard(e, info)); }
    finally { this.flushEntryUpdates(); }
  }

  private async probeOnCard(e: Entry, info: ReadonlyMap<string, InfoSidecars>): Promise<void> {
    const key = this.key(e.file);
    const stem = key.stem;
    const ik = assetIndexKey(key);
    const patch: Partial<Entry> = {};
    // cover: detect the .cov only (the thumbnail is decoded lazily on scroll)
    if (this.covStems.has(covKey(e.folder, stem))) patch.cover = 'has';
    // cheats: small read for the on-card list + "N on" count
    const cheatsYml = this.cheatText.get(ik) ?? null;
    if (cheatsYml != null) {
      patch.cheats = 'has';
      patch.cheatList = this.cheats.parse(cheatsYml);
      patch.cheatsRaw = cheatsYml;
    }
    // info-screen siblings: /sd2snes/info/[sgb/]<BB>/<stem>.{gcv,fmv,yml,gss,gd,man}, all from the
    // one enumeration above, so this game costs zero directory lookups and zero existence probes.
    const si = infoSidecarsFor(info, key);
    if (si?.gcv) patch.gcv = 'has'; // game info paletted cover
    if (si?.fmv) patch.fmv = 'has'; // animated clip (prévia)
    if (si?.yml) patch.info = 'has'; // game info (informações)
    // snapshot: the standalone .gss (static screenshot); else the legacy .gd shot region (back-compat).
    // The .gd is the one thing the index cannot answer. Whether a shot region is present is inside the
    // bytes, so it still reads the file, but now only for the handful of games that actually have one.
    if (si?.gss) patch.snapshot = 'has';
    else if (si?.gd) {
      const infoDir = await this.getDir(infoDirFor(key));
      const gd = infoDir ? await readFileFrom(infoDir, stem + '.gd') : null;
      if (gd && gdHasSnapshot(gd)) patch.snapshot = 'has';
    }
    // guides (.man): count present slots among <stem>.man + <stem>.0N.man (N=2..8). Slot 0 is the
    // Official GameDB manual (autofill-owned, see `manual` below); slots 2..8 are user-supplied and
    // never touched by autofill (see models.ts Entry.guides).
    patch.guides = si ? si.man.size : 0;
    if (si?.man.has(0)) patch.manual = 'has';
    if (this.saveKeys.has(ik)) patch.save = true;
    if (this.stateKeys.has(ik)) patch.state = 'has';
    // ROM byte size from cheap file metadata (getFile() reads no content), so the game info file shows the real
    // size even for games surfaced from on-card sidecars, before any CRC identify (which used to be the
    // Only thing that set `size`, leaving it 0 (the "· 0 KB" bug) for not-yet-identified ROMs).
    if (!e.size && e.fileHandle) {
      try { const sz = (await e.fileHandle.getFile()).size; if (sz) patch.size = sz; } catch {  }/* unreadable → leave 0 */
    }
    if (Object.keys(patch).length) this.queueUpdate(e.id, patch); // batched: probeAllOnCard flushes at the end
  }

  /** Enumerate the three sidecar roots once (walking their <BB>/ subdirectories) so probeOnCard
   *  needs no per-game directory lookups. Tolerates both layouts, so a half-migrated card still
   *  indexes correctly. Re-run after a migration, since every path just moved.
   *
   *  /sd2snes/info gets the same treatment but is not kept in a field, see indexInfoRoot. These
   *  three are long-lived because the app maintains them as it writes (writeCheats, delStates...);
   *  info is written from a dozen places, so only a throwaway snapshot can be trusted. */
  private async indexSidecars(dir: FileSystemDirectoryHandle): Promise<void> {
    this.cheatText = new Map();
    this.saveKeys = new Set();
    this.stateKeys = new Set();
    // All three go through bucketKeyForFile: it is the one place that knows a sidecar's name is not
    // its ROM's stem (slot digits, .NN.man, .NN.srm). Hand-rolling that per root is how the index
    // and the migration planner end up disagreeing about which game a file belongs to.
    await indexSidecarRoot(dir, CHEATS_ROOT, (name, text, sgb) => {
      if (name.toLowerCase().endsWith('.yml')) this.cheatText.set(assetIndexKey({ stem: bucketKeyForFile(name), sgb }), text);
    }, { withText: true });
    await indexSidecarRoot(dir, SAVES_ROOT, (name, _text, sgb) => {
      if (name.toLowerCase().endsWith('.srm')) this.saveKeys.add(assetIndexKey({ stem: bucketKeyForFile(name), sgb }));
    });
    await indexSidecarRoot(dir, STATES_ROOT, (name, _text, sgb) => {
      if (name.toLowerCase().endsWith('.state')) this.stateKeys.add(assetIndexKey({ stem: bucketKeyForFile(name), sgb }));
    });
  }

  /* ---- directory cache (the main-thread twin of autofill.worker's getDir) ---- */

  /** Resolve an existing directory under the card root (null when absent or when no card is open). */
  private getDir(path: string): Promise<FileSystemDirectoryHandle | null> {
    const root = this.rootHandle;
    if (!root) return Promise.resolve(null);
    return this.cachedDir('r:' + path, () => getDirByPath(root, path));
  }

  /** Resolve a directory under the card root, creating it as needed (via CardWriter, so concurrent
   *  callers still serialize + retry). Caching the promise also means a bucket dir is created once
   *  per run instead of once per game. */
  private async ensureDir(path: string): Promise<FileSystemDirectoryHandle> {
    const root = this.rootHandle;
    if (!root) throw new Error('no card connected');
    const cache = this.dirCache;
    const d = await this.cachedDir('c:' + path, async () => {
      const h = await this.card.ensureDir(root, path);
      // The directory now exists, so a later read of the same path must not answer from the `null` an
      // earlier miss cached (nor walk it again). Written into the same map generation this call was
      // issued against, so a clearDirCache() that lands mid-flight is not undone.
      cache.set('r:' + path, Promise.resolve(h));
      return h;
    });
    return d!;
  }

  /**
   * Only a resolved handle is memoized. Absence must never be, because the app does not own the card
   * alone: the auto-fill worker creates bucket directories on its own thread. Opening a game before a
   * run would cache "sd2snes/info/XX does not exist"; the worker then creates it and writes the game info file,
   * and every later main-thread read (persistSyncTokens, readInfoYml, readFmvBytes, listGuides,
   * delInfo/delPreview) would still answer from that stale null, the sync_* tokens never get stamped,
   * so the next "Atualizar" re-downloads the whole .s2pkg, and the game info file/preview look gone until a
   * reload. A miss simply costs the 2-4 getDirectoryHandle calls it always did, and only for a bucket
   * that genuinely is not there.
   *
   * The entry is still installed while in flight, so a burst of games sharing a bucket resolves once.
   */
  private cachedDir(k: string, resolve: () => Promise<FileSystemDirectoryHandle | null>): Promise<FileSystemDirectoryHandle | null> {
    const cache = this.dirCache; // pinned: clearDirCache() swaps the map, it does not empty this one
    let p = cache.get(k);
    if (!p) {
      // A rejection is not cached either: ensureDir can fail transiently (the write queue's retry gave
      // up, the card was yanked), and a poisoned entry would fail every later call for the session.
      p = resolve().then(
        (d) => { if (!d) cache.delete(k); return d; },
        (err) => { cache.delete(k); throw err; },
      );
      cache.set(k, p);
    }
    return p;
  }

  /** Drop every cached handle. Called wherever the root changes or the tree is reshuffled wholesale. */
  private clearDirCache(): void {
    this.dirCache = new Map();
  }

  /** Resolve (or create) the bucket directory a game's sidecar lives in, under `root`. */
  private async bucketDir(root: string, key: AssetKey, create = false): Promise<FileSystemDirectoryHandle | null> {
    if (!this.rootHandle) return null;
    const path = bucketDirFor(root, key);
    return create ? this.ensureDir(path) : this.getDir(path);
  }

  /** Lazily decode an entry's on-card .cov into a thumbnail, called when its
   *  cover scrolls into view. Idempotent + de-duplicated. */
  async ensureThumb(e: Entry): Promise<void> {
    const cur = this.entriesById().get(e.id);
    if (!cur || cur.thumbUrl || cur.cover !== 'has' || !cur.dirHandle) return;
    if (this.thumbPending.has(cur.id)) return;
    this.thumbPending.add(cur.id);
    try {
      const bytes = await readFileFrom(cur.dirHandle, stemOf(cur.file) + '.cov');
      if (bytes) this.update(cur.id, { thumbUrl: covToDataUrl(bytes) });
    } catch {
      /* unreadable / bad .cov → keep the placeholder */
    } finally {
      this.thumbPending.delete(cur.id);
    }
  }

  /* ---- intentional identify (CRC32 + gamedb; fetches the server cover) ---- */

  /* A card-wide "identify all" used to live in the topbar. It was redundant: auto-fill at the root
     with no filter already identifies exactly the same set as its analyze phase (see startAutoFill),
     and so does "generate covers". Identification in bulk now always rides along with the action
     that needs it, nothing asks the user to run it as a separate step. */

  /** Identify one ROM: CRC32 → gamedb lookup → server cover + match status.
   *
   *  `refresh` is sugar for `freshWithin: 0`, no cached answer can satisfy it, so the server is always
   *  asked. It is set by the explicit "Identificar" action only: clicking it means "ask the server about
   *  this ROM", and answering from a week-old cached lookup would make the button look broken. Every
   *  implicit call (genCover, the auto-fill pre-pass, the bulk fallback) leaves it off and takes the
   *  cache; `freshWithin` (ms) is the middle ground for a caller that needs recent, not necessarily new. */
  async identify(e: Entry, opts: { refresh?: boolean; freshWithin?: number } = {}): Promise<void> {
    if (!e.fileHandle) return;
    try {
      // The CRC comes from the cache when the file is untouched. This path used to always re-read the
      // whole ROM (up to 64 MB), even right after the analyze pass had already checksummed it, which
      // is exactly what the (size, mtime)-validated cache exists to avoid. getCrcCached reads the one
      // key: the per-game fallback loops (bulkGenCovers, the auto-fill pool) land here thousands of times,
      // and loadCrcCache()'s whole-store getAll() per game would be quadratic in the library size.
      const f = await e.fileHandle.getFile();
      const key = crcKey(e.folder, e.file);
      const hit = await getCrcCached(key);
      let crc: string;
      if (hit && hit.size === f.size && hit.mtime === f.lastModified) {
        crc = hit.crc;
      } else {
        crc = headerlessCrc32(new Uint8Array(await f.arrayBuffer()), e.file);
        void saveCrcCache([[key, { size: f.size, mtime: f.lastModified, crc }]]);
      }
      // Then the gamedb cache. Keys are stored uppercase, so read with an uppercased key. A lowercase
      // CRC from anywhere would otherwise miss 100% of the time, silently and for free.
      const maxAge = opts.refresh ? 0 : opts.freshWithin;
      const cached = maxAge === 0 ? undefined : (await loadGamedbCache([crc])).get(crc.toUpperCase());
      let match: GameMatch | null | undefined; // undefined = not resolved yet (null is a valid no-match)
      if (cached && isFresh(cached, Date.now(), maxAge)) {
        // A record stored under an older server contract can make resolveRaw throw. That's a miss,
        // not a failure: fall through to the server rather than failing the whole identify.
        try { match = this.gamedb.resolveRaw(cached.game, e.region, crc); }
        catch (err) { console.warn('[identify] unusable cached record for', crc, '— re-asking', err); }
      }
      if (match === undefined) {
        // A throw here (network/CORS/5xx) is handled below and caches nothing; a 404 is an answer and
        // is cached as a negative, so an unmatched ROM stops costing a request on every visit.
        const game = await this.gamedb.lookupRaw(crc);
        void saveGamedbCache([[crc, game]]);
        match = this.gamedb.resolveRaw(game, e.region, crc);
      }
      this.applyIdentify(e, crc, f.size, match);
    } catch (err) {
      console.error('[identify] failed for', e.file, err);
      const m = msg(err);
      // A transient network/CORS/5xx failure must not mark the ROM as identified. Otherwise
      // later "Generate covers" runs see identified:true with no match and report "nothing on
      // GameDB" without ever retrying the lookup. Only a completed lookup (match, or a real
      // 404 no-match which doesn't throw) sets identified.
      const transient = /failed to fetch|networkerror|load failed|cors|timeout|aborted|gamedb 5\d\d|429/i.test(m);
      if (!transient) this.update(e.id, { identified: true });
      if (/failed to fetch|networkerror|load failed|cors/i.test(m)) this.warnCors();
    } finally {
      // applyIdentify only queues its patch (it is shared with the bulk path). Every single-ROM caller
      // re-reads the entry right after awaiting this, `cur = entriesById().get(g.id)` in genCover,
      // encodeFmvFromVideo, bulkGenCovers, so the match has to be visible now.
      this.flushEntryUpdates();
    }
  }

  /** Apply a resolved gamedb match to an entry: metadata + cover availability + cheats availability
   *  (cheats come straight from the match, so no separate per-CRC probe). Shared by single + batch. */
  private applyIdentify(e: Entry, crc: string, size: number, match: GameMatch | null): void {
    // Queued, and a single patch per game: this used to be two update() calls (the second one re-read
    // the entry just to decide `cheats`), i.e. two full-library rebuilds per identified ROM, 6000 of
    // them for a 3000-ROM analyze. Callers that need the result immediately flush: identify() does it
    // for the single-ROM paths, identifyEntries() at the end of the batch.
    this.queueUpdate(e.id, (gg) => {
      const p: Partial<Entry> = { crc, size, identified: true };
      if (match) {
        p.matched = true;
        p.gamedbId = match.id;
        if (match.title) p.title = match.title;
        p.coverUrl = match.coverUrl ?? undefined;
        p.videoUrl = match.videoUrl ?? undefined;
        p.screenshotUrl = match.screenshotUrl ?? undefined;
        p.manualUrl = match.manualUrl ?? undefined; // primary GameDB manual (.man, ready w/ zoom)
        p.manuals = match.manuals ?? undefined; // all manuals for this facet, autofill writes each
        p.packageUrl = match.packageUrl ?? undefined;
        p.packageBytes = match.packageBytes ?? undefined; // .s2pkg download size (for the fill estimate)
        p.packageNoAudioUrl = match.packageNoAudioUrl ?? undefined; // legacy: preview without audio (embedded-pcm packages)
        p.packageNoAudioBytes = match.packageNoAudioBytes ?? undefined;
        p.pcmUrl = match.pcmUrl ?? undefined; // separated audio (new packages); fetched only when audio is wanted
        p.pcmBytes = match.pcmBytes ?? undefined;
        p.metaRev = match.metaRev ?? undefined; // info/.yml staleness token (stored on card as sync_meta)
        p.developer = match.developer;
        p.publisher = match.publisher;
        p.releaseYear = match.releaseYear;
        p.players = match.players;
        p.genre = match.genre;
        p.specialChip = match.specialChip;
        p.description = match.description;      // canonical English
        p.descriptions = match.descriptions;    // one per translated language (written as description_<lang>)
        p.dbCheats = match.cheats ?? undefined; // reserve the cheats from the lookup (auto-fill writes them, no re-fetch)
        // Reclassify by the GameDB platform when it disagrees with the extension scan, covers
        // Satellaview ROMs shipped as .sfc/.smc (bsx), and NES/SMS/Atari 2600 dumps carrying an odd
        // extension. SNES/GB/GBC/SGB are left alone.
        if (match.platform === 'bsx') p.system = 'BSX';
        else if (match.platform === 'nes') p.system = 'NES';
        else if (match.platform === 'sms') p.system = 'SMS';
        else if (match.platform === 'a26') p.system = 'A26';
      }
      // cover 'available' only when there's a server cover and no .cov on card
      if (gg.cover !== 'has' && gg.cover !== 'custom') {
        p.cover = match && match.coverUrl ? 'available' : 'none';
      }
      // cheats availability from the gamedb match (when not already on card), derived here, from the
      // same `gg`, instead of a second update() that re-read the entry. Identical result: the patch
      // above never touches `cheats`, so pre- and post-patch `gg.cheats` are the same value.
      if (match?.cheatsAvailable && gg.cheats !== 'has') p.cheats = 'available';
      return p;
    });
  }

  /** Identify many ROMs in batches of IDENTIFY_BATCH, one gamedb request per chunk (cheats ride
   *  along in the response). Shared by the auto-fill analysis and bulk cover-gen so neither falls
   *  back to one-request-per-ROM. Returns how many were applied. `shouldStop`
   *  lets each caller wire its own cancel (the bulk flag, or the auto-fill epoch).
   *
   *  Pipelined as producer/consumer: stage A checksums chunks (in core/crc.worker.ts, streaming, so it
   *  survives a backgrounded tab) into a short queue, stage B keeps up to LOOKUP_CONCURRENCY batch
   *  lookups in flight, stage C applies each chunk's results as they land. It used to be one sequential
   *  loop, so each half of the work sat idle while the other ran. Chunks now complete out of order,
   *  which changes nothing, since applyIdentify is per entry and coalesces its patches. The CRC cache
   *  keyed by (path, size, mtime), the gamedb cache partition and the bisect-on-failure are unchanged.
   *
   *  `freshWithin` (ms) caps how old a cached gamedb answer may be for this call; the effective limit is
   *  min(TTL, freshWithin). `refresh` is sugar for `freshWithin: 0`, which no record satisfies, so
   *  everything is re-asked. Auto-fill's Atualizar/Substituir passes minutes instead: its sync tokens
   *  only have to be newer than the card, so re-running after a half-failed pass costs nothing rather
   *  than another 60-90s of network.
   *
   *  `assumeCrc` skips stage A for any entry that already carries a `crc`: no `getFile()`, no worker, no
   *  checksum cache, the known CRC goes straight into the gamedb partition. Only for callers that know
   *  the entries were checksummed at analysis time in this same session, such as auto-fill's pre-run
   *  refresh. A ROM swapped in the Finder while the dialog sat open would still be identified by the old
   *  CRC, but the whole plan was built on that same identity anyway, and a rescan clears `crc`. Everyone
   *  else re-derives it, because the (size, mtime) check in stage A is what notices a ROM replaced
   *  behind the app's back. */
  private async identifyEntries(
    targets: Entry[],
    opts: {
      shouldStop?: () => boolean; onProgress?: (done: number) => void;
      refresh?: boolean; freshWithin?: number; assumeCrc?: boolean;
    } = {},
  ): Promise<number> {
    const { shouldStop, onProgress, assumeCrc } = opts;
    const maxAge = opts.refresh ? 0 : opts.freshWithin;
    let done = 0, failed = 0, dbHits = 0, assumed = 0;
    // CRC32 needs every byte, so identifying a card means reading the whole card (~12 min for 32 GB),
    // and it used to happen again every session. Cached checksums make a re-analyze read only what is
    // new or genuinely modified; the first pass on a card still pays full price.
    // Loaded as one whole-store getAll(), so don't read it at all when nothing will be checksummed
    // (`assumeCrc` and every entry already carrying its CRC, the auto-fill refresh pass).
    const willHash = !assumeCrc || targets.some((e) => !e.crc);
    const cache: Map<string, { size: number; mtime: number; crc: string }> =
      willHash ? await loadCrcCache() : new Map();
    const fresh: [string, { size: number; mtime: number; crc: string }][] = [];
    let hits = 0;

    // Cancel. `shouldStop` is a poll, so a request already in flight used to keep going until it
    // answered or hit net.js's 30s timeout. Pressing Stop looked like it did nothing for half a minute.
    // A controller driven by that same poll aborts the requests themselves. It can only make a lookup
    // Fail, and a failed lookup is never written to the gamedb cache (step 4 below), so cancelling can
    // never poison it with false negatives.
    const ctl = new AbortController();
    const stopped = (): boolean => {
      if (!shouldStop?.()) return false;
      if (!ctl.signal.aborted) ctl.abort(new DOMException('identify cancelled', 'AbortError'));
      return true;
    };

    // Wake-up channel between the stages. Any state change (chunk queued, slot freed, producer done,
    // cancel) swaps in a fresh promise and resolves the old one, so a waiter that captured `tick` before
    // re-testing its condition can never miss a wakeup, the one way this shape deadlocks.
    let tick!: Promise<void>, go!: () => void;
    const resetTick = (): void => { tick = new Promise<void>((r) => { go = r; }); };
    resetTick();
    const bump = (): void => { const g = go; resetTick(); g(); };

    const queue: { e: Entry; crc: string; size: number }[][] = [];
    let producing = true;
    // Spawned on the first checksum miss, so a warm re-analyze (every CRC cached) never pays for a
    // worker it has no bytes to give it.
    let crcWorker: CrcWorkerClient | null = null;
    let crcSpawned = false;
    const crcOf = (): CrcWorkerClient | null => {
      if (!crcSpawned) { crcSpawned = true; crcWorker = CrcWorkerClient.spawn(); }
      return crcWorker;
    };
    const killCrc = (): void => { crcWorker?.kill(); }; // never spawns one just to stop it
    // Nothing else polls `shouldStop` while both stages are parked on I/O, so the cancel has to be
    // noticed by a clock: it turns the flag into the abort + wakes the stage loops. (One waiter is
    // out of its reach: a getFile() hung on a yanked card, same unescapable await the old loop had.)
    const watchdog = setInterval(() => { if (stopped()) { killCrc(); bump(); } }, 200);

    /** Stage A, checksum chunk by chunk and hand each finished chunk to the lookups. The CRC of a chunk
     *  and the POST of the previous one now overlap; before, each waited for the other. */
    const produce = async (): Promise<void> => {
      try {
        for (let i = 0; i < targets.length; i += IDENTIFY_BATCH) {
          // Backpressure: don't run the whole card through the CRC stage while the lookups are still on
          // chunk 3 (which is exactly what an all-checksums-cached re-analyze would do).
          for (;;) {
            const t = tick;
            if (stopped() || queue.length < IDENTIFY_QUEUE_MAX) break;
            await t;
          }
          if (stopped()) break;
          const chunk = targets.slice(i, i + IDENTIFY_BATCH);
          const triples: { e: Entry; crc: string; size: number }[] = [];
          // 0) `assumeCrc`: the entry's own CRC is taken as current, so this game never touches the card
          //    at all. This is the step that turns the auto-fill refresh from a full library pass into a
          //    handful of lookups. `size` comes off the Entry (the on-card probe fills it from file
          //    Metadata, and every previous applyIdentify wrote back exactly the size it had read), and
          //    the only consumer is applyIdentify's own `size` patch, no caller wants a size read fresher
          //    than the checksum it belongs to.
          let toHash = chunk;
          if (assumeCrc) {
            toHash = [];
            for (const e of chunk) {
              if (e.crc) { triples.push({ e, crc: e.crc, size: e.size }); assumed++; }
              else toHash.push(e);
            }
          }
          // 1a) metadata only: getFile() does not read the contents, so a cache hit costs nothing beyond
          //     this call. Only a miss goes on to pull the bytes.
          const misses: { e: Entry; key: string; f: File; fh: FileSystemFileHandle }[] = [];
          await pool(toHash, 6, async (e) => {
            if (stopped() || !e.fileHandle) return;
            const fh = e.fileHandle;
            const f = await fh.getFile();
            const key = crcKey(e.folder, e.file);
            const hit = cache.get(key);
            if (hit && hit.size === f.size && hit.mtime === f.lastModified) {
              hits++;
              triples.push({ e, crc: hit.crc, size: f.size });
              return;
            }
            misses.push({ e, key, f, fh });
          });
          // 1b) the misses have to be read. Off the main thread and streamed (core/crc.worker.ts): a
          //     backgrounded tab keeps full speed, the UI never sees a 200ms hash of a 64 MB ROM, and no
          //     ROM is ever materialized whole. `size`/`mtime` come back from the File the worker really
          //     read, so the cached record always describes the bytes behind the checksum.
          if (misses.length && !stopped()) {
            const w = crcOf();
            const results = w ? await w.run(misses.map((m) => ({ name: m.e.file, fileHandle: m.fh }))) : [];
            const inline: typeof misses = [];
            for (let k = 0; k < misses.length; k++) {
              const r = results[k];
              if (!r || r.error || !r.crc || r.size == null || r.mtime == null) { inline.push(misses[k]); continue; }
              fresh.push([misses[k].key, { size: r.size, mtime: r.mtime, crc: r.crc }]);
              triples.push({ e: misses[k].e, crc: r.crc, size: r.size });
            }
            // No worker (or a job it couldn't do) → the original main-thread path, unchanged apart from
            // a read pool that mirrors the worker's.
            if (inline.length) await pool(inline, CRC_FALLBACK_CONCURRENCY, async (m) => {
              if (stopped()) return;
              const crc = headerlessCrc32(new Uint8Array(await m.f.arrayBuffer()), m.e.file);
              fresh.push([m.key, { size: m.f.size, mtime: m.f.lastModified, crc }]);
              triples.push({ e: m.e, crc, size: m.f.size });
            });
          }
          if (stopped()) break;
          // Flush per chunk: a run cut short (cancel, dropped connection, closed tab) still keeps the
          // checksums it already paid for.
          if (fresh.length >= IDENTIFY_BATCH) { void saveCrcCache(fresh.splice(0)); }
          queue.push(triples);
          bump();
        }
      } catch (err) {
        // The CRC stage dying outright (card yanked) must not strand the consumer waiting for chunks
        // that will never come, nor skip the end-of-pass flush. Report it; whatever was already
        // checksummed still gets looked up and applied.
        console.error('[identify] crc stage failed', err);
      } finally {
        producing = false;
        bump();
      }
    };

    /** Stages B+C for one chunk: partition against the gamedb cache, look up the rest, apply what lands.
     *  Byte-for-byte the old steps 2-4, only when it runs changed. */
    const runChunk = async (triples: { e: Entry; crc: string; size: number }[]): Promise<void> => {
      // 2) split the chunk against the gamedb cache: a CRC the server already answered for (this week
      //    for a match, sooner for a no-match) needs no request. ResolveRaw is pure and local, so
      //    those games are applied at memory speed. This is what turns a 60-90s startup into an
      //    instant one; `maxAge` 0 opts out and re-asks everything.
      const now = Date.now();
      // Keys are stored uppercase, read with an uppercased key so a lowercase CRC can't miss silently.
      const cached = maxAge === 0 ? new Map() : await loadGamedbCache(triples.map((t) => t.crc));
      const needsLookup: typeof triples = [];
      for (const t of triples) {
        const rec = cached.get(t.crc.toUpperCase());
        if (!rec || !isFresh(rec, now, maxAge)) { needsLookup.push(t); continue; }
        // Per entry: a record stored under an older server contract can make resolveRaw throw. One bad
        // row must not take the other 49 games of the chunk down with it, treat it as a miss and let
        // the lookup below overwrite it.
        let match: GameMatch | null;
        try { match = this.gamedb.resolveRaw(rec.game, t.e.region, t.crc); }
        catch (err) { console.warn('[identify] unusable cached record for', t.crc, '— re-asking', err); needsLookup.push(t); continue; }
        dbHits++;
        this.applyIdentify(t.e, t.crc, t.size, match);
        onProgress?.(++done);
      }
      // 3) one batch lookup for what's left, apiFetch already retries transient failures, so a
      //    throw here means it stayed broken. Split and retry the halves before giving up: when one
      //    bad CRC is what the server chokes on, whole-batch retries fail forever and take 49 healthy
      //    games down with it; bisecting isolates the bad one and identifies the rest.
      const applied = await this.lookupChunk(needsLookup, stopped, ctl.signal);
      // 4) apply each result (an un-identified game is left untouched so a re-run retries it) and
      //    write it through to the cache. A CRC absent from `applied` is one whose request failed
      //    (bisected down to a single failing call, or aborted by a cancel). It must not be stored as a
      //    negative, or a network blip would pin "not in the GameDB" onto a real game for the next 60
      //    hours. Only an explicit `null` (the batch answered 200 and this CRC wasn't in the response)
      //    is one.
      const writes: [string, unknown][] = [];
      for (const t of needsLookup) {
        const raw = applied.get(t.crc);
        if (raw === undefined) { failed++; continue; } // lookup never answered for this one
        // Same guard as the cached path above: a payload that won't resolve must not take the whole
        // batch down (and is not worth persisting, the next run just re-asks the server for it).
        let m: GameMatch | null;
        try { m = this.gamedb.resolveRaw(raw, t.e.region, t.crc); }
        catch (err) { console.warn('[identify] unusable payload for', t.crc, err); failed++; continue; }
        writes.push([t.crc, raw]);
        this.applyIdentify(t.e, t.crc, t.size, m);
        onProgress?.(++done);
      }
      void saveGamedbCache(writes); // per chunk, so a run cut short keeps what it already paid for
    };

    /** Consumer: keeps up to LOOKUP_CONCURRENCY chunks in flight. Chunks finish out of order and that is
     *  fine. ApplyIdentify is per entry and queueUpdate coalesces the patches either way. */
    const consume = async (): Promise<void> => {
      const inflight: Promise<void>[] = [];
      let running = 0;
      for (;;) {
        const t = tick;
        if (stopped()) break;
        if (queue.length && running < LOOKUP_CONCURRENCY) {
          const next = queue.shift() as { e: Entry; crc: string; size: number }[];
          bump(); // a queue slot just freed, let the CRC stage refill it
          running++;
          // Same rule as pool()'s per-item guard: one chunk that blows up must not reject the whole
          // pass (and must not sit as an unhandled rejection until allSettled picks it up).
          inflight.push(runChunk(next)
            .catch((err) => { console.error('[identify] chunk failed, continuing', err); })
            .finally(() => { running--; bump(); }));
          continue;
        }
        if (!queue.length && !producing && !running) break;
        await t;
      }
      // Never leave a lookup running past the return: the callers read the entries immediately after.
      await Promise.allSettled(inflight);
    };

    try {
      await Promise.all([produce(), consume()]);
    } finally {
      clearInterval(watchdog);
      killCrc();
    }
    // Land every queued applyIdentify patch before returning (also on the `break` paths): both callers
    // read the entries straight after, startAutoFill re-filters the scope and tallies fillCounts,
    // bulkGenCovers re-reads each target expecting the match to be there.
    this.flushEntryUpdates();
    await saveCrcCache(fresh);
    if (assumed) console.info(`[identify] ${assumed}/${targets.length} checksums taken from the entries (card untouched)`);
    if (hits) console.info(`[identify] ${hits}/${targets.length} checksums from cache (card reads avoided)`);
    if (dbHits) console.info(`[identify] ${dbHits}/${targets.length} gamedb answers from cache (requests avoided)`);
    // Never let a network hiccup masquerade as "these games aren't in the GameDB": say how many were
    // skipped so the user knows a re-run will pick them up. Not after a cancel, though: cancelling
    // mid-chunk leaves that chunk unanswered by construction, and reporting it as a lookup failure
    // turns the user's own Stop into an error message.
    if (failed && !shouldStop?.()) {
      console.warn(`[identifyEntries] ${failed} game(s) could not be identified (lookup failed)`);
      this.toast.show(this.i18n.translate('store.identifyPartial', { count: failed }), 'warn');
    }
    return done;
  }

  /** Batch raw lookup with bisect-on-failure. Returns crc → the server's game JSON, or `null` when the
   *  request succeeded and that CRC simply has no game. A crc absent from the map is one whose request
   *  failed even after retries + splitting. The caller must distinguish the two (a failure is not a
   *  no-match, and must never be cached as one).
   *
   *  Raw, not resolved: the caller caches exactly what the server said (see lib/gamedb-cache.js) and
   *  resolves it locally, which is pure and free.
   *
   *  `signal` aborts the request itself, so a cancel doesn't have to wait out net.js's 30s per-attempt
   *  timeout. An abort is deliberately reported the same way any other failure is. The CRC is simply
   *  Absent from the map. Because that is the one shape the caller already refuses to cache. */
  private async lookupChunk(
    triples: { e: Entry; crc: string; size: number }[],
    shouldStop?: () => boolean,
    signal?: AbortSignal,
  ): Promise<Map<string, unknown>> {
    if (!triples.length || shouldStop?.() || signal?.aborted) return new Map();
    try {
      const games = await this.gamedb.lookupRawMany(triples.map((t) => t.crc), { signal });
      // Every CRC in a batch that answered gets an entry, `null` for the ones the response omitted.
      return new Map(triples.map((t) => [t.crc, games[t.crc.toUpperCase()] ?? null]));
    } catch (err) {
      // A cancel is not a failure: don't bisect it (that would fire the halves against an already-dead
      // signal) and don't log it as a lookup error, the user asked for this.
      if (signal?.aborted) return new Map();
      if (/failed to fetch|networkerror|load failed|cors/i.test(msg(err))) this.warnCors();
      if (triples.length === 1) {
        console.error('[identifyEntries] lookup failed for', triples[0].e.file, err);
        return new Map();
      }
      const mid = Math.ceil(triples.length / 2);
      const [a, b] = await Promise.all([
        this.lookupChunk(triples.slice(0, mid), shouldStop, signal),
        this.lookupChunk(triples.slice(mid), shouldStop, signal),
      ]);
      return new Map([...a, ...b]);
    }
  }

  /** "Atualizar dados do GameDB": forget every cached lookup and re-ask the server about the whole
   *  library. The cache is what makes a session start instantly, and its TTLs are the normal way it
   *  stays current. This is the manual escape hatch for the day the GameDB gains the game (or the
   *  cover) you are waiting for and you do not want to wait out the TTL. */
  async refreshGamedb(): Promise<void> {
    if (this.bulkBusy()) return;
    const targets = this._entries().filter((g) => !!g.fileHandle);
    if (!targets.length) { this.toast.show(this.i18n.translate('store.gamedbRefreshEmpty'), 'info'); return; }
    await clearGamedbCache();
    this.cancelImport = false;
    this.bulkBegin(targets.length, this.i18n.translate('store.gamedbRefreshing'), true);
    try {
      // refresh:true as well as the clear above: the clear only empties the store, and a chunk that
      // finished before it would otherwise be readable again from what this very run writes back.
      const n = await this.identifyEntries(targets, {
        refresh: true,
        shouldStop: () => this.cancelImport,
        onProgress: (d) => this.bulkProgress(d),
      });
      this.toast.show(
        this.cancelImport
          ? this.i18n.translate('store.gamedbRefreshCancelled', { count: n })
          : this.i18n.translate('store.gamedbRefreshed', { count: n }),
        this.cancelImport ? 'info' : 'ok',
      );
    } finally {
      this._bulk.set(null);
    }
  }

  private warnCors(): void {
    if (this.corsWarned) return;
    this.corsWarned = true;
    this.toast.show(this.i18n.translate('store.gamedbUnreachable'), 'warn');
  }

  /** Instant load of the mock fixture (the "Try with sample ROMs" path). */
  demo(): void {
    this.loadMock();
    this.toast.show(this.i18n.translate('store.sampleRomsLoaded', { count: this._entries().length }));
  }

  /** Forget the connected card and return to the connect screen. If a copy/write is in flight we must
   *  Stop it first: the auto-fill worker holds its own copy of `rootHandle`, so just nulling ours below
   *  wouldn't stop it, it (and the main-thread bulk loops) would keep writing, and the OS then refuses
   *  to unmount the SD until the tab is closed (the "macOS won't let me eject during a copy" symptom).
   *  So confirm, then `cancelBulk()` (cooperative cancel: lets in-flight writes close cleanly and stops
   *  the worker), before dropping the handle. */
  async eject(): Promise<void> {
    if (this.working()) {
      const r = await this.dialog.confirm({
        title: this.i18n.translate('store.ejectBusyTitle'),
        body: this.i18n.translate('store.ejectBusyBody'),
        confirmLabel: this.i18n.translate('topbar.eject'),
        danger: true,
      });
      if (!r.ok) return;
      this.cancelBulk(); // signal the write worker + main-thread bulk loops to stop before we forget the card
    }
    this._connected.set(false);
    this._selId.set(null);
    this._scan.set(null);
    this.rootHandle = null;
    this.clearDirCache();
    this.cheatText = new Map();
    this.saveKeys = new Set();
    this.stateKeys = new Set();
    this.covStems = new Set();
    this._folders.set(new Set());
    this.resetCardProbes();
    this.patchFiles = [];
    this._rootNameKey.set('store.rootLibrary');
    this._rootName.set(this.i18n.translate('store.rootLibrary'));
    this.discardPendingUpdates(); // background probes may still have patches queued for the old card
    this._entries.set([]);
    this._themeFiles.set([]);
    this._activeSkin.set(null);
    this._themePreviews.set(new Map());
    this.themeRenders.clear();
    this.ymlMemo.clear(); // keyed by entry id, and the library is going away with the card
    // Reset the whole view so a freshly reconnected card isn't hidden by stale folder/filter/selection.
    this._cwd.set('');
    this._query.set('');
    this._sysFilter.set('all');
    this._statusFilter.set('all');
    this._recursive.set(false);
    this.clearSel();
    void clearCardHandle(); // user explicitly ejected → don't offer to reconnect this one
    this._reconnectHandle.set(null);
  }

  /**
   * Everything the previous card's probes left behind, the firmware version and the layout read off
   * it, the migration/junk counts and the plan they produced, and the BIOS answer. Called by both
   * `eject()` and `openCard()`, and that second caller is the whole point.
   *
   * The probes are fire-and-forget, so old answers outlive the old card. Pointing the Manager at
   * another folder used to leave every one of these signals holding the previous folder's answer until
   * that folder's probe finished, around 20 s of card walk on a loaded card. Three things broke in
   * that window, one of them permanently:
   *
   *   · the organize warning never came back. It only re-arms when `migrationRequired()` passes
   *     through false (see library.ts), so "Later" holds until re-connect. With the counts carried
   *     over, one card needing organizing followed by another never produced that false, and after a
   *     single "Later" no card raised the dialog again for the rest of the session. A user hit this
   *     going from a test folder on the PC to the real SD: the folder alarmed, the card (25308 files
   *     to move) said nothing.
   *   · the dialog showed the other card's files, since it renders `lastPlan` instead of walking the
   *     card again (migrate-dialog.ts) and `_lastPlan` was cleared by nothing, not even eject.
   *   · the BIOS warning and the usage total described the card that was no longer there.
   *
   * `_fwAssume` is reset here too, though it was already safe on its own: the answer is stored with the
   * card handle and `loadCardFwAssume` returns null for a different folder (lib/scan.js), so another
   * card is asked again rather than inheriting.
   */
  private resetCardProbes(): void {
    this._biosPresent.set(new Set());
    this._biosProbed.set(false);
    this._migrateProbed.set(false);
    this._migrateCount.set(0);
    this._junkCount.set(0);
    this._lastPlan.set(null);
    this._migrateResult.set(null); // the previous card's organize result would re-open the dialog
    this._cardLayout.set(null);
    this._fwAssume.set(null);
    this._fw.set({ kind: 'unknown' });
    this._cardUsedBytes.set(null);
  }

  /** On load, look up the last-used card. If we still hold permission, reconnect + re-scan straight
   *  away (reload-resume); otherwise stash it so the connect screen can offer a 1-click reconnect
   *  (re-granting permission needs a user gesture). Never throws. */
  private async tryRestoreCard(): Promise<void> {
    try {
      if (!fsAccessSupported()) return;
      const handle = await loadCardHandle();
      if (!handle || this._connected() || this.rootHandle) return;
      if (await hasRwPermission(handle)) await this.openCard(handle); // permission still granted → auto-resume
      else this._reconnectHandle.set(handle);                          // needs a gesture → offer the button
    } catch {  }/* best-effort */
  }

  /** 1-click reconnect to the remembered card (from the connect screen). Requests permission (this
   *  runs in a user gesture) then scans. */
  async reconnectLast(): Promise<void> {
    const handle = this._reconnectHandle();
    if (!handle) return;
    this._reconnectHandle.set(null);
    await this.openCard(handle); // openCard re-requests rw permission (gesture present) + scans
  }

  private loadMock(): void {
    this.discardPendingUpdates(); // whole library swapped: queued patches belong to the outgoing one
    this._entries.set(MOCK_ENTRIES.map((g) => ({ ...g, identified: true, gamedbId: g.matched ? 'demo-' + g.id : undefined })));
    this._themeFiles.set([]);
    this._activeSkin.set(null);
    this._themePreviews.set(new Map());
    this.themeRenders.clear();
    this.ymlMemo.clear();
    this._folders.set(new Set());
    this._rootNameKey.set('store.rootSampleRoms');
    this._rootName.set(this.i18n.translate('store.rootSampleRoms'));
    this._connected.set(true);
  }

  /* ---- folder-path set helpers (keep the tree's empty folders in sync) ---- */
  private addFolder(path: string): void {
    if (!path) return;
    this._folders.update((s) => {
      const n = new Set(s);
      // add the path + all ancestors so the tree chain exists
      let acc = '';
      for (const p of path.split('/')) { acc = acc ? acc + '/' + p : p; n.add(acc); }
      return n;
    });
  }
  private removeFolderPaths(prefix: string): void {
    this._folders.update((s) => {
      const n = new Set<string>();
      for (const p of s) if (p !== prefix && !p.startsWith(prefix + '/')) n.add(p);
      return n;
    });
  }
  private renameFolderPaths(oldPrefix: string, newPrefix: string): void {
    this._folders.update((s) => {
      const n = new Set<string>();
      for (const p of s) {
        if (p === oldPrefix) n.add(newPrefix);
        else if (p.startsWith(oldPrefix + '/')) n.add(newPrefix + p.slice(oldPrefix.length));
        else n.add(p);
      }
      return n;
    });
  }

  /* ---- filters / view ---- */
  setQuery(q: string): void { this._query.set(q); }
  setSysFilter(v: SystemFilter): void { this._sysFilter.set(v); }
  setStatusFilter(v: StatusFilter): void { this._statusFilter.set(v); }
  setRecursive(v: boolean): void { this._recursive.set(v); }
  toggleSidebar(): void { this.prefs.setSidebarOpen(!this.prefs.sidebarOpen()); }
  toggleBoard(): void { this.prefs.setBoardOpen(!this.prefs.boardOpen()); }

  /** Drill down from one side of a board cell into the games behind it, `missing` (what still
   *  needs filling) or `present` (what's already on the card). The board counts the whole card
   *  while `filtered` scopes system/status to the current folder, so this also jumps to the root
   *  with subfolders on; otherwise the list would show a subset of the number just clicked. */
  focusCell(system: System, col: BoardCol, side: 'missing' | 'present'): void {
    const spec = BOARD_COLS.find((c) => c.key === col);
    if (!spec) return;
    this._query.set('');
    this.navTo('');
    this._recursive.set(true);
    this._sysFilter.set(system);
    this._statusFilter.set(side === 'present' ? spec.statusHas : spec.status);
  }

  /* ---- folder navigation ---- */
  navTo(path: string): void {
    this._cwd.set(path);
    if (path) {
      const anc: string[] = [];
      let acc = '';
      for (const p of path.split('/')) { acc = acc ? acc + '/' + p : p; anc.push(acc); }
      this._expanded.update((s) => { const n = new Set(s); anc.forEach((a) => n.add(a)); return n; });
    }
  }
  /** Navigate up one folder level (no-op at the root). */
  navUp(): void {
    const c = this._cwd();
    if (c) this.navTo(c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '');
  }
  toggleExp(path: string): void {
    this._expanded.update((s) => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n; });
  }

  /* ---- detail selection ---- */
  select(id: string): void { this._selId.set(id); }
  closeDetail(): void { this._selId.set(null); }

  /* ---- bulk selection ---- */
  toggleSel(id: string): void {
    this._selected.update((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  clearSel(): void { this._selected.set(new Set()); }
  toggleAllFiltered(): void {
    const f = this.filtered();
    this._selected.update((s) => {
      const allOn = f.length > 0 && f.every((g) => s.has(g.id));
      const n = new Set(s);
      if (allOn) f.forEach((g) => n.delete(g.id));
      else f.forEach((g) => n.add(g.id));
      return n;
    });
  }

  /* ---- per-entry mutation ----
     Every write to `_entries` is a full O(n) rebuild and invalidates every derived computed
     (stats/systemStats/tree/filtered/entriesById, all O(n) too). One call per game was fine when
     the caller was a click; it is not when the caller is a bulk phase touching 3000 ROMs (the probe,
     identify, the write worker's progress stream): that is millions of spreads and re-tallies, and
     the UI freezes. So bulk producers queue their patches (queueUpdate) and a single coalesced
     `updateMany` lands the whole batch in one signal transition; interactive paths keep calling
     `update`, which is still synchronous. Nothing derives from anything new, the same computeds
     read the same `_entries`, there are just far fewer transitions. */

  /** Apply a batch of per-entry patches in a single `_entries` transition (one map pass, one set,
   *  one recomputation of the derived signals) instead of one per entry. */
  private updateMany(patches: ReadonlyMap<string, Partial<Entry> | ((g: Entry) => Partial<Entry>)>): void {
    if (!patches.size) return;
    this._entries.update((gs) =>
      gs.map((g) => {
        const p = patches.get(g.id);
        if (p === undefined) return g;
        return { ...g, ...(typeof p === 'function' ? p(g) : p) };
      }),
    );
  }

  /** Patches waiting for the next flush, in arrival order per id. */
  private pendingUpdates = new Map<string, (Partial<Entry> | ((g: Entry) => Partial<Entry>))[]>();
  private pendingHandle: ReturnType<typeof setTimeout> | null = null;
  /** How long a queued patch may wait. Short enough that the list/statbar still animate during a run,
   *  long enough that a 3000-message burst collapses into a handful of transitions. */
  private static readonly UPDATE_FLUSH_MS = 100;

  /** Queue a patch for a bulk producer. Same semantics as `update`, only deferred: a patch function is
   *  resolved at flush time against the state the earlier queued patches for that id already produced,
   *  so `(g) => ({ guides: (g.guides ?? 0) + 1 })` still accumulates correctly. Never use it for a user
   *  interaction. Those must land before the next paint. */
  private queueUpdate(id: string, patch: Partial<Entry> | ((g: Entry) => Partial<Entry>)): void {
    const list = this.pendingUpdates.get(id);
    if (list) list.push(patch);
    else this.pendingUpdates.set(id, [patch]);
    if (this.pendingHandle == null) {
      this.pendingHandle = setTimeout(() => {
        this.pendingHandle = null;
        this.flushEntryUpdates();
      }, LibraryStore.UPDATE_FLUSH_MS);
    }
  }

  /** Land every queued patch now. Call it at the end of each bulk phase and before any read of
   *  `entries()`/`entriesById()` that must see what the phase just wrote. */
  private flushEntryUpdates(): void {
    if (this.pendingHandle != null) { clearTimeout(this.pendingHandle); this.pendingHandle = null; }
    if (!this.pendingUpdates.size) return;
    const batch = this.pendingUpdates;
    this.pendingUpdates = new Map();
    // Merge FIFO per id: later keys win, and each patch function sees the entry as the previous ones
    // in this batch left it, exactly what a sequence of update() calls would have produced.
    const merged = new Map<string, (g: Entry) => Partial<Entry>>();
    for (const [id, list] of batch) {
      merged.set(id, (g) => {
        let acc: Partial<Entry> = {};
        let cur = g;
        for (const p of list) {
          const d = typeof p === 'function' ? p(cur) : p;
          acc = { ...acc, ...d };
          cur = { ...cur, ...d };
        }
        return acc;
      });
    }
    this.updateMany(merged);
  }

  /** Throw away queued patches: the library they targeted is being replaced wholesale (rescan / demo /
   *  reset). Entry ids are positional ('e0', 'e1', ...), so a patch left over from the previous library
   *  would land on a different game. */
  private discardPendingUpdates(): void {
    if (this.pendingHandle != null) { clearTimeout(this.pendingHandle); this.pendingHandle = null; }
    this.pendingUpdates.clear();
  }

  private update(id: string, patch: Partial<Entry> | ((g: Entry) => Partial<Entry>)): void {
    // Goes through the queue so a pending bulk patch can never be re-applied on top of a newer
    // interactive one; the immediate flush keeps this call synchronous, and it costs the same single
    // signal transition it always did (it just carries the queued patches along).
    this.queueUpdate(id, patch);
    this.flushEntryUpdates();
  }
  private readonly defaultCheats: Cheat[] = [
    { name: 'Infinite health', on: false },
    { name: 'Infinite lives', on: false },
    { name: 'Max score', on: false },
  ];

  /* ---- per-entry actions ----
     `.cov` is encoded in-browser (lib/cov.js) and written next to the ROM when a
     card is connected, else downloaded (demo). dlCheats writes the catalog to
     /sd2snes/cheats/<stem>.yml. Delete actions remove the generated files. ROM
     rename / delete-ROM / delete-save stay simulated (destructive, later). */
  async genCover(g: Entry, quiet = false): Promise<'ok' | 'shot-missing' | 'gd-failed' | 'cov-failed' | 'no-cover' | 'cov-readonly'> {
    let cur = g;
    // Auto-identify on demand: coverUrl comes from the gamedb match (identify), so a freshly
    // connected card (not yet identified) has none. Identify first so Regenerate/Generate "just
    // works" without the manual Identify step.
    if (!cur.coverUrl && !cur.identified) {
      await this.identify(cur);
      cur = this.entriesById().get(g.id) ?? cur;
    }
    if (!cur.coverUrl) {
      // No GamesDB cover image: if the game already has a `.cov` on the card, derive the `.gcv` from it
      // (decode -> crop to art -> re-encode centered) so the game info file still gets a pixel-centered cover
      // instead of leaning on the firmware's tile-quantised OBJ fallback. Only with a card (writes the
      // .gcv into /sd2snes/info); the .cov already exists, so nothing else is written.
      if (cur.cover === 'has' && cur.dirHandle && this.rootHandle) {
        const r = await this.genGcvFromCov(cur, quiet);
        if (r) return 'ok';
      }
      if (!quiet) this.toast.show(this.i18n.translate('store.noCoverImage'), 'warn');
      return 'no-cover';
    }
    return this.encodeAndPlaceCover(cur, cur.coverUrl, 'has', this.i18n.translate('store.coverGenerated'), quiet);
  }

  /** Derive the game info `.gcv` from the game's existing on-card `.cov` (used when there is no GamesDB
   *  cover image). Reads <stem>.cov next to the ROM, rebuilds a centered 120c cover, writes it to
   *  /sd2snes/info/<bucket>/<stem>.gcv. Bounded + fail-safe: any error returns false (caller falls
   *  back to 'no-cover'). Returns true on a clean write. */
  private async genGcvFromCov(g: Entry, quiet: boolean): Promise<boolean> {
    if (!g.dirHandle || !this.rootHandle) return false;
    this.update(g.id, { busy: 'cover' });
    try {
      const stem = stemOf(g.file);
      const covBytes = await readFileFrom(g.dirHandle, stem + '.cov');
      if (!covBytes) { this.update(g.id, { busy: null }); return false; }
      const gcv: Uint8Array = await buildGcvFromCov(covBytes);
      const infoDir = await this.ensureDir(infoDirFor(this.key(g.file)));
      await this.card.write(infoDir, stem + '.gcv', gcv);
      this.update(g.id, { busy: null, gcv: 'has' });
      if (!quiet) this.toast.show(`${this.i18n.translate('store.coverGenerated')} ✓`, 'ok');
      return true;
    } catch (err) {
      console.warn('[gcv-from-cov] failed for', g.file, err);
      this.update(g.id, { busy: null });
      return false;
    }
  }

  async replaceCover(g: Entry): Promise<void> {
    const file: File | null = await pickImageFile();
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      await this.encodeAndPlaceCover(g, url, 'custom', this.i18n.translate('store.customCoverApplied'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Decoded `.s2pkg` members keyed by packageUrl, fetched + inflated once and reused across the
   *  cover/screenshot/preview/cheats writes for a game. Resolves to null when there's no package or
   *  the fetch/inflate failed, so every caller transparently falls back to generating the media.
   *
   *  Bounded (LRU): each package inflates to its full uncompressed bytes (cov+gcv+gss+fmv+pcm), and
   *  the members are subarray views over that one buffer, so holding any member pins the whole
   *  package. An unbounded cache over a big folder (3199 ROMs) therefore retained every inflated
   *  package and grew the heap to >15GB. The cache only needs to survive one game's ~4 writes, so we
   *  cap it and evict the least-recently-used; finished games' packages are freed for GC. */
  private static readonly PKG_CACHE_MAX = 16; // ≥ the auto-fill prefetch window (6) + headroom for in-use packages
  private readonly pkgCache = new Map<string, Promise<Record<string, Uint8Array> | null>>();
  private getPackage(g: Entry): Promise<Record<string, Uint8Array> | null> {
    const url = g.packageUrl;
    if (!url) return Promise.resolve(null);
    let p = this.pkgCache.get(url);
    if (p) {
      // mark recently-used: re-insert so a game in flight stays hot and isn't evicted mid-write.
      this.pkgCache.delete(url);
      this.pkgCache.set(url, p);
      return p;
    }
    p = (fetchPackage(cdnUrl(url) ?? url) as Promise<Record<string, Uint8Array>>).catch((e) => {
      console.warn('[pkg] fetch/inflate failed for', url, '— falling back to generation', e);
      return null;
    });
    this.pkgCache.set(url, p);
    // Evict the oldest (front of the insertion-ordered Map) until within the cap, freeing the
    // inflated bytes of packages whose game already finished writing.
    while (this.pkgCache.size > LibraryStore.PKG_CACHE_MAX) {
      const oldest = this.pkgCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pkgCache.delete(oldest);
    }
    return p;
  }

  /** Outcome of a cover write: both files OK · the GameDB had a screenshot but it couldn't be fetched
   *  so the `.gd` came out without a snapshot (retry-worthy) · `.cov` OK but the `.gd` failed entirely ·
   *  the `.cov` itself failed (nothing written). Bulk uses this to count + retry accurately. */
  private async encodeAndPlaceCover(g: Entry, imageUrl: string, status: 'has' | 'custom', label: string, quiet = false): Promise<'ok' | 'shot-missing' | 'gd-failed' | 'cov-failed' | 'cov-readonly'> {
    this.update(g.id, { busy: 'cover' });
    try {
      // Prefer the pre-built bundle: write its .cov + .gcv straight to the card (no fetch, no encode).
      // Only for the GameDB cover path ('has'). A 'custom' local image must use the picked file.
      const pkg = status === 'has' ? await this.getPackage(g) : null;
      if (pkg && pkg['cov'] && pkg['gcv']) {
        const stem = stemOf(g.file);
        const name = stem + '.cov';
        if (g.dirHandle) {
          // .cov goes next to the ROM, isolated: a read-only folder skips it (report) rather than latching.
          const covOk = await this.card.write(g.dirHandle, name, pkg['cov'], { isolated: true });
          if (this.rootHandle) {
            const infoDir = await this.ensureDir(infoDirFor(this.key(g.file)));
            await this.card.write(infoDir, stem + '.gcv', pkg['gcv']);
          }
          if (!covOk) { this.pushFillError(g, 'cov', 'readonly'); this.update(g.id, { gcv: 'has', busy: null }); return 'cov-readonly'; }
          if (!quiet) this.toast.show(`${label} ✓`, 'ok');
        } else {
          downloadBlob(name, pkg['cov']);
          downloadBlob(stem + '.gcv', pkg['gcv']);
          if (!quiet) this.toast.show(this.i18n.translate('store.coverDownloaded', { label }), 'ok');
        }
        this.update(g.id, { cover: status, gcv: 'has', busy: null, thumbUrl: covToDataUrl(pkg['cov']) });
        return 'ok';
      }
      // Fetch the cover image once and build both the .cov (browser list OBJ) and the .gcv (the game info file
      // paletted 120c cover). The screenshot/FMV is now a separate file (.fmv), handled elsewhere, so
      // regenerating the cover never touches/wipes the snapshot.
      const coverBytes = await fetchBytes(cdnUrl(imageUrl) ?? imageUrl);
      const cov: Uint8Array = await buildCovFromBytes(coverBytes);
      const gcv: Uint8Array = await buildCoverFile(coverBytes);
      const stem = stemOf(g.file);
      const name = stem + '.cov';
      if (g.dirHandle) {
        // .cov goes next to the ROM, isolated: a read-only folder skips it (report) rather than latching.
        const covOk = await this.card.write(g.dirHandle, name, cov, { isolated: true });
        if (this.rootHandle) {
          const infoDir = await this.ensureDir(infoDirFor(this.key(g.file)));
          await this.card.write(infoDir, stem + '.gcv', gcv);
        }
        if (!covOk) { this.pushFillError(g, 'cov', 'readonly'); this.update(g.id, { gcv: 'has', busy: null }); return 'cov-readonly'; }
        if (!quiet) this.toast.show(`${label} ✓`, 'ok');
      } else {
        downloadBlob(name, cov);
        downloadBlob(stem + '.gcv', gcv);
        if (!quiet) this.toast.show(this.i18n.translate('store.coverDownloaded', { label }), 'ok');
      }
      this.update(g.id, { cover: status, gcv: 'has', busy: null, thumbUrl: covToDataUrl(cov) });
      return 'ok';
    } catch (err) {
      console.error('[cover] encode/place failed for', g.file, '· src:', imageUrl, err);
      this.update(g.id, { busy: null });
      // In bulk (quiet) the aggregated summary reports the failure count instead, so we don't
      // emit a per-item toast that would contradict it.
      if (!quiet) this.toast.show(this.i18n.translate('store.coverFailed', { error: msg(err) }), 'warn');
      if (/taint|CORS|fetch|load/i.test(msg(err))) this.warnCors();
      return 'cov-failed';
    }
  }

  async delCover(g: Entry): Promise<void> {
    const stem = stemOf(g.file);
    try {
      if (g.dirHandle) await this.card.remove(g.dirHandle, stem + '.cov');
    } catch {  }/* already gone */
    // also drop the game info cover (.gcv) so removing the cover clears both halves (else a stale .gcv
    // lingers and the capa reads half-present); mirrors how genCover writes the two together.
    try {
      const infoDir = await this.getDir(infoDirFor(this.key(g.file)));
      if (infoDir) await this.card.remove(infoDir, stem + '.gcv');
    } catch {  }/* already gone */
    this.update(g.id, { cover: g.coverUrl ? 'available' : 'none', gcv: 'none', thumbUrl: undefined });
    this.toast.show(this.i18n.translate('store.coverRemoved'), 'warn');
  }

  /** Write the cheats catalog to /sd2snes/cheats/<stem>.yml. Returns whether a real catalog was
   *  written. `quiet` suppresses toasts (bulk aggregates them). The catalog comes reserved from the
   *  CRC lookup (dbCheats), so this writes without hitting /cheats/<CRC>.yml; the on-server .yml is
   *  only a fallback for the rare case nothing was reserved. */
  async dlCheats(g: Entry, quiet = false): Promise<boolean> {
    this.update(g.id, { busy: 'cheats' });
    try {
      const pkg = await this.getPackage(g);
      const pkgText = pkg && pkg['cheats'] ? new TextDecoder().decode(pkg['cheats']) : null;
      // Cheats come only from the GameDB now: the .s2pkg bundle's cheats member, else the catalog
      // Reserved from the CRC lookup (dbCheats). No /cheats/<CRC>.yml fetch. That file is exported
      // from the same DB, so it carries nothing the lookup/bundle doesn't already have (the old
      // fallback was just 404 noise for games the GameDB has no cheats for).
      const text = pkgText
        ?? (g.dbCheats?.length ? this.cheats.serialize(g.dbCheats, shortTitle(g)) : null);
      const name = stemOf(g.file) + '.yml';
      if (!text) {
        this.update(g.id, { busy: null });
        if (!quiet) this.toast.show(this.i18n.translate('store.noCheatsFor', { title: shortTitle(g) }), 'info');
        return false;
      }
      if (g.dirHandle && this.rootHandle) {
        const dir = await this.ensureDir(cheatsDirFor(this.key(g.file)));
        await this.card.write(dir, name, text);
        if (!quiet) this.toast.show(this.i18n.translate('store.cheatsInstalled'), 'ok');
      } else {
        downloadBlob(name, text, 'text/yaml');
        if (!quiet) this.toast.show(this.i18n.translate('store.downloadedFile', { name }), 'info');
      }
      this.update(g.id, { cheats: 'has', busy: null, cheatList: this.cheats.parse(text), cheatsRaw: text });
      return true;
    } catch (err) {
      this.update(g.id, { busy: null });
      if (!quiet) this.toast.show(this.i18n.translate('store.cheatsFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Save an edited cheat list to /sd2snes/cheats/<stem>.yml (or download in demo). */
  async saveCheats(g: Entry, cheats: Cheat[]): Promise<void> {
    const name = stemOf(g.file) + '.yml';
    try {
      if (cheats.length === 0) {
        const dir = await this.getDir(cheatsDirFor(this.key(g.file)));
        if (dir) { try { await this.card.remove(dir, name); } catch {  } }/* gone */
        this.update(g.id, { cheats: g.crc ? 'available' : 'none', cheatList: [], cheatsRaw: undefined });
        this.toast.show(this.i18n.translate('store.cheatsRemoved'), 'warn');
        return;
      }
      const text = this.cheats.serialize(cheats, shortTitle(g));
      if (this.rootHandle) {
        const dir = await this.ensureDir(cheatsDirFor(this.key(g.file)));
        await this.card.write(dir, name, text);
        this.toast.show(
          this.i18n.translate(cheats.length > 1 ? 'store.cheatsSavedMany' : 'store.cheatsSavedOne', { count: cheats.length }),
          'ok',
        );
      } else {
        downloadBlob(name, text, 'text/yaml');
        this.toast.show(this.i18n.translate('store.downloadedFile', { name }), 'info');
      }
      this.update(g.id, { cheats: 'has', cheatList: cheats, cheatsRaw: text });
    } catch (err) {
      this.toast.show(this.i18n.translate('store.saveCheatsFailed', { error: msg(err) }), 'warn');
    }
  }

  async delCheats(g: Entry): Promise<void> {
    const name = stemOf(g.file) + '.yml';
    try {
      const dir = await this.getDir(cheatsDirFor(this.key(g.file)));
      if (dir) await this.card.remove(dir, name);
    } catch {  }/* already gone */
    this.update(g.id, { cheats: g.crc ? 'available' : 'none' });
    this.toast.show(this.i18n.translate('store.cheatsRemoved'), 'warn');
  }

  /** Delete the preview assets (.gss static shot + .fmv clip + .pcm audio) from /sd2snes/info. */
  async delPreview(g: Entry): Promise<void> {
    const stem = stemOf(g.file);
    try {
      const infoDir = await this.getDir(infoDirFor(this.key(g.file)));
      if (infoDir) for (const ext of ['.gss', '.fmv', '.pcm']) {
        try { await this.card.remove(infoDir, stem + ext); } catch {  }/* not present */
      }
    } catch {  }/* no info dir */
    this.update(g.id, { snapshot: 'none', fmv: 'none' });
    this.toast.show(this.i18n.translate('store.previewRemoved'), 'warn');
  }

  /** Delete the game-info description (.yml game info) from /sd2snes/info. */
  async delInfo(g: Entry): Promise<void> {
    const stem = stemOf(g.file);
    try {
      const infoDir = await this.getDir(infoDirFor(this.key(g.file)));
      if (infoDir) await this.card.remove(infoDir, stem + '.yml');
    } catch {  }/* not present */
    this.ymlMemo.delete(g.id); // the file is gone: nothing in memory describes it any more
    this.update(g.id, { info: 'none' });
    this.toast.show(this.i18n.translate('store.infoRemoved'), 'warn');
  }

  /* ---- animated screenshot (.fmv + .pcm) ----
     Encoded in-browser from a local video (gamedb video is the other source,
     when reachable) and written to /sd2snes/info/<C>/<stem>.{fmv,pcm}, plus the
     `fmv: 1` flag in the sibling .yml the firmware probes. */
  /** Generate .fmv (+ .pcm) from a locally-picked video file. */
  async genFmv(g: Entry): Promise<void> {
    const file: File | null = await pickVideoFile();
    if (!file) return;
    await this.encodeAndPlaceFmv(g, file);
  }

  /** Write the .fmv (+.pcm, +.gss) straight from the pre-built .s2pkg when it has them, instant, no
   *  ffmpeg, no video download (the bundle's .fmv is already the 12-fps 88c clip this app would build).
   *  Returns true when the package supplied the clip; false when it has no .fmv, which for AUTO-FILL is
   *  the end of the line (it skips the game and reports it), and only for the explicit per-game actions
   *  is a cue to encode from the video. This is auto-fill's only preview path. */
  private async placePackageFmv(g: Entry, quiet = false, audio = true): Promise<boolean> {
    const pkg = await this.getPackage(g);
    if (!pkg || !pkg['fmv']) return false;
    // Audio (only when requested): the embedded `.pcm` (legacy packages) or the separated `.pcm.zst`
    // (new audio-less packages, inflated here). Best-effort, a failure never blocks the `.fmv`.
    let pcm = audio ? pkg['pcm'] : undefined;
    if (audio && !pcm && g.pcmUrl) {
      try { pcm = await fetchInflate(cdnUrl(g.pcmUrl) ?? g.pcmUrl); } catch {  }/* audio best-effort */
    }
    this.update(g.id, { busy: 'fmv' });
    try {
      const stem = stemOf(g.file);
      if (g.dirHandle && this.rootHandle) {
        const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
        await this.card.write(dir, stem + '.fmv', pkg['fmv']);
        if (pcm) await this.card.write(dir, stem + '.pcm', pcm);
        // snapshot only if none exists yet (the curated .gss from a prior phase-1 step wins)
        if (pkg['gss'] && !(await fileExists(dir, stem + '.gss'))) {
          await this.card.write(dir, stem + '.gss', pkg['gss']);
          this.update(g.id, { snapshot: 'has' });
        }
        await this.ensureFmvFlag(g, dir, stem);
        if (!quiet) this.toast.show(this.i18n.translate(pcm ? 'store.previewWrittenAudio' : 'store.previewWritten'), 'ok');
      } else {
        downloadBlob(stem + '.fmv', pkg['fmv']);
        if (pcm) downloadBlob(stem + '.pcm', pcm);
        if (!quiet) this.toast.show(this.i18n.translate(pcm ? 'store.previewGeneratedAudio' : 'store.previewGenerated'), 'ok');
      }
      this.update(g.id, { fmv: 'has', busy: null });
      return true;
    } catch (err) {
      console.error('[fmv] package write failed for', g.file, err);
      this.update(g.id, { busy: null });
      if (!quiet) this.toast.show(this.i18n.translate('store.previewFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Explicit, PER-GAME action only (the game info file's "gerar prévia" button): place the ready clip from the
   *  `.s2pkg`, and only when the GameDB hasn't built one, download the video and encode it here.
   *  AUTO-FILL deliberately does not call this, it never encodes video (see placePackageFmv). */
  async genFmvFromGamedb(g: Entry, quiet = false): Promise<boolean> {
    // Prefer the pre-built bundle's clip (instant); only fall back to the video + ffmpeg when there's none.
    if (await this.placePackageFmv(g, quiet)) return true;
    return this.encodeFmvFromVideo(g, quiet);
  }

  /** Fallback only: encode .fmv (+.pcm) from the gamedb video via ffmpeg. For games whose .s2pkg has
   *  No clip. Auto-identifies to get the URL. Reachable only from a user-initiated per-game action
   *  (genFmvFromGamedb / genFmv from a local file): it downloads the mp4 and runs ffmpeg.wasm, which is
   *  minutes per game, never put it back in a bulk path (auto-fill skips + reports instead). */
  private async encodeFmvFromVideo(g: Entry, quiet = false, audio = true): Promise<boolean> {
    let cur = g;
    if (!cur.videoUrl && !cur.identified) {
      await this.identify(cur);
      cur = this.entriesById().get(g.id) ?? cur;
    }
    if (!cur.videoUrl) {
      if (!quiet) this.toast.show(this.i18n.translate('store.noGamedbVideo'), 'warn');
      return false;
    }
    this.update(g.id, { busy: 'fmv' });
    // Fetch the gamedb video directly from the CDN (ngsw-bypass for the SW). The dialog <video> uses
    // crossorigin, so it caches a CORS-valid response this fetch can reuse, no poisoning. Retry covers transients.
    const url = cdnUrl(cur.videoUrl) ?? cur.videoUrl;
    console.log('[fmv] fetch gamedb video:', url);
    let blob: Blob | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !blob; attempt++) {
      if (attempt) await sleep(400 * attempt);
      // bound each attempt (fetch + body read) -- without this a stalled connection hangs forever and
      // wedges the whole "Gerando prévias" batch (no response is never an error, so the retry never fires).
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 45000);
      try {
        const resp = await fetch(url, { signal: ctl.signal });
        if (resp.ok) { blob = await resp.blob(); break; }
        lastErr = `HTTP ${resp.status} ${resp.statusText}`;
        console.error(`[fmv] video fetch attempt ${attempt + 1}: HTTP ${resp.status} ${resp.statusText} — ${url}`);
      } catch (err) {
        lastErr = ctl.signal.aborted ? new Error('video fetch timeout (45s)') : err;
        console.error(`[fmv] video fetch attempt ${attempt + 1} ${ctl.signal.aborted ? 'timed out' : 'threw'} — ${url}\n`, lastErr);
      } finally {
        clearTimeout(timer);
      }
    }
    if (!blob) {
      console.error('[fmv] gamedb video FAILED for', g.file, '· url:', cur.videoUrl, '· last error:', lastErr);
      // Diagnostic probe: no-cors opaque = the URL is reachable (so it's a CORS/SW issue); a throw
      // means it's truly unreachable (network / CSP / blocked). Tells us which class of problem it is.
      try {
        const probe = await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(15000) });
        console.error('[fmv] diagnostic — no-cors probe OK (type=' + probe.type + '): URL reachable, the CORS fetch is what failed');
      } catch (e) {
        console.error('[fmv] diagnostic — no-cors probe ALSO failed: URL unreachable (network/CSP/blocked) →', e);
      }
      this.update(g.id, { busy: null });
      if (!quiet) this.toast.show(this.i18n.translate('store.videoDownloadFailed', { error: lastErr instanceof Error ? lastErr.message : String(lastErr) }), 'warn');
      return false;
    }
    console.log('[fmv] gamedb video fetched:', blob.size, 'bytes');
    return this.encodeAndPlaceFmv(cur, blob,  true, quiet, audio);/* busyAlreadySet */
  }

  /** Generate the static screenshot as a 1-frame cover-less .fmv (for games with no video), from the
   *  gamedb screenshot. The band shows it static (the firmware no-ops the 1-frame pump). */
  async genStaticShot(g: Entry, quiet = false): Promise<boolean> {
    // Prefer the pre-built bundle's .gss (no fetch/encode); else fall back to the curated screenshot.
    const pkg = await this.getPackage(g);
    if (pkg && pkg['gss']) {
      this.update(g.id, { busy: 'fmv' });
      try {
        const stem = stemOf(g.file);
        if (g.dirHandle && this.rootHandle) {
          const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
          await this.card.write(dir, stem + '.gss', pkg['gss']);
          await this.ensureFmvFlag(g, dir, stem);
        } else {
          downloadBlob(stem + '.gss', pkg['gss']);
        }
        this.update(g.id, { snapshot: 'has', busy: null });
        if (this._selId() === g.id) this._infoRev.update((v) => v + 1);
        return true;
      } catch (err) {
        console.error('[shot] package .gss write failed for', g.file, err);
        this.update(g.id, { busy: null });
        if (!quiet) this.toast.show(this.i18n.translate('store.previewFailed', { error: msg(err) }), 'warn');
        return false;
      }
    }
    const shotU = cdnUrl(g.screenshotUrl);
    if (!shotU) return false;
    this.update(g.id, { busy: 'fmv' });
    try {
      const shotBytes = await fetchBytes(shotU);
      const gss = await buildStaticShot(shotBytes, { fps: 0 });   // 1-frame .gss (its own file, not .fmv)
      const stem = stemOf(g.file);
      if (g.dirHandle && this.rootHandle) {
        const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
        await this.card.write(dir, stem + '.gss', gss);
        await this.ensureFmvFlag(g, dir, stem);   // the firmware probes <rom>.fmv/.gss only when this flag is set
      } else {
        downloadBlob(stem + '.gss', gss);
      }
      this.update(g.id, { snapshot: 'has', busy: null });
      if (this._selId() === g.id) this._infoRev.update((v) => v + 1); // refresh the open snapshot tile
      return true;
    } catch (err) {
      console.error('[shot] static screenshot failed for', g.file, err);
      this.update(g.id, { busy: null });
      if (!quiet) this.toast.show(this.i18n.translate('store.previewFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Encode a video source (a local File or a CDN Blob) → .fmv + .pcm, written to the card (or
   *  downloaded in demo). `busyAlreadySet` skips re-flagging busy when the caller already did. */
  private async encodeAndPlaceFmv(g: Entry, source: Blob, busyAlreadySet = false, quiet = false, audio = true): Promise<boolean> {
    if (!busyAlreadySet) this.update(g.id, { busy: 'fmv' });
    const url = URL.createObjectURL(source);
    try {
      // the cover-less clip (88c/frame) + a representative still for the .gss snapshot (middle
      // non-black frame). The cover is a separate .gcv; the preview no longer needs the cover here.
      const { fmv, snap } = await buildFmv(url, { fps: 12 });
      // .pcm is best-effort: a missing/odd audio track or a worker timeout must not fail the .fmv we
      // already built (and must not be silent). Catch it here so the video still gets written. Skipped
      // entirely when audio is off (the default), no point extracting/writing the big track.
      let pcm: Uint8Array | null = null;
      if (audio) {
        try { pcm = await buildPcm(await source.arrayBuffer()); }
        catch (perr) { console.warn('[fmv] pcm extraction failed/timed out for', g.file, msg(perr)); }
      }
      const stem = stemOf(g.file);
      if (g.dirHandle && this.rootHandle) {
        const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
        await this.card.write(dir, stem + '.fmv', fmv);
        if (pcm) await this.card.write(dir, stem + '.pcm', pcm);
        // snapshot (.gss), only if none exists yet. Priority: the curated gamedb screenshot wins.
        // fetch it if we have a URL; the clip's middle non-black frame is just the fallback. (Robust
        // even when this runs without a prior genStaticShot, e.g. a direct "generate preview".)
        if (!(await fileExists(dir, stem + '.gss'))) {
          let gss: Uint8Array | null = null;
          const shotU = cdnUrl(g.screenshotUrl);
          if (shotU) {
            // fail fast (2 tries, 8s each): the clip's middle frame is a fine fallback, so a slow/
            // dead screenshot URL must not stall the batch waiting on the curated still.
            try { gss = await buildStaticShot(await fetchBytes(shotU, 2, 8000), { fps: 0 }); }
            catch (e) { console.warn('[gss] curated screenshot fetch failed; using video frame for', g.file, msg(e)); }
          }
          await this.card.write(dir, stem + '.gss', gss ?? snap);
          this.update(g.id, { snapshot: 'has' });
        }
        await this.ensureFmvFlag(g, dir, stem);
        if (!quiet) this.toast.show(this.i18n.translate(pcm ? 'store.previewWrittenAudio' : 'store.previewWritten'), 'ok');
      } else {
        downloadBlob(stem + '.fmv', fmv);
        if (pcm) downloadBlob(stem + '.pcm', pcm);
        if (!quiet) this.toast.show(this.i18n.translate(pcm ? 'store.previewGeneratedAudio' : 'store.previewGenerated'), 'ok');
      }
      this.update(g.id, { fmv: 'has', busy: null });
      return true;
    } catch (err) {
      console.error('[fmv] encode/place failed for', g.file, err);
      this.update(g.id, { busy: null });
      if (!quiet) this.toast.show(this.i18n.translate('store.previewFailed', { error: msg(err) }), 'warn');
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Read the on-card `.fmv` (+ `.pcm` if present) for an entry, for the in-app preview player. */
  async readFmvBytes(g: Entry): Promise<{ fmv: Uint8Array; pcm: Uint8Array | null } | null> {
    if (!this.rootHandle || (g.fmv !== 'has' && g.snapshot !== 'has')) return null;
    const stem = stemOf(g.file);
    const dir = await this.getDir(infoDirFor(this.key(g.file)));
    if (!dir) return null;
    // prefer the animated clip (.fmv); else the static snapshot (.gss) -- both are paletted v4
    const fmv = (await readFileFrom(dir, stem + '.fmv')) ?? (await readFileFrom(dir, stem + '.gss'));
    if (!fmv) return null;
    const pcm = await readFileFrom(dir, stem + '.pcm'); // only the animated clip has audio
    return { fmv, pcm: pcm ?? null };
  }

  /** Read the on-card `.gss` snapshot bytes (/sd2snes/info/<C>/<stem>.gss), or null. */
  async readGssBytes(g: Entry): Promise<Uint8Array | null> {
    if (!this.rootHandle) return null;
    const stem = stemOf(g.file);
    const dir = await this.getDir(infoDirFor(this.key(g.file)));
    if (!dir) return null;
    return (await readFileFrom(dir, stem + '.gss')) ?? null;
  }

  /** Read a guide's full on-card `.man` bytes for slot `nn` (0 = official `<stem>.man`, 2..8 =
   *  `<stem>.0N.man`), or null. Feeds the in-app `.man` viewer / PDF export (see man-viewer.ts). */
  async readGuideBytes(g: Entry, nn: number): Promise<Uint8Array | null> {
    if (!this.rootHandle) return null;
    const stem = stemOf(g.file);
    const dir = await this.getDir(infoDirFor(this.key(g.file)));
    if (!dir) return null;
    return (await readFileFrom(dir, guideFileName(stem, nn))) ?? null;
  }

  /** Read the on-card `.gd` bytes (/sd2snes/info/<C>/<stem>.gd), or null. */
  async readGdBytes(g: Entry): Promise<Uint8Array | null> {
    if (!this.rootHandle) return null;
    const stem = stemOf(g.file);
    const dir = await this.getDir(infoDirFor(this.key(g.file)));
    if (!dir) return null;
    return (await readFileFrom(dir, stem + '.gd')) ?? null;
  }

  /** Read + parse the on-card game-info `.yml` into a fields object, or null. */
  async readInfoYml(g: Entry): Promise<Record<string, string> | null> {
    if (!this.rootHandle) return null;
    const stem = stemOf(g.file);
    const dir = await this.getDir(infoDirFor(this.key(g.file)));
    if (!dir) return null;
    const txt = await readTextFile(dir, stem + '.yml');
    return txt != null ? (parseInfoYml(txt) as Record<string, string>) : null;
  }

  /** GameInfo keys no caller knows about, preserved from the on-card `.yml` across a rewrite:
   *   - the localized descriptions (`description_<lang>`) the caller did not mention. The game info editor
   *     only knows the base fields, so without this a manual edit would silently strip every translated
   *     description the console reads. A caller that does list the keys (gameInfoFields, with null for the
   *     missing ones) stays authoritative.
   *   - `man_slots`, but only when the entry doesn't know the map (`undefined` = its game info file was never
   *     loaded). The map lives nowhere but the card, and erasing it drops the game back to sha-only
   *     manual dedup, i.e. straight back into the duplicate-slots bug on the next GameDB re-encode.
   *   - the `sync_*` tokens. No caller here ever names them (persistSyncTokens owns them), so a rewrite
   *     that dropped them would erase the receipt, the proof that the bytes on the card came from
   *     auto-fill, which adoption, overwrite and delete each demand before touching anything. A game info file
   *     saved in the editor would come back with its manuals unprovable, and therefore unrepairable:
   *     the next re-encode has no identity to anchor to and the game reports "no free guide slot" for
   *     good. persistSyncTokens does restore them from the pre-run snapshot, but only at the end of a
   *     run, which never arrives if the run is cancelled or the card goes unwritable mid-way. */
  /** The `sync_*` receipts exactly as the card holds them, for any path that replaces a `<rom>.yml`
   *  wholesale. Null keeps buildYml from emitting the key, matching a card that never had it. */
  private syncTokensOnCard(g: Entry): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of SYNC_KEYS as string[]) out[k] = g.onCardYml?.[k] ?? null;
    return out;
  }

  private async keepFromCard(g: Entry, fields: Record<string, string | null>): Promise<Record<string, string>> {
    const wantSlots = g.manSlots === undefined && g.info === 'has'; // no game info on card → no map to lose
    const wantDesc = (DESC_LANG_KEYS as string[]).filter((k) => !(k in fields));
    const wantSync = (SYNC_KEYS as string[]).filter((k) => !(k in fields));
    const out: Record<string, string> = {};
    // Receipts come from the PRE-RUN snapshot when it is loaded, the same source persistSyncTokens
    // resolves against, and free: loadOnCardYml runs library-wide before a fill, so the bulk path adds
    // no read at all. Only a lone game info file save, with no snapshot, can reach the disk for them.
    const snap = g.onCardYml;
    if (snap) for (const k of wantSync) if (snap[k]) out[k] = snap[k];
    if (!wantSlots && !wantDesc.length && (snap !== undefined || !wantSync.length)) return out;
    const cur = await this.readInfoYml(g).catch(() => null);
    if (!cur) return out;
    for (const k of wantDesc) if (cur[k]) out[k] = cur[k];
    for (const k of wantSync) if (!out[k] && cur[k]) out[k] = cur[k];
    if (wantSlots && cur[MAN_SLOTS_KEY]) out[MAN_SLOTS_KEY] = cur[MAN_SLOTS_KEY];
    return out;
  }

  /** Save the game-info `.yml` (the game info editor). Preserves the fmv flag when the card holds either
   *  media it gates (see `fmvFlagFor`) and the `.man` slot→document map, see `manSlotsFor`. */
  async saveInfoYml(g: Entry, fields: Record<string, string | null>, quiet = false): Promise<boolean> {
    if (!this.rootHandle) { if (!quiet) this.toast.show(this.i18n.translate('store.noCardConnected'), 'warn'); return false; }
    const stem = stemOf(g.file);
    const kept = await this.keepFromCard(g, fields);
    const f = {
      ...kept, ...fields, rom: g.file, crc: g.crc || null, gamedb_id: g.gamedbId ?? null, fmv: fmvFlagFor(g),
      [MAN_SLOTS_KEY]: manSlotsField(g, kept[MAN_SLOTS_KEY]),
    };
    try {
      const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
      const text = buildYml(f);
      await this.card.write(dir, stem + '.yml', text);
      // The very next step of a fill is often the preview, whose fmv flag would otherwise read this
      // file straight back off the card (see ensureFmvFlag).
      this.rememberYml(g.id, text);
      this.update(g.id, { info: 'has' });
      // Only nudge open views to re-read on a user edit. A bulk (quiet) write bumps this per game,
      // and infoRev feeds the detail panel's media+game info effects → the snapshot/video/description
      // would reset and flicker on every game in the run. Bulk skips it (the panel still updates for
      // the selected game via its own cover/fmv signals when that game is the one being processed).
      if (!quiet) this._infoRev.update((v) => v + 1);
      if (!quiet) this.toast.show(this.i18n.translate('store.infoSaved'), 'ok');
      return true;
    } catch (err) {
      console.error('[yml] save failed for', g.file, err);
      if (!quiet) this.toast.show(this.i18n.translate('store.saveFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Write the version tokens (`sync_*`) into a game's on-card `<rom>.yml` so a later "Atualizar" run can
   *  tell what's stale without downloading. Called once per touched/legacy game after a fill run.
   *
   *  Per token: advance to the current server value when its category was (re)written this run (`wrote`);
   *  otherwise keep the stored value (so an untouched-but-stale category stays flagged). On a legacy `.yml`
   *  with no stored token, adopt the current value as a baseline, unconditionally for package/manual
   *  (unverifiable without a download), and for `sync_meta` only when the on-card metadata already equals
   *  the server's (verified locally). Reads the current game info file (the worker may have just rewritten it),
   *  merges the tokens, and rewrites only when something actually changed. */
  private async persistSyncTokens(g: Entry, wrote: { pkg?: boolean; pcm?: boolean; man?: boolean; meta?: boolean }): Promise<void> {
    if (!this.rootHandle || this.card.unwritable) return;
    const cur = await this.readInfoYml(g).catch(() => null);
    if (!cur) return; // no game info on card → nothing to annotate (never create one just to store tokens)
    const desired = syncTokensFromMatch(g) as Record<string, string | null>;
    // `stored` = the tokens as they were before this run (the pre-run snapshot), not re-read from `cur`:
    // the worker rewrites the `.yml` from metadata-only fields when it (re)writes info/preview, which
    // Strips the old sync_*. Reading them back would make an untouched-but-stale category look current.
    const pre = g.onCardYml ?? {};
    const stored: Record<string, string | null> = {
      sync_pkg: pre['sync_pkg'] ?? null, sync_pcm: pre['sync_pcm'] ?? null, sync_man: pre['sync_man'] ?? null, sync_meta: pre['sync_meta'] ?? null,
    };
    const next = { ...stored };
    const resolve = (key: string, wroteIt: boolean | undefined, canAdopt: boolean): void => {
      if (wroteIt) next[key] = desired[key]; // (re)wrote the asset → it now matches the server
      else if (stored[key] == null && canAdopt) next[key] = desired[key]; // safe baseline (verified equal)
    };
    // Package/manual tokens are only set by an actual (re)write, never adopted from a bare legacy `.yml`
    // (we can't prove the on-card art matches the server without downloading, so adopting would hide a real
    // update). `sync_meta` is the exception: a local field compare proves equality, so a matching legacy
    // game info can safely stamp the token without a rewrite.
    resolve('sync_pkg', wrote.pkg, false);
    resolve('sync_pcm', wrote.pcm, false);
    resolve('sync_man', wrote.man, false);
    resolve('sync_meta', wrote.meta, this.metaFieldsMatch(g, g.onCardYml));
    // `man_slots` is not one of the tokens (it records card state, not a server version, see yml.js),
    // so it is neither resolved nor derivable from `desired`; it rides straight from the entry, the one
    // source of truth (manSlotsFor). Without it this rewrite would drop the map installManuals just
    // recorded. Left exactly as the card has it when the entry never loaded it (undefined).
    const slots = manSlotsField(g, cur[MAN_SLOTS_KEY]);
    const slotsSame = slots === (cur[MAN_SLOTS_KEY] ?? null);
    if (slotsSame && SYNC_KEYS.every((k) => (next[k] ?? null) === (stored[k] ?? null))) return; // nothing to change
    const merged: Record<string, string> = { ...cur };
    for (const k of SYNC_KEYS as string[]) { const v = next[k]; if (v == null) delete merged[k]; else merged[k] = v; }
    if (slots == null) delete merged[MAN_SLOTS_KEY]; else merged[MAN_SLOTS_KEY] = slots;
    try {
      const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
      const text = buildYml(merged);
      await this.card.write(dir, stemOf(g.file) + '.yml', text);
      this.rememberYml(g.id, text);
      // Both halves of the game info snapshot, always together: loadOnCardYml skips an entry whose
      // `onCardYml` is already defined, so refreshing one without the other leaves `manSlots` stuck at
      // `undefined` for the rest of the session, and the next run's worker game info would then bake
      // `man_slots: null` and wipe the map off the card.
      this.update(g.id, { onCardYml: merged, manSlots: slots ? (parseManSlots(slots) as Map<number, string>) : null });
    } catch (err) {
      console.warn('[sync] token persist failed for', g.file, err); // best-effort: never fail the run over bookkeeping
    }
  }

  /** Download the GameDB's official manuals (`.man`, ready-made with zoom) and write them as-is to the
   *  card, the autofill-owned "Guias/Manuais" category (main-thread path; the bulk worker has its own
   *  copy of this fetch+write for the fast path, see autofill.worker.ts). No local conversion happens
   *  here: each file is downloaded byte-for-byte from the CDN (see GAMEDB-MANUALS-PLANO.md "Manager
   *  (autofill)"). Reports exactly what happened, so a caller can tell "nothing to do" from "failed".
   *
   *  Which slot each manual goes to (and which leftover slots are swept) is decided by the pure
   *  `planManualSlots` (spec'd; read its header for the whole policy and the re-encode bug it fixes).
   *  This function is the I/O half: probe the card, run the plan, keep the slot→document map (`man_slots`
   *  in the game info file) current, and translate the plan's failures into the report's reason codes
   *  (nofile/nosha/slotsfull/download).
   *  `force` (auto-fill under 'update'/'replace') rewrites slot 0 even when the sha can't prove staleness. */
  private async installManuals(g: Entry, opts: { quiet?: boolean; force?: boolean; deferMap?: boolean } = {}): Promise<{ wrote: number; failed: number; dropped: number; reason: string }> {
    const quiet = opts.quiet ?? false;
    const manuals: Array<{ manualUrl?: string | null; sha256?: string | null; groupUuid?: string | null }> =
      g.manuals && g.manuals.length ? g.manuals : g.manualUrl ? [{ manualUrl: g.manualUrl, sha256: null }] : [];
    if (!manuals.length) return { wrote: 0, failed: 0, dropped: 0, reason: '' };
    if (!this.rootHandle) { if (!quiet) this.toast.show(this.i18n.translate('store.noCardConnected'), 'warn'); return { wrote: 0, failed: manuals.length, dropped: 0, reason: 'nocard' }; }
    this.update(g.id, { busy: 'guide' });
    const occupied = new Set<number>(); // slots taken on card (user guides + already-written manuals)
    const hashBySlot = new Map<number, string>();
    const headBySlot = new Map<number, { slug: number | null }>(); // the `.man` type slug per slot
    let wrote = 0, failed = 0, dropped = 0, reason = '';
    let probed = false;
    let slotMap: Map<number, string> | null = null; // slot→document once planned (see the finally)
    const fail = (why: string): void => { failed++; if (!reason) reason = why; };
    try {
      const stem = stemOf(g.file);
      const dirPath = infoDirFor(this.key(g.file));
      const dir = await this.ensureDir(dirPath);
      /* Occupied slots + their `.man` hashes, lets us skip a byte-identical manual and pick free slots.
         This used to ask the card for all 8 slot names and then read + SHA-256 every one that answered:
         a multi-MB read and hash per game on a card that already has manuals, and still 8 lookups per
         game on one that has none, for an answer the status probe already carries.

         `guides` is the probe's count of this game's `.man` slots, kept current by the worker pass that
         writes slot 0 and by this function's own finally. When it says the card holds none, the write
         decisions below are identical with an empty `occupied`, which is exactly what the 8 lookups
         would have produced, so the whole pass is skipped outright: no listing, no read, no hash.
         An extra manual is the exception and always probes: it has to pick a free slot, and picking one
         off a count that somehow understated the card would overwrite a user's guide (slots 2..8). The
         primary can't do that damage. Slot 0 is autofill's own file, rewritten in place.

         When it does probe, the occupied slots come from a listing shared by every game in the bucket
         (listManSlots), and bytes are read only for the slots an actual comparison will look at: the
         extras compare against every slot, a lone primary only ever against slot 0, and only when the
         GameDB published a sha to compare it with. */
      const known = this.entriesById().get(g.id) ?? g;
      const noSlotsOnCard = known.guides === 0 && known.manual !== 'has';
      if (!noSlotsOnCard || manuals.length > 1) {
        const hashes: 'all' | 'slot0' | 'none' = manuals.length > 1 ? 'all' : manuals[0].sha256 ? 'slot0' : 'none';
        for (const nn of await this.listManSlots(dirPath, dir, stem)) {
          occupied.add(nn);
          if (hashes === 'all' || (hashes === 'slot0' && nn === 0)) {
            const fh = await dir.getFileHandle(guideFileName(stem, nn)).catch(() => null);
            if (fh) hashBySlot.set(nn, await this.sha256Hex(new Uint8Array(await (await fh.getFile()).arrayBuffer())));
            // A slot we cannot hash is a slot nothing may ever be proven about: it can neither be
            // recognized as an installed document nor swept, so it just sits there. Say so, silently
            // it looks identical to "the user put a guide here", and the two need very different fixes.
            else console.warn('[man] guide slot could not be read, leaving it untouched:', g.file, 'slot', nn);
          }
          /* ...and the first 40 bytes: the `.man` header, whose type slug is the only identity a card
             carries without a `man_slots` map, which is to say, the only one available on the run that
             has to repair the damage (the map does not exist until a run writes it). Same read
             listGuides does to label a slot "Mapa"/"Guia"/"Encarte" in the guides dialog, and the reason
             the extras can be rewritten in place instead of spilling into new slots. Only for a game
             with extras, a lone primary owns slot 0 by address and needs no identity. */
          if (manuals.length > 1) {
            const head = await readFileHeader(dir, guideFileName(stem, nn), 40);
            if (head) {
              try { headBySlot.set(nn, { slug: parseManHeader(head).slug ?? null }); }
              catch {  }/* not a readable `.man` → no type, so it can never be adopted or swept */
            }
          }
        }
      }
      probed = true;
      // What the card says about which document is in each slot, and which manuals it was last synced to.
      // Preferred off the entry: auto-fill pre-loads every game info file (loadOnCardYml) and the write worker
      // rewrites `<rom>.yml` from metadata alone, so the entry's copy is the one that survives a run
      // intact. The same reason persistSyncTokens works off the pre-run `onCardYml` snapshot. Only a
      // game whose game info was never loaded (the per-game action, outside a run) pays a read.
      const gameInfo = g.manSlots === undefined || g.onCardYml === undefined ? await this.readInfoYml(g).catch(() => null) : undefined;
      const groups: ManSlotMap = g.manSlots ?? (parseManSlots(gameInfo?.[MAN_SLOTS_KEY]) as Map<number, string>);
      const syncMan = (g.onCardYml === undefined ? gameInfo?.['sync_man'] : g.onCardYml?.['sync_man']) ?? '';
      const hadOnCard = new Set(occupied); // what the card held before this pass (map repair on a failed write)
      const plan = planManualSlots(
        manuals,
        { probed: !noSlotsOnCard || manuals.length > 1, occupied, hashBySlot, headBySlot, groups, synced: new Set(syncMan.split('.').filter(Boolean)) },
        { force: opts.force },
      );
      const finalMap = new Map(plan.map);
      /* Deletions. `after` says when each one may go (see ManualSlotDrop): a duplicate whose surviving
         copy is already on the card can go now (and freeing that slot is often what makes room) while
         anything whose replacement this pass still has to fetch waits for that write to land.
         Isolated + best-effort per slot: a leftover we cannot delete is cosmetic and must never latch
         the card unwritable and abort a run that is otherwise succeeding. */
      const swept: Array<{ slot: number; reason: string }> = [];
      const wroteSlots = new Set<number>(); // slots whose write actually landed (feeds the report below)
      const stems = plan.drops.length ? this.stemsLower() : null;
      const sweep = async (nn: number, why: string): Promise<void> => {
        if (!occupied.has(nn)) return; // the game info file named a slot the card does not actually hold
        const name = guideFileName(stem, nn);
        /* `Game v1.02.man` is slot 2 of `Game v1` and slot 0 of `Game v1.02`. listManSlots keeps that
           ambiguity on purpose (whichever game asks, gets it) because it only ever cost a skipped
           write. A delete is not survivable that way: it would take the other game's official manual off
           the card. So a name that is also slot 0 of a stem the library actually has is never swept. */
        if (nn !== 0 && stems?.has((stem + '.0' + nn).toLowerCase())) {
          console.warn('[man] not sweeping', name, '— also slot 0 of another game on this card');
          return;
        }
        try {
          await this.card.remove(dir, name, { isolated: true });
          void this.manDirNames?.get(dirPath)?.then((s) => s.delete(name.toLowerCase())); // keep the shared listing true
          occupied.delete(nn); hashBySlot.delete(nn);
          dropped++; swept.push({ slot: nn, reason: why });
        } catch (err) { console.warn('[man] leftover slot could not be removed', g.file, nn, err); }
      };
      for (const d of plan.drops) if (d.after === null) await sweep(d.slot, d.reason);
      // `.man` is served zstd-compressed → inflate to the raw `.man`. The dedup hash is over the raw
      // bytes, which matches the GameDB's `sha256` (the raw `.man` sha) so re-runs skip identical ones.
      const put = async (m: { manualUrl?: string | null }, slot: number): Promise<void> => {
        const bytes = await fetchInflate(cdnUrl(m.manualUrl!) ?? m.manualUrl!);
        const name = guideFileName(stem, slot);
        await this.card.write(dir, name, bytes);
        void this.manDirNames?.get(dirPath)?.then((s) => s.add(name.toLowerCase())); // keep the shared listing true
        occupied.add(slot);
        hashBySlot.set(slot, await this.sha256Hex(bytes));
        wroteSlots.add(slot);
        wrote++;
      };
      let writeFailed = false;
      for (const step of plan.steps) {
        if (step.action === 'fail') { fail(step.reason); continue; }
        if (step.action === 'skip') { occupied.add(step.slot); continue; } // already on card, in the right slot
        try {
          await put(manuals[step.index], step.slot);
          // Whatever was waiting on this write now has its surviving copy on the card.
          for (const d of plan.drops) if (d.after === step.slot) await sweep(d.slot, d.reason);
        } catch (err) {
          console.error('[man] manual failed for', g.file, 'slot', step.slot, err);
          fail('download'); writeFailed = true;
          /* The map may only ever name slots that were actually written. A slot whose write failed goes
             back to what the card says about it, nothing at all when it held nothing, so a phantom
             reservation can never lock a slot away from the guides editor with no way out. */
          finalMap.delete(step.slot);
          const was = groups.get(step.slot);
          if (was && hadOnCard.has(step.slot)) finalMap.set(step.slot, was);
        }
      }
      /* The obsolete sweep goes last and only on a clean pass: nothing identifies which new document
         replaced which old copy, so the surviving copy is the whole installed set, and that set is only
         complete when every planned write landed and nothing failed. */
      if (!failed && !writeFailed) for (const d of plan.drops) if (d.after === 'all') await sweep(d.slot, d.reason);
      /* Everything this pass did to files it did not simply add, one row per game in the same post-run
         report the read-only-folder skips use. Replacing a document the user can see in the guides dialog
         is not a silent operation either, even though rewriting in place is far safer than deleting: the
         row names the slot and the document type, so "my Mapa changed" always has an answer. */
      const wroteOver = plan.adopted.filter((a) => wroteSlots.has(a.slot)); // only what actually landed
      const parts = [
        ...['dup', 'obsolete'].map((r) => {
          const nns = swept.filter((s) => s.reason === r).map((s) => s.slot);
          return nns.length ? `${r}:${nns.join('+')}` : '';
        }),
        wroteOver.length ? `adopted:${wroteOver.map((a) => `${a.slot}=${a.type}`).join('+')}` : '',
        plan.leftovers.length ? `left:${plan.leftovers.join('+')}` : '',
      ].filter(Boolean);
      if (parts.length) {
        // One reason per row, strongest first, the detail carries the rest.
        const why = wroteOver.length ? 'adopted' : swept.length ? 'swept' : 'leftover';
        this.pushFillError(this.entriesById().get(g.id) ?? g, 'guide', why, parts.join(' '));
      }
      // Record the slot→document map so the next re-encode resolves by identity instead of by bytes. Done
      // even when nothing was written: recognizing a slot is the new knowledge, an already-correct card
      // adopts its map here, at the cost of the one small game info file write below.
      // In a bulk run that write rides along with persistSyncTokens instead: a manual landed, so sync_man
      // advances and that pass rewrites this very `.yml` anyway. Thousands of games go through here on a
      // re-encode run, on a medium where close() is the whole cost of a small write.
      // (only on a clean write: a partial failure clears the `man` token again, and then that pass
      // never runs for this game. The map would have nowhere to ride.)
      // The window this opens: cancel the run between here and the token pass and the map exists only in
      // memory. Nothing is corrupted, and the reliable cure is the next full run: `sync_man` is not
      // stamped either, so the category stays due and the token pass writes the map then. (A per-game
      // action only heals a game whose game info file was not pre-loaded. Reading it is what defeats the entry
      // short-circuit; a reload clears `manSlots` and cures the rest.)
      if (!(opts.deferMap && wrote > 0 && !failed)) await this.persistManSlots(g, finalMap, gameInfo);
      slotMap = finalMap; // → the entry, in the finally (rides the busy/guides patch, no rebuild of its own)
      if (!quiet) {
        if (reason === 'slotsfull') this.toast.show(this.i18n.translate('store.manualSlotsFull'), 'warn');
        else if (failed) this.toast.show(this.i18n.translate('store.manualFailed', { error: reason }), 'warn');
        else if (wrote) this.toast.show(this.i18n.translate('store.manualInstalled'), 'ok');
      }
      return { wrote, failed, dropped, reason };
    } catch (err) {
      console.error('[man] manual download failed for', g.file, err);
      if (!quiet) this.toast.show(this.i18n.translate('store.manualFailed', { error: msg(err) }), 'warn');
      return { wrote, failed: failed + 1, dropped, reason: reason || 'error' };
    } finally {
      // reflect what's actually on card even on a mid-loop error (only when we managed to probe the slots)
      this.update(g.id, {
        busy: null, manual: occupied.has(0) ? 'has' : g.manual,
        ...(probed ? { guides: occupied.size } : {}),
        ...(slotMap ? { manSlots: slotMap.size ? slotMap : null } : {}),
      });
    }
  }

  /** Write the slot→document map into the game info file's `man_slots`, when the card doesn't already say exactly
   *  that. The entry side is patched by installManuals' own finally; this is the half that makes the map
   *  survive to the next session.
   *
   *  Same doctrine as persistSyncTokens: never create a `<rom>.yml` just to hold bookkeeping, never fail
   *  a run over it, and never touch `onCardYml`. That field is the PRE-RUN snapshot persistSyncTokens
   *  reads the old `sync_*` out of, and refreshing it here would hand it a game info file the worker has already
   *  stripped, dropping every token for a category this run didn't rewrite. */
  private async persistManSlots(g: Entry, map: Map<number, string>, gameInfo?: Record<string, string> | null): Promise<void> {
    if (this.card.unwritable) return;
    const value = (serializeManSlots(map) as string | null) ?? null;
    // The steady state (a card whose map is already right) must cost nothing: the entry's map came out
    // of the game info file (loadOnCardYml) and every writer puts it back verbatim, so "unchanged" is decidable
    // without touching the card at all. Thousands of games go through here on a full run.
    // Not taken when the caller already read the game info file: that read is the card's actual answer, and it is
    // the one that can disagree with the entry (a run that deferred its map write to persistSyncTokens
    // and was then cancelled leaves the entry ahead of the file, see installManuals' `deferMap`).
    if (gameInfo === undefined && g.manSlots !== undefined && manSlotsFor(g) === value) return;
    // `game info` is the read installManuals already paid for (undefined = it didn't need one).
    const cur = gameInfo !== undefined ? gameInfo : await this.readInfoYml(g).catch(() => null);
    if (!cur || (cur[MAN_SLOTS_KEY] ?? null) === value) return; // no game info to annotate, or already current
    const merged: Record<string, string> = { ...cur };
    if (value == null) delete merged[MAN_SLOTS_KEY]; else merged[MAN_SLOTS_KEY] = value;
    try {
      const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
      const text = buildYml(merged);
      await this.card.write(dir, stemOf(g.file) + '.yml', text);
      this.rememberYml(g.id, text);
    } catch (err) {
      console.warn('[man] slot map persist failed for', g.file, err); // bookkeeping: never fail the run over it
    }
  }

  /** Every ROM stem on the card, lowercased, for the one question a `.man` deletion has to ask before
   *  it fires (see installManuals' sweep). Built on demand (only when there is something to sweep) and
   *  memoized for exactly as long as the `.man` listing cache: a run sweeps hundreds of games and would
   *  otherwise walk the whole library once per game. Outside a run there is no owner to keep it true. */
  private stemNames: Set<string> | null = null;
  private stemsLower(): Set<string> {
    if (this.stemNames) return this.stemNames;
    const s = new Set(this._entries().map((e) => stemOf(e.file).toLowerCase()));
    if (this.manDirNames) this.stemNames = s;
    return s;
  }

  /** The slots the game info file's `man_slots` assigns to an official document, off the entry when it knows the
   *  map, off the card otherwise (the guides editor runs outside a fill, so nothing pre-loaded it). */
  private async reservedManSlots(g: Entry): Promise<Set<number>> {
    const map = g.manSlots !== undefined
      ? g.manSlots
      : (parseManSlots((await this.readInfoYml(g).catch(() => null))?.[MAN_SLOTS_KEY]) as ManSlotMap);
    return new Set<number>(map ? [...map.keys()] : []);
  }

  /** Mark a slot in the game info file's `man_slots` as the user's own guide (MAN_USER_TAG), see addGuide. */
  private async claimUserSlot(g: Entry, nn: number): Promise<void> {
    const cur = await this.readInfoYml(g).catch(() => null);
    const map = parseManSlots(cur?.[MAN_SLOTS_KEY]) as Map<number, string>;
    if (map.get(nn) === MAN_USER_TAG) return;
    map.set(nn, MAN_USER_TAG);
    this.update(g.id, { manSlots: map });
    await this.persistManSlots(g, map, cur);
  }

  /** Drop one slot from the game info file's `man_slots` (the user deleted that guide). Read off the card rather
   *  than the entry: this only ever runs outside a fill run (removeGuide is gated on `bulkBusy`), so the
   *  file is authoritative and no worker can be mid-rewrite of it. */
  private async forgetManSlot(g: Entry, nn: number): Promise<void> {
    const cur = await this.readInfoYml(g).catch(() => null);
    const map = parseManSlots(cur?.[MAN_SLOTS_KEY]) as Map<number, string>;
    if (!map.delete(nn)) return; // that slot was never an official document
    this.update(g.id, { manSlots: map.size ? map : null });
    await this.persistManSlots(g, map, cur);
  }

  /** The `.man` slots `stem` occupies in the info directory `path`.
   *
   *  Answered from the directory's `.man` file names, which are listed once per directory while the
   *  cache is armed (see manDirNames). A bucket holds hundreds of games, so listing it per game would
   *  trade 8 O(1) lookups for an O(bucket) walk each time, and an "Atualizar" over a card that already
   *  has manuals (where the no-slots skip never fires) would go quadratic.
   *
   *  Membership is tested against the exact names `guideFileName` writes, so this reproduces the
   *  per-slot `getFileHandle` probe it replaces one-for-one, including its case-insensitivity on FAT,
   *  and including how it treats a name that is ambiguous between two stems (`Game v1.02.man` is both
   *  slot 0 of `Game v1.02` and slot 2 of `Game v1`): whichever game asks, gets it, exactly as before. */
  private async listManSlots(path: string, dir: FileSystemDirectoryHandle, stem: string): Promise<Set<number>> {
    const names = await this.manDirListing(path, dir);
    const out = new Set<number>();
    for (const nn of GUIDE_SLOTS as number[]) if (names.has(guideFileName(stem, nn).toLowerCase())) out.add(nn);
    return out;
  }

  /** The lowercased `.man` file names in `dir`, cached per directory path while a run has the cache
   *  armed. Unreadable directory → empty, exactly what the per-slot probe reported. */
  private manDirListing(path: string, dir: FileSystemDirectoryHandle): Promise<Set<string>> {
    const cached = this.manDirNames?.get(path);
    if (cached) return cached;
    const p = (async () => {
      const names = new Set<string>();
      try {
        for await (const [name, h] of dir.entries()) {
          const n = name.toLowerCase();
          if (h.kind === 'file' && n.endsWith('.man')) names.add(n);
        }
      } catch {  }/* unreadable dir → treated as "no slots", exactly as the per-slot probe did */
      return names;
    })();
    this.manDirNames?.set(path, p); // installed before the first await → one walk per bucket, ever
    return p;
  }

  /** SHA-256 of a byte buffer as a lowercase hex string (for `.man` dedup vs the GameDB manSha256). */
  private async sha256Hex(bytes: Uint8Array): Promise<string> {
    const h = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---- Guides (in-game manual/PDF viewer, `.man`), user-supplied slots 2..8, not gamedb-fillable
   * ---- See models.ts Entry.guides + GuideInfo, lib/man.js (encoder/format), and the ciclo 2,
   * Contrato reconciliado in the ingame repo's IN-GAME-MENU-PLANO.md for the byte contract.
   * Slot 0 (`<stem>.man`) is now the AUTOFILL-OWNED official manual (see installManuals above +
   * GAMEDB-MANUALS-PLANO.md "Manager (autofill)"), this section's add/remove flow only ever
   * targets USER_GUIDE_SLOTS (2..8), so it never overwrites the official slot. */

  /** List the guides present on card for `g` (probes GUIDE_SLOTS; reads only the 40-byte header of
   *  each present `.man`, cheap even for a multi-MB file). Ordered by slot (0, 2..8). */
  async listGuides(g: Entry): Promise<GuideInfo[]> {
    if (!this.rootHandle) return [];
    const stem = stemOf(g.file);
    const dir = await this.getDir(infoDirFor(this.key(g.file)));
    if (!dir) return [];
    const out: GuideInfo[] = [];
    for (const nn of GUIDE_SLOTS) {
      const fileName = guideFileName(stem, nn);
      const head = await readFileHeader(dir, fileName, 40);
      if (!head) continue;
      try {
        const h = parseManHeader(head);
        let sizeBytes = 0;
        try { sizeBytes = (await (await dir.getFileHandle(fileName)).getFile()).size; } catch {  }/* metadata-only best-effort */
        // an official slug-tagged doc has no free-text title (its label comes from the slug), keep title
        // '' so consumers don't surface the font-decoder's '?' for the reserved slug byte.
        out.push({ nn, fileName, title: h.slug ? '' : h.title, slug: h.slug ?? null, npages: h.npages, nblocks: h.nblocks, zoomNblocks: h.zoomNblocks, zoom: h.zoom, sizeBytes });
      } catch (err) {
        console.warn('[man] unreadable guide header, skipping', fileName, err);
      }
    }
    return out;
  }

  /** Build a new user guide from a PDF or an ordered set of page images and write it to the next
   *  free slot in USER_GUIDE_SLOTS (2..8; cap MAX_USER_GUIDES). Slot 0 is reserved for the official
   *  GameDB manual (autofill-owned, see installManuals) and is never a candidate here, even when empty.
   *  Returns false (+ toast) if there's no card, the cap is already reached, or the render/encode/
   *  write fails. */
  async addGuide(
    g: Entry,
    input: { kind: 'pdf'; file: File } | { kind: 'images'; files: File[] },
    opts: { type: 'manual' | 'guide' | 'map' | 'insert' | 'other'; zoom?: boolean; spread?: 'auto' | 'on' | 'off' },
  ): Promise<boolean> {
    // Same doctrine as every other card mutation entry point: never write behind a bulk run. A
    // guide added mid-run would race installManuals' shared bucket listing (and a PDF render would
    // compete with ffmpeg for CPU anyway).
    if (this.bulkBusy()) return false;
    if (!this.rootHandle) { this.toast.show(this.i18n.translate('store.noCardConnected'), 'warn'); return false; }
    const stem = stemOf(g.file);
    const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
    const present = new Set<number>();
    for (const nn of GUIDE_SLOTS) if (await fileExists(dir, guideFileName(stem, nn))) present.add(nn);
    /* A slot the game info file's `man_slots` assigns to an official document is taken even when the file is not
       there right now (a failed/interrupted install). Auto-fill addresses documents by identity now, not
       by "first free slot", so it will rewrite exactly that slot on its next pass, a user guide parked
       there would be overwritten without a word. */
    const reserved = await this.reservedManSlots(g);
    const freeNn = USER_GUIDE_SLOTS.find((nn) => !present.has(nn) && !reserved.has(nn));
    if (freeNn === undefined) {
      const userCount = USER_GUIDE_SLOTS.filter((nn) => present.has(nn) || reserved.has(nn)).length;
      this.toast.show(this.i18n.translate('guides.cap', { count: userCount, max: MAX_USER_GUIDES }), 'warn');
      return false;
    }
    this.update(g.id, { busy: 'guide' });
    try {
      // Build the `.man` exactly like the gamedb: the document type baked as a slug byte in the header,
      // always with the 2× zoom section, so a locally-added guide is byte-format-compatible with the
      // official GameDB manuals (the firmware translates the slug into the viewer's language).
      const build = { slug: slugIdOfType(opts.type), zoom: opts.zoom ?? true, spread: opts.spread ?? 'auto' };
      const built = input.kind === 'pdf'
        ? await buildManFromPdf(input.file, build)
        : await buildManFromImages(input.files, build);
      await this.card.write(dir, guideFileName(stem, freeNn), built.bytes);
      // A `.man` landed behind installManuals' shared bucket listing, drop that path so a later
      // pass re-lists instead of treating the slot as free and overwriting this very guide.
      this.manDirNames?.delete(infoDirFor(this.key(g.file)));
      /* Claim the slot as the user's in the game info file's `man_slots` (MAN_USER_TAG). Auto-fill now recognizes
         an older copy of a document by the `.man` header's type slug, so without this marker a guide of
         a type the GameDB also serves could be taken for the stale official copy and rewritten in place.
         Marked, it is out of reach of adoption and of every sweep, permanently. */
      await this.claimUserSlot(g, freeNn);
      this.update(g.id, { guides: present.size + 1, busy: null });
      this.toast.show(this.i18n.translate('guides.added'), 'ok');
      return true;
    } catch (err) {
      this.update(g.id, { busy: null });
      console.error('[man] add guide failed for', g.file, err);
      this.toast.show(this.i18n.translate('guides.buildFailed', { error: msg(err) }), 'warn');
      return false;
    }
  }

  /** Remove one guide (by slot `nn`) from the card. Does not renumber the remaining slots. The
   *  design keeps NN stable per the reconciled contract (order = NN; see design doc D.5's proposal
   *  to defer reordering-by-renumbering to a later cycle). Works for slot 0 too (the official manual
   *  is still just a file), flips `manual` back to 'none' so auto-fill sees it as missing again. */
  async removeGuide(g: Entry, nn: number): Promise<void> {
    if (this.bulkBusy()) return; // see addGuide, never mutate slots behind a bulk run's listing
    if (!this.rootHandle) return;
    const stem = stemOf(g.file);
    try {
      const dir = await this.getDir(infoDirFor(this.key(g.file)));
      if (dir) await this.card.remove(dir, guideFileName(stem, nn));
      this.manDirNames?.delete(infoDirFor(this.key(g.file))); // slot freed behind the shared listing
      // ...and the game info file's map has to forget it too, or the slot stays reserved for the document that used
      // to be there: the next auto-fill pass would write it straight back over whatever the user puts in
      // the slot they just freed (see addGuide's `reserved`).
      await this.forgetManSlot(g, nn);
      let count = 0;
      for (const slot of GUIDE_SLOTS) if (await fileExists(dir, guideFileName(stem, slot))) count++;
      const patch: Partial<Entry> = { guides: count };
      if (nn === 0) patch.manual = 'none';
      this.update(g.id, patch);
      this.toast.show(this.i18n.translate('guides.removed'), 'ok');
    } catch (err) {
      console.error('[man] remove guide failed for', g.file, nn, err);
      this.toast.show(this.i18n.translate('guides.removeFailed', { error: msg(err) }), 'warn');
    }
  }

  /** Replace the on-card snapshot with a local image: write a standalone `.gss` (88c paletted, 1 frame)
   *  from the picked screenshot. Decoupled from the cover now (no .gd compositing). */
  async replaceSnapshot(g: Entry): Promise<void> {
    if (!this.rootHandle) return;
    const file = await pickImageFile();
    if (!file) return;
    this.update(g.id, { busy: 'snapshot' });
    try {
      const gss = await buildStaticShot(new Uint8Array(await file.arrayBuffer()), { fps: 0 });
      const stem = stemOf(g.file);
      const dir = await this.ensureDir(infoDirFor(this.key(g.file)));
      await this.card.write(dir, stem + '.gss', gss);
      await this.ensureFmvFlag(g, dir, stem);   // the firmware probes <rom>.gss only when this flag is set
      this.update(g.id, { snapshot: 'has', busy: null });
      if (this._selId() === g.id) this._infoRev.update((v) => v + 1); // refresh the open snapshot tile
      this.toast.show(this.i18n.translate('store.snapshotUpdated'), 'ok');
    } catch (err) {
      this.update(g.id, { busy: null });
      console.error('[gss] replace snapshot failed for', g.file, err);
      this.toast.show(this.i18n.translate('store.snapshotFailed', { error: msg(err) }), 'warn');
    }
  }

  /** Re-build the standalone `.gss` snapshot (88c, from the GameDB screenshot) for a game whose shot
   *  was missing/failed. Returns true only when a real .gss was actually written. */
  private async retryGdSnapshot(g: Entry): Promise<boolean> {
    if (!g.dirHandle || !this.rootHandle || !cdnUrl(g.screenshotUrl)) return false; // nothing to recover
    const ok = await this.genStaticShot(g, true);
    // Refresh the open panel only if this recovered game is the selected one (avoids per-game flicker).
    if (ok && this._selId() === g.id) this._infoRev.update((v) => v + 1);
    return ok;
  }

  /** The game-info fields written to the game info .yml (from the GameDB match metadata). Every
   *  localized description key is listed explicitly (null when the GameDB has no such translation)
   *  so this path also clears a translation that was removed upstream, the editor path, which omits
   *  the keys entirely, is the one that preserves what is on the card (see keepFromCard). */
  private gameInfoFields(g: Entry): Record<string, string | null> {
    return {
      title: g.title,
      developer: g.developer ?? null,
      publisher: g.publisher ?? null,
      release_year: g.releaseYear != null ? String(g.releaseYear) : null,
      players: g.players ?? null,
      genre: g.genre ?? null,
      special_chip: g.specialChip ?? null,
      description: g.description ?? null, // canonical English (the console's fallback)
      ...Object.fromEntries(DESC_LANG_LIST.map((l) => [`description_${l}`, g.descriptions?.[l] ?? null])),
    };
  }

  /* ---- "Preencher automaticamente": analyze → choose per category → write what the GameDB serves ---- */

  /** Open the auto-fill dialog scoped to a single game (the detail panel's "Preencher tudo"). */
  startAutoFillOne(id: string): Promise<void> {
    return this.startAutoFill(new Set([id]));
  }

  /** Open the auto-fill dialog scoped to the folder currently being viewed (and its subfolders). */
  startAutoFillFolder(): Promise<void> {
    return this.startAutoFill(new Set(this.fillScope().map((g) => g.id)));
  }

  /** Open the auto-fill dialog: identify the scope (so availability is known), then tally per category. */
  async startAutoFill(ids?: ReadonlySet<string>): Promise<void> {
    if (this._autoFill() || this.bulkBusy()) return;
    const epoch = ++this.autoFillEpoch; // so a close/re-open during analysis can't be overwritten by us
    const inScope = (g: Entry): boolean => (ids ? ids.has(g.id) : true) && !!g.fileHandle;
    const scope = this._entries().filter(inScope);
    if (!scope.length) { this.toast.show(this.i18n.translate('store.noGamesToFill'), 'info'); return; }
    // Identify the not-yet-identified so we know what the GameDB actually offers per game, in
    // batches (one gamedb request per 50), cancelled if the dialog is closed/superseded. Report
    // progress so a big folder doesn't sit on a blank spinner with no sense of time.
    const pending = scope.filter((g) => !g.identified);
    this._autoFill.set({
      ids: ids ?? null, total: scope.length, analyzing: true, counts: null,
      done: 0, analyzeTotal: pending.length, startedAt: Date.now(),
    });
    if (pending.length) await this.identifyEntries(pending, {
      shouldStop: () => this.autoFillEpoch !== epoch,
      onProgress: (done) => this._autoFill.update((s) => (s && s.analyzing ? { ...s, done } : s)),
    });
    if (this.autoFillEpoch !== epoch || !this._autoFill()) return; // dialog closed or superseded during analysis
    // Pre-load each matched game's on-card `.yml` (with its `sync_*` tokens) so staleness, "present but
    // a newer version exists on the GameDB". Can be tallied synchronously by fillCounts. Only matched
    // games with a game info file on card can be stale; the rest are skipped (no read).
    await this.loadOnCardYml(this._entries().filter((g) => inScope(g) && g.matched && g.info === 'has'));
    if (this.autoFillEpoch !== epoch || !this._autoFill()) return;
    const fresh = this._entries().filter(inScope);
    this._autoFill.set({ ids: ids ?? null, total: fresh.length, analyzing: false, counts: this.fillCounts(fresh) });
  }

  /** Read + cache each entry's on-card `<rom>.yml` fields (incl. `sync_*` tokens) onto `Entry.onCardYml`,
   *  so fillStale can compare versions without a per-game read during the synchronous tally. Pooled. */
  private async loadOnCardYml(entries: Entry[]): Promise<void> {
    try {
      await pool(entries, 8, async (e) => {
        const cur = this.entriesById().get(e.id);
        if (!cur || cur.onCardYml !== undefined) return; // already loaded this session
        const yml = await this.readInfoYml(cur).catch(() => null);
        // `manSlots` is hydrated in the same pass (and to null, not undefined, when the game info file has no map)
        // so every later game info rewrite can tell "this card has no map" from "nobody looked yet", the
        // difference between preserving the key and silently erasing it. See keepFromCard/manSlotsFor.
        const map = yml ? (parseManSlots(yml[MAN_SLOTS_KEY]) as Map<number, string>) : null;
        this.queueUpdate(e.id, { onCardYml: yml, manSlots: map && map.size ? map : null }); // batched: hundreds of ymls, one transition
      });
    } finally {
      // Mandatory: the caller tallies fillCounts()/fillStale() off `onCardYml` on the very next line.
      this.flushEntryUpdates();
    }
  }

  /** Does game `g` already have asset `cat` on the card? See `assetPresent` in board-stats.ts. The
   *  criteria are shared with the statbar board so both report the same number of missing assets. */
  private fillPresent(g: Entry, cat: FillCategory): boolean {
    return assetPresent(g, cat);
  }

  /** Can the GameDB (and what's on the card) supply asset `cat` for `g`? See `assetAvailable`, pure
   *  and spec'd, so the dialog's promise and what the run does can't drift apart. */
  private fillAvailable(g: Entry, cat: FillCategory): boolean {
    return assetAvailable(g, cat);
  }

  /** Which on-card `sync_*` token governs a category's freshness. capa/tela/prévia/cheats all ride the
   *  single package hash (one `.s2pkg` is rebuilt whenever any of its members changes); info tracks the
   *  metadata digest; manual its own manuals digest. */
  private static readonly CAT_SYNC_KEY: Record<FillCategory, 'sync_pkg' | 'sync_meta' | 'sync_man'> = {
    capa: 'sync_pkg', tela: 'sync_pkg', previa: 'sync_pkg', cheats: 'sync_pkg', info: 'sync_meta', manual: 'sync_man',
  };

  /** Is category `cat` present on the card but outdated vs the GameDB? Compares the token recorded in the
   *  on-card `.yml` (`sync_*`) against the current server token. When the card has no recorded token
   *  (synced before versioning): `info` is verified locally (metadata field compare, exact); the
   *  package/manual categories can't be verified without downloading, so they're treated as current
   *  (adopt-as-baseline, see persistSyncTokens), never reported stale from a bare legacy `.yml`. */
  /**
   * Does this entry own the `<stem>.yml` its assets are recorded in?
   *
   * Every asset on the card is addressed by the ROM's filename, `/sd2snes/info/<BB>/<stem>....`, with
   * `sgb/` the only namespace that splits it (the firmware builds the very same path, `fileops.c`
   * path_asset). So `C/Chou Aniki (Japan).sfc` and `_BSX/Chou Aniki (Japan).bs`, a SNES release and
   * its Satellaview counterpart, two different GameDB games, resolve to one game info file and one set of
   * assets. Counted per entry, each reads the other's recorded version as "outdated": a run stamps the
   * SNES token, the BSX copy goes stale, the next run stamps the BSX token and the SNES copy goes
   * stale. Forever, on a card that is already correct. That ping-pong is what kept re-offering the
   * same games after every single fill.
   *
   * The game info file names an owner in `rom:`, but only by filename, which is exactly what these copies have
   * in common, so it cannot separate `_INFIDELITY/Contra SNES/Contra SNES.sfc` from the USA and jpn
   * builds beside it in `sfc choice/`. It is a strong hint and nothing more, so it only breaks the tie
   * one way: a copy the game info file does not name yields to one it does, and among equals the lowest id wins.
   * Stable across runs, so the card converges instead of oscillating.
   *
   * Not a fix for the sharing itself: the console shows one of them too. Separating them for real
   * needs a namespace of its own in the firmware's path builder, like `sgb/`.
   */
  private ownsGameInfo(g: Entry): boolean {
    return this.gameInfoOwners().get(gameInfoKeyOf(this.key(g.file))) === g.id;
  }

  /**
   * Copy a freshly written `.cov` into every other copy of that ROM filename.
   *
   * The cover is the one asset that does not live in the shared bucket, it sits beside the ROM, so
   * each copy has its own, and the console reads the one in the folder you are browsing. Only the
   * elected owner writes (see ownsGameInfo), and the owner can perfectly well be the copy in `bkup/` or
   * in `sfc choice/JPN/`: refreshing only its folder leaves the copy you actually play showing the old
   * art. Same bytes, one extra write per sibling, and it only runs when a cover was really written.
   *
   * Best-effort by design: a sibling in a read-only folder is skipped, exactly like the primary write,
   * and never fails a run over a thumbnail.
   */
  private async mirrorCovToSiblings(id: string, cov: Uint8Array): Promise<void> {
    const src = this.entriesById().get(id);
    if (!src) return;
    const key = gameInfoKeyOf(this.key(src.file));
    const name = stemOf(src.file) + '.cov';
    for (const g of this._entries()) {
      if (g.id === id || !g.dirHandle || gameInfoKeyOf(this.key(g.file)) !== key) continue;
      // Same folder as the owner (two entries can share one) → the write already happened.
      if (g.dirHandle === src.dirHandle) continue;
      try {
        // isolated: a read-only sibling folder must skip, never latch the card unwritable mid-run.
        await this.card.write(g.dirHandle, name, cov, { isolated: true });
        this.queueUpdate(g.id, { cover: 'has', thumbUrl: covToDataUrl(cov) });
      } catch {  }/* read-only folder / vanished copy → skipped, same as the owner's own write */
    }
  }

  /** Shared-game info key → the single entry that speaks for it. Recomputed with the library (and with
   *  `onCardYml`, which is what turns the `rom:` hint on). */
  private readonly gameInfoOwners = computed(() => electGameInfoOwners(
    this._entries(),
    (g) => gameInfoKeyOf(this.key(g.file)),
    (g) => g.id,
    (g) => g.onCardYml?.['rom'] === g.file,
    (g) => (g.folder ? g.folder.split('/').length : 0), // card root = 0, `sfc choice/JPN` = 2
  ));

  private fillStale(g: Entry, cat: FillCategory): boolean {
    if (!this.fillPresent(g, cat) || !this.fillAvailable(g, cat) || !this.ownsGameInfo(g)) return false;
    const desired = syncTokensFromMatch(g);
    const key = LibraryStore.CAT_SYNC_KEY[cat];
    const want = desired[key];
    if (!want) return false; // server has no token (e.g. local-fallback URL / no manuals) → can't judge
    const stored = g.onCardYml?.[key] ?? null;
    if (stored != null) return stored !== want; // recorded token → precise compare
    // legacy `.yml` (no token yet): `info` is verified locally (exact field compare, no download);
    // the package/manual categories can'T be verified without downloading, so a missing token means
    // "unknown → treat as stale" and let Update refresh it (which then stamps the real token). We do not
    // adopt-as-current here: assuming the on-card asset matches the server would permanently hide a real
    // update whenever the card's art is actually older than the GameDB's.
    if (key === 'sync_meta') return !this.metaFieldsMatch(g, g.onCardYml);
    // ...but only when there is a game info file to stamp the refreshed token into. With no `<rom>.yml` on the
    // card, persistSyncTokens has nowhere to record the result (it never creates a game info file just for
    // bookkeeping), so flagging this would re-offer the same game on every single run, forever.
    return g.info === 'has';
  }

  /** True when the given on-card `.yml` metadata equals what the current match would write (legacy `info`
   *  staleness, verified without the sync_meta token). Compares the firmware fields after the same
   *  normalization buildYml applies (falsy omitted; `"`→`'`; CR/LF→space; trim). */
  private metaFieldsMatch(g: Entry, y: Record<string, string> | null | undefined): boolean {
    if (!y) return false; // no game info to compare → treat as needing (re)write
    const norm = (v: unknown): string => (v == null || v === '' ? '' : String(v).replace(/"/g, "'").replace(/\r|\n/g, ' ').trim());
    const server: Record<string, unknown> = {
      title: g.title, developer: g.developer, publisher: g.publisher, release_year: g.releaseYear != null ? String(g.releaseYear) : null,
      players: g.players, genre: g.genre, special_chip: g.specialChip, description: g.description,
      rom: g.file, region: g.region ?? null, gamedb_id: g.gamedbId ?? null,
      // the localized descriptions are part of the game info file too: a card written before they existed (or
      // before a translation landed) has to read as stale, or it would never be rewritten
      ...Object.fromEntries(DESC_LANG_LIST.map((l) => [`description_${l}`, g.descriptions?.[l] ?? null])),
    };
    for (const k of Object.keys(server)) if (norm(server[k]) !== norm(y[k])) return false;
    return true;
  }

  /** Tally, over `list`: `present` already on the card, `available` the GameDB can supply, `missing`
   *  available-and-not-present (what "Completar" generates), `stale` present-but-outdated (what
   *  "Atualizar" rewrites). */
  private fillCounts(list: Entry[]): FillCounts {
    const cats = FILL_CATS;
    const zero = (): FillTally => ({ capa: 0, tela: 0, previa: 0, info: 0, cheats: 0, manual: 0 });
    const present = zero(), available = zero(), missing = zero(), stale = zero();
    for (const g of list) {
      for (const c of cats) {
        const p = this.fillPresent(g, c), a = this.fillAvailable(g, c);
        if (p) present[c]++;
        if (a) available[c]++;
        if (a && !p) missing[c]++;
        if (p && this.fillStale(g, c)) stale[c]++;
      }
    }
    return { present, available, missing, stale };
  }

  /** Rough average written bytes per asset type (format-derived) for the dialog's size estimate. The
   *  Time side auto-calibrates from real runs via saveThroughput(). `man` is a rough average for a
   *  ready-made `.man` with zoom (the GameDB's, downloaded as-is), a multi-page manual's zoom section
   *  is ~4-5x the 1x section (see lib/man.js BLOCK_BYTES), so this runs far bigger than the other
   *  per-game members; no per-game size comes back from the lookup, so it's a flat estimate. */
  private static readonly EST_BYTES = { cov: 42_000, gcv: 17_000, gss: 8_000, fmv: 800_000, pcm: 4_200_000, yml: 1_500, man: 2_000_000 };
  private bytesForCat(cat: FillCategory, previaAudio = false): number {
    const B = LibraryStore.EST_BYTES;
    switch (cat) {
      case 'capa': return B.cov + B.gcv; // .cov + .gcv
      case 'tela': return B.gss;
      case 'previa': return B.fmv + (previaAudio ? B.pcm : 0); // .fmv (+ .pcm only with audio)
      case 'info': return B.yml;
      case 'cheats': return B.yml;
      case 'manual': return B.man;
    }
    return 0;
  }
  /** Measured CARD-WRITE throughput in bytes/sec (ewma across runs, persisted); default ~2.5 MB/s. */
  private throughputBps(): number {
    const v = Number(localStorage.getItem('sd2_mbps'));
    return v > 0 ? v : 2.5 * 1048576;
  }
  saveThroughput(bytesPerSec: number): void {
    try {
      const prev = Number(localStorage.getItem('sd2_mbps')) || bytesPerSec;
      localStorage.setItem('sd2_mbps', String(Math.round(prev * 0.6 + bytesPerSec * 0.4))); // smooth across runs
    } catch {  }/* localStorage unavailable */
  }
  /** Assumed download throughput (bytes/sec) for the .s2pkg bundles. Network is usually not the
   *  bottleneck (the SD card is), so a fixed estimate is fine; persisted/overridable later. */
  private netBps(): number {
    const v = Number(localStorage.getItem('sd2_netbps'));
    return v > 0 ? v : 8 * 1048576;
  }

  /** Estimate size + time for a fill plan, download (the per-game .s2pkg bundles, real sizes from the
   *  GameDB when available) and write (per category, to the slow card). They pipeline, so total time ≈
   *  max(download, write). Note the bundle is per-game: touching a game downloads its whole .s2pkg even
   *  if only one category is written. */
  fillEstimate(plan: FillPlan, previaAudio = false): {
    rows: Partial<Record<FillCategory, { bytes: number; sec: number }>>;
    writeBytes: number; writeSec: number; downloadBytes: number; downloadSec: number; totalSec: number;
  } | null {
    const st = this._autoFill();
    const counts = st?.counts;
    if (!counts) return null;
    const cardBps = this.throughputBps();
    const netBps = this.netBps();
    // 'manual' is downloaded on its own (a direct .man fetch, not a .s2pkg member). PkgCats is the
    // subset that rides the per-game bundle, used to decide whether that bundle needs fetching at all.
    const pkgCats: FillCategory[] = ['capa', 'tela', 'previa', 'info', 'cheats'];

    // Write: package categories are a count × format-derived average; the `.man` (much bigger, the inflated
    // raw doc) uses real per-manual raw sizes, summed in the per-game loop below (added to `rows.manual`).
    const rows: Partial<Record<FillCategory, { bytes: number; sec: number }>> = {};
    let writeBytes = 0;
    for (const cat of pkgCats) {
      const mode = plan[cat];
      if (mode === 'off') continue;
      // 'update' is cumulative (missing + stale), see fillNeeds; 'replace' is every game with a source.
      const n = mode === 'replace' ? counts.available[cat] : mode === 'update' ? counts.missing[cat] + counts.stale[cat] : counts.missing[cat];
      if (!n) continue;
      const bytes = n * this.bytesForCat(cat, previaAudio);
      rows[cat] = { bytes, sec: bytes / cardBps };
      writeBytes += bytes;
    }

    // Download (per game) + the manual write. Each touched game downloads one .s2pkg (audio-less base +
    // the separated `.pcm.zst` when audio is on); the `.man.zst` is a separate direct download that inflates
    // to the raw `.man` on the card, so it counts toward both download (compressed) and write (raw).
    const ids = st?.ids ?? null;
    const inScope = (g: Entry): boolean => (ids ? ids.has(g.id) : true) && !!g.fileHandle;
    let downloadBytes = 0;
    let manualWriteBytes = 0;
    if (writeBytes > 0 || plan.manual !== 'off') {
      for (const g of this._entries()) {
        if (!inScope(g)) continue;
        if (pkgCats.some((c) => plan[c] !== 'off' && this.fillNeeds(g, c, plan))) {
          const full = g.packageBytes ?? (g.videoUrl ? 1_500_000 : 80_000);
          const wantPcm = previaAudio && this.fillNeeds(g, 'previa', plan);
          // New audio-less packages fetch the separated `.pcm.zst` on top of the (audio-less) base; legacy
          // packages embed the `.pcm` inside `full` (g.pcmUrl null → no extra).
          const audioExtra = wantPcm && g.pcmUrl ? (g.pcmBytes ?? LibraryStore.EST_BYTES.pcm) : 0;
          downloadBytes += (wantPcm ? full : (g.packageNoAudioBytes ?? full)) + audioExtra;
        }
        if (this.fillNeeds(g, 'manual', plan)) {
          // per manual: compressed `.man.zst` (download) + raw `.man` (card write), real GameDB sizes when
          // present, else the flat average. A facet may have several manuals.
          const mans = g.manuals?.length ? g.manuals : (g.manualUrl ? [null] : []);
          for (const m of mans) {
            downloadBytes += m?.manBytes ?? this.bytesForCat('manual');
            manualWriteBytes += m?.manRawBytes ?? this.bytesForCat('manual');
          }
        }
      }
    }
    if (manualWriteBytes) { rows.manual = { bytes: manualWriteBytes, sec: manualWriteBytes / cardBps }; writeBytes += manualWriteBytes; }
    const writeSec = writeBytes / cardBps;
    const downloadSec = downloadBytes / netBps;
    return { rows, writeBytes, writeSec, downloadBytes, downloadSec, totalSec: Math.max(writeSec, downloadSec) };
  }

  /** Whether game `g` needs category `cat` generated under `plan` (mode + on-card presence + GameDB
   *  source). The ladder itself lives in `fillModeActs` (board-stats.ts), pure and unit-tested; this
   *  only feeds it this game's state. */
  private fillNeeds(g: Entry, cat: FillCategory, plan: FillPlan): boolean {
    const mode = plan[cat];
    if (mode === 'off') return false;
    const available = this.fillAvailable(g, cat);
    const present = available && this.fillPresent(g, cat);
    return fillModeActs(mode, { available, present, stale: present && this.fillStale(g, cat) });
  }

  /** Run the package-write jobs in a dedicated Web Worker (core/autofill.worker.ts) so they keep full
   *  speed even when the tab is backgrounded (worker threads aren't throttled like an inactive tab's main
   *  thread). Resolves to whether the worker's card-writer latched unwritable. Falls back (resolve, no
   *  jobs done) if the worker can't spawn, the caller then handles those games on the main thread. */
  private runWriterWorker(jobs: AutofillJob[], onProgress: (m: WriterProgress) => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./autofill.worker', import.meta.url), { type: 'module' });
      } catch (e) {
        console.error('[autofill] worker spawn failed; will fall back to main thread', e);
        resolve(false);
        return;
      }
      this.writerWorker = worker;
      const finish = (unwritable: boolean) => { worker.terminate(); if (this.writerWorker === worker) this.writerWorker = null; resolve(unwritable); };
      worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m?.type === 'progress') onProgress(m as WriterProgress);
        else if (m?.type === 'fatal') { if (m.error) { this.fillFailReason = m.error; console.error('[autofill] worker write fatal:', m.error); } }
        else if (m?.type === 'done') { if (m.error) this.fillFailReason = m.error; finish(!!m.unwritable); }
      };
      worker.onerror = (e) => { console.error('[autofill] worker error', e); finish(false); };
      worker.postMessage({
        type: 'start',
        rootHandle: this.rootHandle,
        jobs,
        cfg: { games: AUTOFILL_CONCURRENCY, smallMax: 6, largeMax: 2, largeBytes: 128 * 1024 },
      });
    });
  }

  async runAutoFill(plan: FillPlan, previaAudio = false): Promise<void> {
    const st = this._autoFill();
    if (!st) return;
    const ids = st.ids;
    this._autoFill.set(null);
    if (this.bulkBusy()) return;
    const inScope = (g: Entry): boolean => (ids ? ids.has(g.id) : true) && !!g.fileHandle;
    let targets = this._entries().filter(inScope);
    if (!targets.length) return;
    const cur = (g: Entry): Entry => this.entriesById().get(g.id) ?? g;

    /* Confirming the auto-fill raises the detailed progress modal (the bar alone can't say which
       phase is running, nor how long is left). Raised here, past every early return, and in the
       same synchronous stretch as the first `bulkBegin` below, rather than in the dialog: the
       latch and the bar have to become true together, or the auto-close effect could run in the gap
       between them, see a latch with no bar, and drop it before the run even starts. */
    this.openProgress();
    this.cancelImport = false;
    // "Atualizar"/"Substituir" exist to act on what changed upstream, and they decide that by comparing
    // the card's `sync_*`/`metaRev` tokens against the ones in the match. A match resolved from a cached
    // lookup carries the tokens the server had when it was cached, so against a cache, "Atualizar"
    // compares yesterday's card to yesterday's server and finds nothing: a silent no-op on the one mode
    // whose entire purpose is to find something. So re-ask the GameDB first, accepting only answers from
    // the last few minutes (AUTOFILL_FRESH_MS), in practice the server, but without punishing a re-run.
    //
    // Scoped to what the plan can actually touch (`needsGamedbRefresh`), not to the whole scope. This
    // used to run over every game in scope, on the argument that a game the cache says has nothing might
    // have gained a cover upstream. True, but that is what the gamedb cache's TTL and the explicit
    // "Atualizar dados do GameDB" button are for. Paying for it here made the pass cost one pass over the
    // entire library on every Atualizar run, however small the run: a 6392-game card asked for 3 cheats
    // sat on "Identificando... 3301/6392" before writing 859 KB. `assumeCrc` removes the other half of that
    // cost. These entries were checksummed by the analysis seconds ago, so there is nothing to re-derive.
    const refreshTargets = targets.filter((g) => needsGamedbRefresh(g, plan));
    if (refreshTargets.length) {
      // try/finally around the whole pre-pass: it owns the progress bar before the main run's own
      // try/finally exists, so anything that throws here would otherwise leave `_bulk` non-null
      // forever, and a non-null `_bulk` makes bulkBusy() reject every later operation.
      let ok = false;
      try {
        // Not `store.identifying`: nothing is being re-analyzed here (no card reads, no checksums), and
        // labelling it "Identificando..." made a 3-file run look like a full re-scan of the card.
        this.bulkBegin(refreshTargets.length, this.i18n.translate('store.checkingUpdates'), true);
        await this.identifyEntries(refreshTargets, {
          // Recent, not brand-new: these tokens only have to be newer than what the card holds, and a
          // hard bypass would make every re-run (after a cancel, or a run that died half-way) pay the
          // full lookup pass again.
          freshWithin: AUTOFILL_FRESH_MS,
          // The scope was just analysed (startAutoFill identified it), so every entry already carries the
          // CRC of the bytes on the card. Re-deriving it would mean a getFile() per game purely to
          // re-validate a checksum cache we are not going to use.
          assumeCrc: true,
          shouldStop: () => this.cancelImport,
          onProgress: (n) => this.bulkProgress(n),
        });
        if (this.cancelImport) {
          this.toast.show(this.i18n.translate('store.stoppedNothingWritten'), 'info');
          return;
        }
        // A game the refresh has only now matched never had its on-card `.yml` read (startAutoFill only
        // pre-loads the already-matched ones), and fillStale compares against exactly that. Cheap: the
        // helper skips every entry already loaded this session.
        await this.loadOnCardYml(this._entries().filter((g) => inScope(g) && g.matched && g.info === 'has'));
        // Re-read last: both the identify and the yml load flushed new entry objects into `_entries`,
        // and `p1` below decides what to fetch from `fillStale`, which reads `onCardYml`. Off a stale
        // array every game reads as "no game info loaded" → up-to-date games re-enter the run and the
        // worker downloads their whole `.s2pkg` to write nothing.
        targets = this._entries().filter(inScope);
        ok = true;
      } catch (err) {
        console.error('[autofill] pre-run GameDB refresh failed', err);
        this.toast.show(this.i18n.translate('store.gamedbTryAgain'), 'warn');
        return;
      } finally {
        if (!ok) this._bulk.set(null); // on the success path the main run re-labels the bar right below
      }
    }
    this.card.resetWriteHealth(); // fresh write-health for this run (latches if the card goes unwritable)
    this.fillFailReason = '';     // clear the last captured real failure reason
    this.runErrors = [];          // fresh per-run skipped-artifact report
    this._fillReport.set(null);
    let capas = 0, telas = 0, infos = 0, cheats = 0, previas = 0, manuals = 0, covFail = 0;
    // Obsolete/duplicate guide slots this run swept (see planManualSlots' drops). Named in the summary
    // And per game in the report, anything that deletes off the user's card has to say so.
    let guideDups = 0;
    let workerDead = false; // the write worker's card-writer latched unwritable
    /**
     * Every directory this run may write into, the scope of the post-run junk sweep.
     *
     * Built here on the main thread from the job plan rather than reported back by the worker,
     * because it is derivable: a game's writes land in exactly three places, and which three is a
     * pure function of its ROM filename + the card's layout (see `key()`). Keeping it here means
     * the worker protocol does not have to grow a channel just to say what we already know, and it
     * covers the main-thread passes (the covgen fallback, the manual retry, persistSyncTokens) for
     * free, those write to the same directories, just later.
     */
    const touched = new Set<string>();
    let junkSwept = 0;
    /* Read off `cancelImport` in the finally, before the junk sweep resets it for its own Cancel
       button. The summary toast below has to report whether the run was cancelled. */
    let cancelled = false;
    /* Games whose preview was planned but whose package didn't carry the `.fmv`.
       Auto-fill never encodes video (no ffmpeg, no mp4 download): the clip has to come ready from the
       GameDB, so these are skipped, named in the post-run report, and, because the game info file handed to the
       worker already had `fmv: 1` baked in, get that now-orphan flag taken back out (see below). */
    const previaSkipped = new Set<string>();
    // Which sync-token groups were (re)written per game this run → persistSyncTokens advances only those
    // tokens in the `<rom>.yml` (untouched-but-stale categories keep their old token so they stay flagged).
    const tokenWrites = new Map<string, { pkg?: boolean; pcm?: boolean; man?: boolean; meta?: boolean }>();
    const markWrote = (id: string, k: 'pkg' | 'pcm' | 'man' | 'meta'): void => {
      const t = tokenWrites.get(id) ?? {}; t[k] = true; tokenWrites.set(id, t);
    };
    // `sync_man` is a digest of all of the game's manuals, so it may only advance once the card holds
    // the whole set. When part of it couldn't be installed, clear the flag: stamping it anyway would
    // declare the category up to date while a manual is still missing.
    const unmarkWrote = (id: string, k: 'pkg' | 'pcm' | 'man' | 'meta'): void => {
      const t = tokenWrites.get(id); if (t) { delete t[k]; if (!Object.keys(t).length) tokenWrites.delete(id); }
    };

    // A passada única: capa + tela + game info + cheats + prévia + manual
    // 'previa' entra aqui como qualquer outra categoria: o `.fmv` sai pronto do `.s2pkg`, então é só mais
    // um membro do pacote que já está em mãos. Não existe mais uma segunda fase de vídeo, quem não tiver
    // clipe no pacote é pulado e vai para o relatório (auto-fill não roda ffmpeg). 'manual' também anda
    // junto: é um download direto do `.man` (independe do `.s2pkg`), então um jogo só-manual entra igual.
    const p1 = targets.filter((g) => FILL_CATS.some((c) => this.fillNeeds(g, c, plan)));
    this.bulkBegin(p1.length, this.i18n.translate('store.generatingCoversData'), true);
    const calT0 = Date.now();
    const calBytes0 = this.card.writtenBytes;
    // Bytes the worker wrote across this run: `this.workerBytes` is per-phase (bulkBegin resets it), and
    // the phases after it would zero it before the usage total is folded in the finally.
    let runWorkerBytes = 0;
    try {
    // Build the work orders: games with a pre-built .s2pkg go to the dedicated write worker (the fast
    // path that keeps running at full speed even when the tab is backgrounded, worker threads aren't
    // throttled like an inactive tab's main thread, the fix for the run pausing/slowing when unfocused).
    // Games with no package fall back to main-thread covgen/ffmpeg generation. The .yml game info + cheats
    // text are pre-serialized here (the worker only does I/O: fetch .s2pkg → write members to the card).
    const jobs: AutofillJob[] = [];
    const mainOnly: Entry[] = [];
    // Worker-handled games that still need a main-thread manual pass: >1 manual (the worker only writes
    // the primary), or the worker's `.man` fetch/write failed (`retry`. Then a failure is reported, so a
    // manual that can't land never silently keeps its category flagged as outdated forever).
    const manualPass = new Map<string, { retry: boolean; err: string }>();
    const needManual = (id: string, retry: boolean, err = ''): void => {
      const p = manualPass.get(id) ?? { retry: false, err: '' };
      manualPass.set(id, { retry: p.retry || retry, err: p.err || err });
    };
    /* Who the manual category acts on, decided once, here, before anything has been written. Every
       later pass reads this set instead of re-asking `fillNeeds`. The answer stops being the same
       question halfway through the run: the write worker flips `manual` to 'has' the moment slot 0
       lands, and the passes that install the extras run after it. Re-asking is what made
       Completar/Atualizar install exactly one manual per game (see servedManualCount). */
    const wantManual = new Set<string>();
    /** Games the worker already counted in `manuals` (which counts games, not files), so the extras
     *  pass adds one only for a game the worker did not write a `.man` for at all. */
    const manCounted = new Set<string>();
    for (const entry of p1) {
      const g = cur(entry);
      const nCapa = this.fillNeeds(g, 'capa', plan), nTela = this.fillNeeds(g, 'tela', plan),
        nInfo = this.fillNeeds(g, 'info', plan), nCheats = this.fillNeeds(g, 'cheats', plan),
        nPrevia = this.fillNeeds(g, 'previa', plan), nManual = this.fillNeeds(g, 'manual', plan);
      if (nManual) wantManual.add(g.id);
      // Only write the (big) .pcm when a preview is wanted with audio. New packages are audio-less by
      // construction (pcm separated); only legacy rows still offer a "no-audio" variant, prefer it
      // there when pcm isn't wanted (it skips the embedded .pcm, a much smaller download).
      const wantPcm = nPrevia && previaAudio;
      // Split the capa into its two halves so a game that only lacks the game info .gcv (its .cov is already
      // on the card) gets just the .gcv written -- not a needless .cov rewrite (matters in bulk: rewriting
      // every existing .cov would ~double the write volume). 'replace' rewrites both.
      // Rewrite both halves under 'replace', and under 'update' only for a genuinely stale game (the
      // package changed → the .cov and .gcv are both out of date). 'update' also covers games that are
      // merely missing a half (it's cumulative now), those fill just that half, like 'complete'.
      const rewriteCapa = plan.capa === 'replace' || (plan.capa === 'update' && this.fillStale(g, 'capa'));
      const wantCov = nCapa && (rewriteCapa || !(g.cover === 'has' || g.cover === 'custom'));
      const wantGcv = nCapa && (rewriteCapa || g.gcv !== 'has');
      const pkgUrl = (!wantPcm && g.packageNoAudioUrl) ? g.packageNoAudioUrl : g.packageUrl;
      const url = pkgUrl ? (cdnUrl(pkgUrl) ?? pkgUrl) : null;
      // When the variant was picked, hand the worker the base package too: a variant row can outlive
      // its stored object (all 4.5k of them 404'd in 2026-08), and the base carries the same members.
      const fallbackPkgUrl = pkgUrl !== g.packageUrl && g.packageUrl ? (cdnUrl(g.packageUrl) ?? g.packageUrl) : null;
      // New packages are audio-less: when audio is wanted, the worker fetches the separated `.pcm.zst`.
      // Legacy packages embed the `.pcm` (g.pcmUrl null) → the worker reads it from the s2pkg instead.
      const pcmUrl = wantPcm && g.pcmUrl ? (cdnUrl(g.pcmUrl) ?? g.pcmUrl) : null;
      // The manual is a direct .man fetch, not a .s2pkg member (never derived/converted locally,
      // just downloaded as-is; see lib/man.js/GAMEDB-MANUALS-PLANO.md).
      // the primary manual (region-first: g.manuals[0]) → slot 0. Additional manuals are installed by a
      // post-worker installManuals pass (which dedups this slot-0 write). Falls back to the deprecated scalar.
      const primaryManUrl = g.manuals?.[0]?.manualUrl ?? g.manualUrl ?? null;
      /* ...but only when slot 0 is actually part of the work. The category is now "needed" whenever any
         of the served documents is missing (servedManualCount), so under 'complete' a game that only
         lacks its extras would otherwise re-download and rewrite a primary that is already on the
         card, the single biggest file of the set, on every run. 'update'/'replace' still rewrite it:
         that is the same `force` the extras pass runs with. */
      const wantSlot0 = nManual && (g.manual !== 'has' || plan.manual === 'update' || plan.manual === 'replace');
      const manualUrl = wantSlot0 && primaryManUrl ? (cdnUrl(primaryManUrl) ?? primaryManUrl) : null;
      /* Record the sweep scope before the mainOnly branch below: a game that falls back to the main
         thread writes to the very same directories, so both paths must be covered. The ROM's own
         folder is the important one, the `.cov` that lands next to the ROM is what makes macOS
         mint a `._<name>` and Chromium a `<name>.crswap`, and nothing has ever cleaned out there. */
      const dirKey = this.key(g.file);
      if (nCapa || nTela || nInfo || nPrevia || nManual) touched.add(infoDirFor(dirKey));
      if (nCheats) touched.add(cheatsDirFor(dirKey));
      if (nCapa) touched.add(g.folder);
      // A game with no package and no manual to fetch has nothing the worker can do -> main thread
      // (raw covgen/ffmpeg from coverUrl/screenshotUrl/videoUrl). A manual-only game with no package
      // still gets a worker job (packageUrl null), the worker fetches+writes the manual on its own.
      if (!url && !manualUrl) { mainOnly.push(g); continue; }
      if (nManual && (g.manuals?.length ?? 0) > 1) needManual(g.id, false); // worker writes primary; extras below
      jobs.push({
        id: g.id, packageUrl: url, fallbackPackageUrl: fallbackPkgUrl, manualUrl, pcmUrl, file: g.file, mode: this.layoutMode(), stem: stemOf(g.file), folder: g.folder,
        want: { cov: wantCov, gcv: wantGcv, gss: nTela, fmv: nPrevia, pcm: wantPcm },
        cheatsText: nCheats && g.dbCheats?.length ? this.cheats.serialize(g.dbCheats, shortTitle(g)) : null,
        // The game info file replaces what is on the card, so its `fmv:` flag has to cover everything that flag
        // gates, the clip and the static snapshot (see fmvFlagFor: the firmware probes `<rom>.fmv` and
        // `<rom>.gss` inside one `if(fmv_eligible)`). Baked ahead because the worker writes the `.yml`
        // and the media in a single pass: what this run is about to write (nPrevia/nTela) plus whatever
        // the card already holds. Missing `nTela`/`snapshot` here meant an "Atualizar → Informações" over
        // a card full of snapshots-without-clips turned every one of those snapshots off.
        // `man_slots` rides along for the same structural reason as the fmv flag: the worker replaces the
        // game info, so anything not baked in here is erased. Losing it would drop the game back to sha-only
        // manual dedup and hand the next GameDB re-encode the duplicate-slots bug all over again. The
        // value is the map as the entry knows it (manSlotsFor, one source of truth). The manual pass
        // that runs after the worker rewrites it with whatever it actually installed.
        // The `sync_*` receipts ride along for the same structural reason, and the PRE-RUN values are
        // the correct ones: they describe what the card holds right now, and persistSyncTokens advances
        // only the groups that actually landed. Without them a cancelled run leaves every game the
        // worker touched with no proof of origin for its manuals, unrepairable on the next re-encode.
        infoYml: (nInfo || nPrevia)
          ? buildYml({ ...this.gameInfoFields(g), ...this.syncTokensOnCard(g), rom: g.file, crc: g.crc || null, gamedb_id: g.gamedbId ?? null,
                       fmv: (nPrevia || nTela || fmvFlagFor(g) != null) ? 1 : null,
                       [MAN_SLOTS_KEY]: manSlotsField(g, g.onCardYml?.[MAN_SLOTS_KEY]) })
          : null,
      });
    }

    let done = 0;
    // Package path → the dedicated write worker. Each progress message updates the counters + entry state.
    const handledIds = new Set<string>();
    // The game info file text handed to the worker, per game, memoized once the worker confirms the write, so a
    // later fmv-flag patch knows what is on the card without reading it (see ensureFmvFlag/ymlMemo).
    const ymlByJob = new Map(jobs.filter((j) => j.infoYml != null).map((j) => [j.id, j.infoYml as string]));
    if (jobs.length && !this.cancelImport) {
      workerDead = await this.runWriterWorker(jobs, (m) => {
        handledIds.add(m.id);
        this.workerBytes = m.bytes; // cumulative worker write bytes → feeds the live MB/s readout
        runWorkerBytes = m.bytes;
        if (m.wrote.info) { const t = ymlByJob.get(m.id); if (t) this.rememberYml(m.id, t); }
        const w = m.wrote;
        if (w.cov || w.gcv) capas++; if (w.gss) telas++; if (w.cheats) cheats++; if (w.fmv) previas++; // gcv-only = capa completed
        if (w.info && plan.info !== 'off') infos++; // don't count the .yml rewritten just for the fmv flag
        if (w.manual) { manuals++; manCounted.add(m.id); }
        // record which sync-token groups this write refreshed (capa/tela/prévia/cheats all ride the package)
        if (w.cov || w.gcv || w.gss || w.fmv || w.cheats) markWrote(m.id, 'pkg');
        if (w.pcm) markWrote(m.id, 'pcm'); if (w.info) markWrote(m.id, 'meta');
        /* `sync_man` is a receipt for the whole served set (every manual's sha, joined), and the worker
           writes only the primary. Stamping it here for a game whose extras are still queued is how a
           card ended up declaring four documents in sync while holding one, and, worse, unrepairable:
           the token then matched the server's forever, so Atualizar read the category as up to date and
           never offered the missing three again. A game with extras is stamped by the pass that
           installs them (which also unstamps on failure); a run that dies before it never claims what
           it did not write. */
        if (w.manual && !manualPass.has(m.id)) markWrote(m.id, 'man');
        const patch: Partial<Entry> = {};
        if (w.cov) patch.cover = 'has'; if (w.gcv) patch.gcv = 'has'; if (w.gss) patch.snapshot = 'has'; if (w.fmv) patch.fmv = 'has';
        if (w.info) patch.info = 'has'; if (w.cheats) patch.cheats = 'has';
        // Render the new cover in the list immediately (the worker can't make a dataURL): decode the cov
        // bytes it sent. Without this the thumbnail only appears when the card re-enters view / on select.
        if (w.cov && m.cov) {
          try { patch.thumbUrl = covToDataUrl(m.cov); } catch {  }/* bad cov → leave placeholder */
          void this.mirrorCovToSiblings(m.id, m.cov);
        }
        // Slot 0 (<stem>.man, the official manual) just landed, bump `guides` too (the detail panel's
        // count includes it) unless it was already present (a 'replace' overwrite doesn't add a slot).
        // Derived inside the patch (against the entry as the flush finds it) rather than from a read
        // here: the patch is queued, so a snapshot taken now could miss an earlier pending patch.
        if (w.manual) {
          patch.manual = 'has';
          this.queueUpdate(m.id, (g) => (g.manual !== 'has' ? { ...patch, guides: (g.guides ?? 0) + 1 } : patch));
        } else if (Object.keys(patch).length) {
          // Queued, not update(): this callback runs once per game (thousands of times per run) and each
          // update() was a full library rebuild + re-tally. The flush after the worker finishes (and the
          // 100 ms timer meanwhile) makes the list fill in without stalling the write pipeline.
          this.queueUpdate(m.id, patch);
        }
        // A read-only ROM folder (or similar) skipped an artifact → record it for the post-run report.
        // Reads only title/file/folder, which no fill patch ever touches → the queue can't stale it.
        if (m.err) this.pushFillError(this.entriesById().get(m.id), m.err.asset, m.err.reason);
        // Anything the worker was asked for and could not write goes to the main thread, which can build
        // it from the raw sources (covgen from coverUrl, .gcv derived from the on-card .cov, screenshot
        // from screenshotUrl). This used to be gated on `!m.hadPackage`, "the package fetch failed
        // entirely", which silently stranded the far more common case: the package downloaded fine but
        // simply doesn't carry that member. Those games wrote nothing, reported nothing, and came back
        // as "a completar" run after run. A manual-only game still must not be re-queued (nothing to
        // covgen), hence the check is on the artifacts themselves, not on whether a package existed.
        const stranded = m.missing.cov || m.missing.gcv || m.missing.gss;
        // A possibly-stale snapshot is fine here: the main-thread pass re-reads each game with cur()
        // (after the flush below), so it only uses this object's identity/id.
        if (stranded) { const g = this.entriesById().get(m.id); if (g) mainOnly.push(g); }
        // No `.fmv` written → the preview is skipped (auto-fill never falls back to downloading the mp4
        // and re-encoding it with ffmpeg. That is what the per-game action on the game info file is for). Which
        // skip it was matters to the user: `hadPackage` false means the bundle never arrived (network /
        // 404 / cancelled) and retrying is the fix; only with the bundle in hand does "the GameDB hasn't
        // built this clip yet" hold. A stranded game reports from its own pass below.
        if (m.missing.fmv && !stranded) {
          previaSkipped.add(m.id);
          this.pushFillError(this.entriesById().get(m.id), 'fmv', m.hadPackage ? 'noready' : 'download');
        }
        // The worker couldn't land the `.man` → retry on the main thread. When the game is already going
        // back there for a stranded artifact, its own manual step covers it. Never let it pass unnoticed:
        // the sync_man token is only stamped on a real write, so a silent failure re-offers it every run.
        if (m.missing.man && !stranded) { needManual(m.id, true, m.manErr || ''); if (m.manErr) console.warn('[autofill] manual write failed:', m.manErr); }
        this.bulkProgress(++done);
      });
      // Everything the worker's message stream queued must be visible before the passes below read the
      // library again (cur() in the main-thread pool, the manual pass, persistSyncTokens).
      this.flushEntryUpdates();
      this.bulkProgress(done, true); // the bar always ends this phase on the real count, never mid-throttle
      // Robustness: any job the worker never reported (spawn failed / it died mid-run) falls back to the
      // main thread so those games aren't silently skipped. Unless the run was cancelled or the card died.
      if (!this.cancelImport && !workerDead) {
        for (const j of jobs) {
          if (handledIds.has(j.id)) continue;
          const g = this.entriesById().get(j.id);
          if (g) mainOnly.push(g);
        }
      }
    }

    /* From here on, the only thing that writes `.man` files is installManuals itself (the worker has
       finished and its writes are flushed), so the per-directory `.man` listing the manual passes below
       share is safe to cache: hundreds of games sit in one bucket, and each would otherwise re-walk it.
       Disarmed again in the finally. Outside this window the cache has no owner to keep it true. */
    this.manDirNames = new Map();

    /* One manual install per `.man` bucket. `<stem>.NN.man` is addressed by stem (infoDirFor), never by
       the ROM's folder, so every copy of a game, the same filename under `_CONTROL`, under a patch
       folder, under its letter folder, shares the same eight slots and the same `<rom>.yml`. Left one
       per entry, N copies each plan against those eight slots on their own: what a sibling installed
       seconds ago is not among the documents this entry is serving, so it reads as an unprovable
       leftover, the extras spill into fresh slots, and a stem with enough copies exhausts the card and
       reports `slotsfull`, precisely what a card full of control/patch duplicates produced.
       This is not a compromise: the firmware resolves the manual by stem too, so those copies can only
       ever show the same documents. One owner per bucket is the only thing the layout can represent.
       Owner = the entry offering the most documents (the fullest set for files they all share), ties
       broken by id so a re-run keeps picking the same one. */
    const nDocs = (e: Entry): number => e.manuals?.length ?? (e.manualUrl ? 1 : 0);
    const manBuckets = groupManualBuckets(
      [...mainOnly, ...[...manualPass.keys()].map((id) => this.entriesById().get(id))]
        .filter((e): e is Entry => !!e && wantManual.has(e.id) && nDocs(e) > 0),
      (e) => infoDirFor(this.key(e.file)),
      nDocs,
    );
    const manOwner = new Set(manBuckets.map((b) => b.owner.id));
    const manSiblings = new Map(manBuckets.map((b) => [b.bucket, b.members]));
    /* The owner installed the shared files; a sibling asking for the same set of documents is satisfied
       by them, so its token advances too. Otherwise it would read stale on every future run and offer
       work that is already done. A sibling wanting a different set gets no token: the card physically
       cannot hold both, and claiming otherwise would be a lie in the game info file. */
    const shareManMark = (ownerId: string): void => {
      const g = this.entriesById().get(ownerId); if (!g) return;
      const digest = syncTokensFromMatch(g).sync_man;
      for (const s of manSiblings.get(infoDirFor(this.key(g.file))) ?? []) {
        if (s.id !== ownerId && syncTokensFromMatch(s).sync_man === digest) markWrote(s.id, 'man');
      }
    };

    // Main-thread generation (covgen/ffmpeg) for everything the worker couldn't write, games with no
    // package at all and games whose package simply lacks the member. Few, for matched ROMs.
    if (mainOnly.length && !this.cancelImport && !this.card.unwritable && !workerDead) {
      await pool(mainOnly, AUTOFILL_CONCURRENCY, async (entry) => {
        if (this.cancelImport || this.card.unwritable) return;
        let g = cur(entry);
        const nCapa = this.fillNeeds(g, 'capa', plan), nTela = this.fillNeeds(g, 'tela', plan),
          nInfo = this.fillNeeds(g, 'info', plan), nCheats = this.fillNeeds(g, 'cheats', plan),
          nPrevia = this.fillNeeds(g, 'previa', plan), nManual = wantManual.has(g.id);
        if (nCapa) {
          // A card `.cov` with only the game info `.gcv` missing is derived locally (buildGcvFromCov), no
          // download, and it works even when the GameDB has no cover image. Only when the `.cov` itself
          // is absent do we fetch the image and build both halves.
          const onlyGcv = (g.cover === 'has' || g.cover === 'custom') && g.gcv !== 'has';
          const ok = onlyGcv
            ? await this.genGcvFromCov(g, true)
            : g.coverUrl
              ? await this.encodeAndPlaceCover(g, g.coverUrl, 'has', this.i18n.translate('store.cover'), true) !== 'cov-failed'
              : await this.genGcvFromCov(g, true);
          // 'cov-readonly' counts as done: the game info .gcv did land, only the .cov next to the ROM was
          // refused, and encodeAndPlaceCover already recorded that in the report.
          if (ok) { capas++; markWrote(g.id, 'pkg'); }
          // A cover we were asked for and could not build: count it and name it in the report, so the
          // row never sits at "N to complete" run after run with no way to tell which games or why.
          else { covFail++; this.pushFillError(cur(g), 'cov', g.coverUrl ? 'download' : 'nosource'); }
        }
        if (nTela) {
          if (await this.genStaticShot(cur(g), true)) { telas++; markWrote(g.id, 'pkg'); }
          else this.pushFillError(cur(g), 'gss', g.screenshotUrl ? 'download' : 'nosource');
        }
        g = cur(g);
        if (nInfo && (await this.saveInfoYml(g, this.gameInfoFields(g), true))) { infos++; markWrote(g.id, 'meta'); }
        if (nCheats && (await this.dlCheats(cur(g), true))) { cheats++; markWrote(g.id, 'pkg'); }
        // Preview: the package's ready `.fmv`, or nothing. No mp4 download, no ffmpeg, a game the GameDB
        // hasn't built the clip for is skipped and named in the post-run report. Naming the right reason
        // costs nothing: getPackage is the memoized fetch placePackageFmv just used, so this re-reads the
        // cache. No bundle → a download to retry; bundle with the member → the write itself failed;
        // bundle without it → the GameDB genuinely has no clip yet.
        if (nPrevia) {
          if (await this.placePackageFmv(cur(g), true, previaAudio)) { previas++; markWrote(g.id, 'pkg'); if (previaAudio) markWrote(g.id, 'pcm'); }
          else {
            previaSkipped.add(g.id);
            const pkg = await this.getPackage(cur(g));
            this.pushFillError(cur(g), 'fmv', !pkg ? 'download' : pkg['fmv'] ? 'writefail' : 'noready');
          }
        }
        // Manual: reached here either because there's genuinely no package (rare, most matched games
        // get one via the reconciler) or the package fetch failed and this game fell back wholesale.
        // installManuals is idempotent (byte-identical manuals are skipped; the primary is rewritten in
        // place under update/replace) and tells us why nothing landed, so a failure gets reported.
        // Non-owners of the bucket install nothing and report nothing: the owner writes the very files
        // they would have written (see manOwner above), and racing it is what filled the card.
        if (nManual && manOwner.has(g.id)) {
          const r = await this.installManuals(cur(g), { quiet: true, force: plan.manual !== 'complete', deferMap: true });
          /* Nothing written is not nothing done. A game whose documents are already all on the card in
             the right slots writes no bytes and fails nothing. The card holds the full set, which is
             exactly what `sync_man` records. Stamping only when bytes moved left every such game
             recorded as out of date, so "Atualizar" offered the same games run after run, forever.
             and a stem shared by several copies hits this constantly: the first copy installs the
             files, every other one finds them already correct. `manuals` still counts real work. */
          if (!r.failed) { if (r.wrote && !manCounted.has(g.id)) manuals++; markWrote(g.id, 'man'); shareManMark(g.id); }
          guideDups += r.dropped;
          if (r.failed) { this.pushFillError(cur(g), 'man', r.reason); unmarkWrote(g.id, 'man'); }
        }
        this.bulkProgress(++done);
      });
      this.bulkProgress(done, true);
    }

    // Manuals, the worker wrote only the primary (slot 0). This pass installs the additional manuals of
    // worker-handled games (sha-deduped, free slots 2..8) and retries any primary the worker couldn't
    // fetch/write. mainOnly games already got the full set via their own installManuals above.
    if (manualPass.size && !this.cancelImport && !this.card.unwritable && !workerDead) {
      const pending = [...manualPass].map(([id, info]) => ({ g: this.entriesById().get(id), info }))
        .filter((p): p is { g: Entry; info: { retry: boolean; err: string } } => !!p.g);
      await pool(pending, AUTOFILL_CONCURRENCY, async ({ g, info }) => {
        if (this.cancelImport || this.card.unwritable || !manOwner.has(g.id)) return;
        const r = await this.installManuals(cur(g), { quiet: true, force: plan.manual !== 'complete', deferMap: true });
        // `manuals` counts games, not files, a game the worker already counted (its slot 0 landed) is
        // not counted twice for its extras. That used to be spelled `info.retry`, which silently
        // stopped being the same thing once slot 0 can be skipped for a game that only lacks extras:
        // nobody counted those, and a run that installed four documents reported "0 manuais".
        // Same rule as above: no failure means the card holds the whole set, so the token is stamped
        // even when nothing had to be written.
        if (!r.failed) { if (r.wrote && !manCounted.has(g.id)) manuals++; markWrote(g.id, 'man'); shareManMark(g.id); }
        guideDups += r.dropped;
        /* Report only a genuine failure. This used to also fire when a `retry` game wrote no bytes, but
           a retry that finds slot 0 already byte-identical means the primary is there and correct, so
           that branch reported a completed game as a failed download and then unstamped its token. */
        if (r.failed) {
          this.pushFillError(cur(g), 'man', r.reason);
          unmarkWrote(g.id, 'man'); // set incomplete → don't let sync_man claim it's up to date
        }
      });
    }

    // Flag `fmv: 1` órfã dos jogos cuja prévia foi pulada
    // A game info file entregue ao worker já sai com `fmv: 1` quando a prévia entra no plano (ele grava `.yml` e
    // `.fmv` de uma vez só, não dá para perguntar depois). Quando o pacote não trouxe o clipe, essa flag
    // ficaria apontando para arquivos que ninguém gravou, o firmware sondaria `<rom>.fmv`/`.gss` a cada
    // visita e não acharia nada. Tira a flag só de quem ficou sem nenhum dos dois (um `.gss` na mão, ou
    // recém-gravado, mantém a flag: é ele que a flag também destrava).
    if (previaSkipped.size && !this.cancelImport && !this.card.unwritable && !workerDead) {
      await pool([...previaSkipped], 8, async (id) => {
        const g = this.entriesById().get(id);
        if (!g || fmvFlagFor(g) != null) return; // a `.gss` (kept or just written) still needs the flag
        await this.clearFmvFlag(g);
      });
    }

    // Persistência dos tokens de versão no `<rom>.yml`
    // Só nos jogos que tiveram alguma escrita neste run: avança os `sync_*` das categorias reescritas
    // (que agora batem com o servidor) para uma futura "Atualizar" saber o que já está atual. NÃO carimba
    // baseline em jogos intocados, um `.yml` legado sem token permanece "desatualizado" até ser de fato
    // rebaixado, senão esconderíamos atualizações reais. Pulado se o cartão ficou ingravável.
    if (!this.card.unwritable && !workerDead) {
      const toPersist = targets.filter((g) => cur(g).matched && tokenWrites.has(g.id));
      await pool(toPersist, 8, async (g) => {
        if (this.cancelImport) return;
        await this.persistSyncTokens(cur(g), tokenWrites.get(g.id) ?? {});
      });
    }

    } finally {
      this.flushEntryUpdates(); // nothing this run wrote may still be sitting in the queue
      this.manDirNames = null;  // the `.man` listing cache only holds while this run owns the writes
      this.stemNames = null;    // ...and so does the stem index the guide sweep checks against
      /* Whether the run was cancelled has to be read before the sweep, which gets a cancel flag of
         its own below -- the summary toast further down still has to say "Parado", not "Preenchido". */
      cancelled = this.cancelImport;
      /* Clean up after ourselves, with the bar still up.
         Not cosmetics: `bulkBusy()` is what stops a second run from starting, and a second run's
         brand-new `.crswap` files would be deleted out from under it by this sweep. The bar also
         gives the sweep the one thing it needs -- a Cancel button; `cancelImport` is reset first so
         that button governs the sweep rather than arriving already pressed from a cancelled run.
         Runs before sumUsage so the usage total already reflects what it freed.

         Skipped when the run completed nothing at all: there is little to collect, and paying an
         entries() per planned directory for it is not worth it. Not *nothing*, a cancel landing
         mid-write can strand one `.crswap`, but that is precisely the leftover the Organizer's
         whole-card sweep exists to pick up. */
      if (capas || telas || infos || cheats || previas || manuals || covFail) {
        this.cancelImport = false;
        this.bulkBegin(touched.size, this.i18n.translate('store.sweepingJunk'), true);
        // try/catch because this is a finally: an exception thrown here would replace whatever the
        // run was already failing with, and lose it. Cleaning up is never worth that.
        try { junkSwept = await this.sweepJunkIn(touched, (n) => this.bulkProgress(n)); }
        catch (err) { console.warn('[autofill] junk sweep failed', err); }
      }
      // Always clear the bar + refresh (even if a step above threw) so a run can never leave the
      // progress bar stuck/frozen with no message (the "trava na metade sem motivo aparente" symptom).
      this._bulk.set(null);
      if (ids) this.clearSel();
      this._infoRev.update((v) => v + 1);
      // Calibrate the dialog's time estimate from this run's real throughput (bytes written / wall s).
      const secs = (Date.now() - calT0) / 1000;
      const wrote = this.card.writtenBytes - calBytes0;
      if (secs > 5 && wrote > 1048576) this.saveThroughput(wrote / secs);
      /* The media just written changed the card's used space, fold in what the run actually wrote
         (main thread + worker) instead of re-walking the card. The walk `getFile()`s every file on it,
         which on a full card is ~20 s of disk work for a number the run itself already knows, right
         when the user is being handed the summary. What the delta can't see: an overwrite (counted as
         if new) and the junk sweep's deletions (nothing read their sizes), both bounded by the idle
         reconciliation, which runs one real walk once the browser is free. */
      this.addUsage(Math.max(0, wrote) + runWorkerBytes);
      this.scheduleUsageReconcile();
    }

    const parts: string[] = [];
    if (capas) parts.push(this.i18n.translate(capas > 1 ? 'store.partCoversMany' : 'store.partCoversOne', { count: capas }));
    if (telas) parts.push(this.i18n.translate(telas > 1 ? 'store.partSnapshotsMany' : 'store.partSnapshotsOne', { count: telas }));
    if (previas) parts.push(this.i18n.translate(previas > 1 ? 'store.partPreviewsMany' : 'store.partPreviewsOne', { count: previas }));
    if (infos) parts.push(this.i18n.translate(infos > 1 ? 'store.partInfosMany' : 'store.partInfosOne', { count: infos }));
    if (cheats) parts.push(this.i18n.translate('store.partCheats', { count: cheats }));
    if (manuals) parts.push(this.i18n.translate(manuals > 1 ? 'store.partManualsMany' : 'store.partManualsOne', { count: manuals }));
    const summary = parts.length ? parts.join(' · ') : this.i18n.translate('store.nothingToDo');
    const tail = covFail ? ' · ' + this.i18n.translate(covFail > 1 ? 'store.partFailuresMany' : 'store.partFailuresOne', { count: covFail }) : '';
    /* Named in the summary rather than done in silence: the sweep deletes files off the user's card,
       and anything that deletes has to say so. */
    const junkTail = junkSwept
      ? ' · ' + this.i18n.translate(junkSwept > 1 ? 'store.partJunkMany' : 'store.partJunkOne', { count: junkSwept })
      : '';
    /* Same rule for the obsolete guide slots the manual pass swept (planManualSlots' drops). */
    const dupTail = guideDups
      ? ' · ' + this.i18n.translate(guideDups > 1 ? 'store.partGuidesSweptMany' : 'store.partGuidesSweptOne', { count: guideDups })
      : '';
    const cardDead = this.card.unwritable || workerDead;
    const prefix = this.i18n.translate(cancelled || cardDead ? 'store.fillStopped' : 'store.fillFilled');
    this.toast.show(`${prefix}${summary}${tail}${dupTail}${junkTail}`, cancelled || covFail || cardDead ? 'warn' : 'ok');
    // The card stopped accepting writes (full / write-protected / remounted read-only), say so clearly
    // instead of leaving the user staring at a half-finished run that "froze near the end". Append the
    // Real underlying error (from the worker or the CardWriter) so a production failure is diagnosable.
    if (cardDead) {
      const reason = this.fillFailReason || this.card.lastError || '';
      console.error('[autofill] card reported UNWRITABLE. real underlying error:', reason || '(none captured)');
      this.toast.show(this.i18n.translate('store.cardUnwritable') + (reason ? `  ·  ${reason}` : ''), 'warn');
    }
    // Some artifacts were skipped (not fatal), e.g. read-only ROM folders rejecting the .cov. Surface
    // an on-screen report (with CSV export) so the user can fix the folder permissions and re-run.
    if (this.runErrors.length) this._fillReport.set([...this.runErrors]);
  }

  /**
   * Delete the system litter a run left behind, in the directories it wrote to. Returns how many
   * files went away.
   *
   * Why this exists
   * Two hosts leave a file behind for every file we write, and neither is ours to prevent:
   *   `<name>.crswap`  Chromium creates one beside the target on every createWritable() and renames
   *                    it into place on close(). A crash, a closed tab or a cancelled run strands it.
   *   `._<name>`       macOS mints an AppleDouble sidecar for each new file on exFAT, one per
   *                    `.cov`, i.e. one per ROM, right in the folders the console's game browser
   *                    reads. On a 3000-ROM card that is 3000 dead entries FAT walks on every lookup.
   * The Organizer sweeps the whole card, but only when the user opens it; a fill run cleans up its
   * own mess immediately, and it knows exactly where to look, so it costs one entries() per touched
   * directory instead of a full card walk.
   *
   * Failure is never fatal
   * These are removals in the user's own ROM folders, which may be read-only (the chmod 555 hack
   * set that already cost one production incident). A `._` we cannot delete is cosmetic, so every
   * removal is isolated: it never grows CardWriter's fatalStreak, never latches `unwritable`, and
   * never aborts anything. It warns to the console and moves on.
   *
   * `onDir` advances the caller's progress bar; the sweep is cancellable between directories, which
   * is a clean boundary. A folder is either swept or untouched, and the Organizer finishes the job.
   */
  private async sweepJunkIn(dirs: ReadonlySet<string>, onDir?: (done: number) => void): Promise<number> {
    const root = this.rootHandle;
    // A card that already latched cannot delete anything either -- every call would fail fast.
    if (!root || !dirs.size || this.card.unwritable) return 0;
    let removed = 0;
    let seen = 0;
    for (const path of dirs) {
      if (this.cancelImport) break;
      onDir?.(++seen);
      const dir = path ? await getDirByPath(root, path) : root;
      if (!dir) continue;                                   // the run never created it -> nothing there
      // Collected first: removing entries while iterating entries() disturbs the iteration.
      const names: string[] = [];
      try {
        for await (const [name, h] of dir.entries()) {
          // isSweepableJunk, not isJunkFile: ROMs may live in the card root, and a desktop.ini there
          // is the volume's own icon/label, not litter. Same rule the Organizer's sweep uses.
          if (h.kind === 'file' && isSweepableJunk(name, path === '')) names.push(name);
        }
      } catch (err) {
        console.warn('[autofill] junk sweep: could not list', path, err);
        continue;
      }
      // Same per-folder give-up the Organizer's removeJunk uses: refused deletes cost ~150ms each
      // (2 attempts + backoff), so a read-only folder full of `._*` must not pin the bar for minutes,
      // and Cancel is honoured per file, not just per folder.
      let refused = 0;
      for (const name of names) {
        if (this.cancelImport || refused >= JUNK_GIVE_UP_STREAK) break;
        try { await this.card.remove(dir, name, { isolated: true }); removed++; refused = 0; }
        catch (err) {
          if ((err as { name?: string })?.name !== 'NotFoundError') refused++;
          console.warn('[autofill] junk sweep: could not remove', `${path}/${name}`, err);
        }
      }
    }
    return removed;
  }

  /** True (and warns) when a card operation already owns the progress bar, guards every `_bulk`
   *  entry point so two can't run at once (they'd stomp each other's progress + share cancelImport). */
  private bulkBusy(): boolean {
    if (this.isBulkRunning()) {
      this.toast.show(this.i18n.translate('store.operationInProgress'), 'warn');
      return true;
    }
    return false;
  }

  /** Is a bulk phase up? Pure, `bulkBusy()` is the guard for user entry points and toasts on the way
   *  out, which is exactly wrong for a background poll (one toast per poll). Anything that merely wants
   *  to know whether the card is busy asks this. */
  private isBulkRunning(): boolean {
    return this._bulk() != null;
  }

  /** Per-item progress for the phases that tick thousands of times (the write worker's stream, the
   *  main-thread fill pool). Publishing every item is one `_bulk` set, and one re-render of the bar
   *  plus one bulkRate recompute, per game, for a bar that moves a fraction of a pixel. ~5 Hz is as
   *  much as anyone can read; `force` publishes the exact final count at the end of a phase so the bar
   *  never freezes a few items short of the total. */
  private bulkPublishedAt = 0;
  private bulkProgress(done: number, force = false): void {
    const now = Date.now();
    if (!force && now - this.bulkPublishedAt < 200) return;
    this.bulkPublishedAt = now;
    this._bulk.update((b) => (b ? { ...b, done } : b));
  }

  /** Start a bulk phase with a timestamp (drives the live rate/ETA) and kick the heartbeat ticker. */
  private bulkBegin(total: number, label: string, cancelable = false): void {
    this.bulkBytesBase = this.card.writtenBytes; // baseline for measuring this phase's main-thread writes
    this.workerBytes = 0;
    this.bulkPublishedAt = 0; // new phase → let its first item publish immediately
    this._bulk.set({ done: 0, total, label, cancelable, startedAt: Date.now() });
    if (this.tickHandle == null) {
      this.tickHandle = setInterval(() => {
        if (!this._bulk()) { clearInterval(this.tickHandle!); this.tickHandle = null; return; }
        this._bulkTick.update((v) => v + 1);
      }, 500);
    }
  }

  /** Background: recompute the card's used space (full-tree size sum). */
  private async sumUsage(): Promise<void> {
    if (!this.rootHandle) return;
    try { this._cardUsedBytes.set(await walkUsage(this.rootHandle)); }
    catch {  }/* leave the last value */
  }

  /** Ensure the sibling .yml carries `fmv: 1` (the firmware gates the .fmv/.gss probe on it).
   *
   *  Costs a read + a write on a file this very flow has usually just written, the game info file of the game
   *  whose preview is being placed, so the current text comes from `ymlMemo` (what we last put on the
   *  card for this game) when it's there, and only from the card otherwise. That drops the read after
   *  saveInfoYml in auto-fill's main-thread path, and makes a second call within one game (snapshot
   *  then preview, which the memo now shows as already flagged) a complete no-op.
   *
   *  `Entry.onCardYml` is deliberately not consulted, tempting as it looks: it is a PRE-RUN snapshot
   *  that persistSyncTokens depends on staying stale (see its note), so it can describe a game info file several
   *  rewrites old, and trusting a stale "it already has the flag" would leave the clip on the card with
   *  the console never probing for it, silently. */
  private async ensureFmvFlag(g: Entry, dir: FileSystemDirectoryHandle, stem: string): Promise<void> {
    const memo = this.ymlMemo.get(g.id);
    const existing = memo ?? (await readTextFile(dir, stem + '.yml'));
    const next = ymlWithFmvFlag(existing);
    // Already flagged (never null here, a missing file always yields a patch): memo the text we just
    // read so a second call for this game costs nothing at all.
    if (next == null) { if (existing != null) this.rememberYml(g.id, existing); return; }
    await this.card.write(dir, stem + '.yml', next);
    this.rememberYml(g.id, next);
  }

  /** Take `fmv: 1` back out of a game's game info. For the one case that can produce an orphan flag: the
   *  write worker gets the game info file with the flag already baked in (it writes `.yml` and `.fmv` in a single
   *  pass), and the package then turns out not to carry the clip. Same memo-first read as ensureFmvFlag,
   *  and a complete no-op when there is no game info or no flag. Best-effort: bookkeeping never fails a run. */
  private async clearFmvFlag(g: Entry): Promise<void> {
    if (!this.rootHandle || this.card.unwritable) return;
    const stem = stemOf(g.file);
    try {
      const dir = await this.getDir(infoDirFor(this.key(g.file)));
      if (!dir) return;
      const existing = this.ymlMemo.get(g.id) ?? (await readTextFile(dir, stem + '.yml'));
      const next = ymlWithoutFmvFlag(existing);
      if (next == null) return;
      await this.card.write(dir, stem + '.yml', next);
      this.rememberYml(g.id, next);
    } catch (err) {
      console.warn('[fmv] could not clear the orphan fmv flag for', g.file, err);
    }
  }

  async delFmv(g: Entry): Promise<void> {
    const stem = stemOf(g.file);
    try {
      const dir = await this.getDir(infoDirFor(this.key(g.file)));
      if (dir) {
        await this.card.remove(dir, stem + '.fmv').catch(() => {});
        await this.card.remove(dir, stem + '.pcm').catch(() => {});
      }
    } catch {  }/* already gone */
    this.update(g.id, { fmv: 'none' });
    this.toast.show(this.i18n.translate('store.previewRemoved'), 'warn');
  }
  async toggleCheat(g: Entry, i: number): Promise<void> {
    const cur = g.cheatList?.[i];
    if (!cur) return;
    const enabled = !cur.on;
    // patch the raw YAML in place (preserves names/codes/comments) for persistence
    const newRaw = g.cheatsRaw != null ? this.cheats.setEnabled(g.cheatsRaw, i, enabled) : undefined;
    this.update(g.id, (gg) => ({
      cheatList: (gg.cheatList ?? []).map((c, j) => (j === i ? { ...c, on: enabled } : c)),
      cheatsRaw: newRaw ?? gg.cheatsRaw,
    }));
    // persist to /sd2snes/cheats/<stem>.yml when on a real card
    if (newRaw != null && g.dirHandle && this.rootHandle && g.cheats === 'has') {
      try {
        const dir = await this.ensureDir(cheatsDirFor(this.key(g.file)));
        await this.card.write(dir, stemOf(g.file) + '.yml', newRaw);
      } catch (err) {
        this.toast.show(this.i18n.translate('store.cheatSaveFailed', { error: msg(err) }), 'warn');
      }
    }
  }
  /** Rename to the No-Intro title (kept name; now a real rename). */
  async rename(g: Entry): Promise<void> {
    const ext = g.file.split('.').pop() ?? 'sfc';
    await this.renameRom(g.id, g.title + '.' + ext);
  }

  /** Rename the ROM and every sidecar that shares its stem, cover (.cov), cheats (.yml in
   *  /sd2snes/cheats), save (.srm in /sd2snes/saves), and the animated screenshot (.fmv/.pcm +
   *  fmv-flag .yml in /sd2snes/info/<bucket>; the bucket can change if the first letter changes).
   *  If any target name already exists, asks once (list + Overwrite/Cancel) before clobbering. */
  async renameRom(id: string, newName: string): Promise<void> {
    const e = this._entries().find((x) => x.id === id);
    if (!e || !newName || newName === e.file) return;
    if (!e.dirHandle || !e.fileHandle) {
      this.update(id, { file: newName }); // demo
      this.toast.show(this.i18n.translate('store.renamedToNoIntro'), 'info');
      return;
    }

    const moves = await this.planRename(e, newName);
    const conflicts: string[] = [];
    for (const m of moves) {
      if (m.srcDir === m.destDir && m.srcName === m.destName) continue;
      if (await fileExists(m.destDir, m.destName)) conflicts.push(m.destName);
    }
    if (conflicts.length) {
      const r = await this.dialog.confirm({
        title: this.i18n.translate('store.replaceExistingTitle'),
        body: this.i18n.translate('store.replaceExistingBody', { list: '\n• ' + conflicts.join('\n• ') }),
        confirmLabel: this.i18n.translate('store.replace'),
        danger: true,
      });
      if (!r.ok) return;
    }

    try {
      let count = 0;
      for (const m of moves) {
        if (m.srcDir === m.destDir && m.srcName === m.destName) continue;
        try {
          if (await fileExists(m.destDir, m.destName)) await this.card.remove(m.destDir, m.destName);
        } catch {  }/* ignore */
        const newFh = await this.card.moveFile(m.srcDir, m.fh, m.destDir, m.destName);
        if (m.srcName === e.file) this.update(id, { file: newName, fileHandle: newFh });
        count++;
      }
      const extra = count - 1;
      const suffix = extra > 0 ? this.i18n.translate(extra > 1 ? 'store.renamedExtraMany' : 'store.renamedExtraOne', { count: extra }) : '';
      this.toast.show(this.i18n.translate('store.renamedTo', { name: newName, extra: suffix }), 'info');
    } catch (err) {
      console.error('[rename] failed for', e.file, err);
      this.toast.show(this.i18n.translate('store.renameFailed', { error: msg(err) }), 'warn');
    }
  }

  /** Every existing on-card file for entry `e` that must move when it's renamed to `newName`. */
  private async planRename(
    e: Entry,
    newName: string,
  ): Promise<{ srcDir: FileSystemDirectoryHandle; fh: FileSystemFileHandle; srcName: string; destDir: FileSystemDirectoryHandle; destName: string }[]> {
    // Both keys come from a filename, so the namespace is derived rather than assumed. A rename
    // preserves the extension (see rename()), so old and new always agree -- deriving it keeps
    // that a property of the code instead of an invariant someone has to remember.
    const oldKey = this.key(e.file);
    const newKey = this.key(newName);
    const oldStem = oldKey.stem;
    const newStem = newKey.stem;
    const moves: { srcDir: FileSystemDirectoryHandle; fh: FileSystemFileHandle; srcName: string; destDir: FileSystemDirectoryHandle; destName: string }[] = [];
    const add = async (srcDir: FileSystemDirectoryHandle | null, srcName: string, destDir: FileSystemDirectoryHandle | null, destName: string): Promise<void> => {
      if (!srcDir || !destDir) return;
      const fh = await srcDir.getFileHandle(srcName).catch(() => null);
      if (fh) moves.push({ srcDir, fh, srcName, destDir, destName });
    };
    const romDir = e.dirHandle!;
    moves.push({ srcDir: romDir, fh: e.fileHandle!, srcName: e.file, destDir: romDir, destName: newName });
    await add(romDir, oldStem + '.cov', romDir, newStem + '.cov');
    // Renaming can move a file between buckets (e.g. "Foo" -> "Zoo"), so source and destination
    // directories are resolved separately from the old and new stems.
    await add(await this.bucketDir(CHEATS_ROOT, oldKey), oldStem + '.yml',
              await this.bucketDir(CHEATS_ROOT, newKey, true), newStem + '.yml');
    // /sd2snes/saves: SRAM (.srm), Super Game Boy rtc (.gtc), BS-X Memory Pack (.mpk)
    { const sOld = await this.bucketDir(SAVES_ROOT, oldKey);
      const sNew = await this.bucketDir(SAVES_ROOT, newKey, true);
      for (const ext of ['.srm', '.gtc', '.mpk']) await add(sOld, oldStem + ext, sNew, newStem + ext); }
    // /sd2snes/states: save states <stem>NN.state (slots; flat dir)
    for (const s of await this.listSaveStates(oldKey)) {
      moves.push({ srcDir: s.dir, fh: s.fh, srcName: s.name, destDir: s.dir, destName: newStem + s.slot + '.state' });
    }
    if (this.rootHandle) {
      const oldInfo = await this.getDir(infoDirFor(oldKey));
      const exts = ['.yml', '.gcv', '.gss', '.fmv', '.pcm']; // info-dir siblings (matches deleteSiblings)
      const hasInfo = oldInfo && (await Promise.all(exts.map((x) => fileExists(oldInfo, oldStem + x)))).some(Boolean);
      if (oldInfo && hasInfo) {
        const newInfo = await this.ensureDir(infoDirFor(newKey));
        for (const ext of exts) await add(oldInfo, oldStem + ext, newInfo, newStem + ext);
      }
    }
    return moves;
  }

  /** On-card save-state files for a stem: /sd2snes/states/<stem>NN.state (slots 01-04, flat dir). */
  private async listSaveStates(key: AssetKey): Promise<{ dir: FileSystemDirectoryHandle; fh: FileSystemFileHandle; name: string; slot: string }[]> {
    const out: { dir: FileSystemDirectoryHandle; fh: FileSystemFileHandle; name: string; slot: string }[] = [];
    if (!this.rootHandle) return out;
    // Savestates are bucketed by the ROM stem (the slot digits are part of the name, so the
    // bucket comes from the stem, never from the file's own first two characters).
    const dir = await this.bucketDir(STATES_ROOT, key);
    if (!dir) return out;
    const re = new RegExp('^' + key.stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)\\.state$', 'i');
    for await (const [name, h] of dir.entries()) {
      const m = name.match(re);
      if (m && h.kind === 'file') out.push({ dir, fh: h as FileSystemFileHandle, name, slot: m[1] });
    }
    return out;
  }

  async delSave(g: Entry): Promise<void> {
    const savesDir = await this.bucketDir(SAVES_ROOT, this.key(g.file));
    if (g.fileHandle && savesDir) {
      const r = await this.dialog.confirm({
        title: this.i18n.translate('store.deleteSaveTitle'),
        body: this.i18n.translate('store.deleteSaveBody', { name: stemOf(g.file) }),
        confirmLabel: this.i18n.translate('store.delete'), danger: true,
      });
      if (!r.ok) return;
      // .srm SRAM + .gtc (SGB rtc) + .mpk (BS-X Memory Pack) -- all the ROM's on-card save data.
      for (const ext of ['.srm', '.gtc', '.mpk']) {
        try { await this.card.remove(savesDir, stemOf(g.file) + ext); } catch {  }/* gone */
      }
    }
    this.update(g.id, { save: false });
    this.toast.show(this.i18n.translate('store.saveRemoved'), 'warn');
  }

  /** Delete all save-state slots (<stem>NN.state) for a ROM. Confirmed -- save states are the user's
   *  in-game progress and cannot be regenerated. */
  async delStates(g: Entry): Promise<void> {
    const key = this.key(g.file);
    const stem = key.stem;
    const slots = await this.listSaveStates(key);
    if (!slots.length) { this.stateKeys.delete(assetIndexKey(key)); this.update(g.id, { state: 'none' }); return; }
    const r = await this.dialog.confirm({
      title: this.i18n.translate('store.deleteStatesTitle'),
      body: this.i18n.translate('store.deleteStatesBody', { name: stem, count: slots.length }),
      confirmLabel: this.i18n.translate('store.delete'), danger: true,
    });
    if (!r.ok) return;
    for (const s of slots) { try { await this.card.remove(s.dir, s.name); } catch {  } }/* gone */
    this.stateKeys.delete(assetIndexKey(key));
    this.update(g.id, { state: 'none' });
    this.toast.show(this.i18n.translate('store.statesRemoved'), 'warn');
  }

  async delRom(g: Entry): Promise<void> {
    if (!g.fileHandle) { // demo entry, just drop it from the list
      this._entries.update((gs) => gs.filter((x) => x.id !== g.id));
      if (this._selId() === g.id) this._selId.set(null);
      this.toast.show(this.i18n.translate('store.removedTitle', { title: shortTitle(g) }), 'warn');
      return;
    }
    const r = await this.dialog.confirm({
      title: this.i18n.translate('store.deleteRomTitle', { title: shortTitle(g) }),
      body: this.i18n.translate('store.deleteRomBody', { file: g.file }),
      confirmLabel: this.i18n.translate('store.delete'), danger: true,
      checkboxes: this.assetDeleteBoxes([g]),   // ROM + per-asset opt-in (all off by default)
    });
    if (!r.ok) return;
    const keys = new Set(r.checkedKeys);
    if (keys.has('rom')) await this.deleteEntries([g.id], keys);   // ROM (+ its forced assets)
    else await this.deleteAssetsOnly([g.id], keys);                // keep the ROM, drop only the assets
  }

  /** Delete only the opted-in assets of the given ROMs (the ROM files stay). Updates each entry's
   *  presence flags so the UI reflects what's gone. Keys per removeAssets(). */
  private async deleteAssetsOnly(ids: Iterable<string>, keys: ReadonlySet<string>): Promise<void> {
    if (!keys.size) return;
    let n = 0;
    for (const id of ids) {
      const g = this._entries().find((e) => e.id === id);
      if (!g) continue;
      await this.removeAssets(this.key(g.file), g.dirHandle, keys);
      const patch: Partial<Entry> = {};
      if (keys.has('cover')) { patch.cover = g.coverUrl ? 'available' : 'none'; patch.gcv = 'none'; patch.thumbUrl = undefined; }
      if (keys.has('preview')) { patch.snapshot = 'none'; patch.fmv = 'none'; }
      // The game info file is gone: a memo of what it used to hold would let ensureFmvFlag rewrite the whole
      // file the user just deleted (it patches the text it believes is on the card).
      if (keys.has('info')) { patch.info = 'none'; this.ymlMemo.delete(g.id); }
      if (keys.has('cheats')) patch.cheats = g.crc ? 'available' : 'none';
      if (keys.has('states')) patch.state = 'none';
      if (keys.has('save')) patch.save = false;
      if (Object.keys(patch).length) this.update(g.id, patch);
      n++;
    }
    if (n) this.toast.show(this.i18n.translate('store.assetsRemoved'), 'warn');
  }

  /** Build the granular "also delete..." checkboxes for a delete dialog, one per asset kind the
   *  selection actually has (all off by default). Deleting a ROM removes only the ROM file unless
   *  the user opts in here. Keys map to removeAssets(). */
  private assetDeleteBoxes(sel: readonly Entry[]): ConfirmCheckbox[] {
    const any = (pred: (e: Entry) => boolean) => sel.some(pred);
    // The ROM itself is the first box; checking it forces every asset box on + disabled (deleting the
    // ROM takes its assets too). All boxes start off, so the user opts into exactly what to remove.
    const boxes: ConfirmCheckbox[] = [{ key: 'rom', label: this.i18n.translate('store.delOptRom'), forcesOthers: true }];
    if (any((e) => e.cover === 'has' || e.cover === 'custom' || e.gcv === 'has')) boxes.push({ key: 'cover', label: this.i18n.translate('store.delOptCover') });
    if (any((e) => e.snapshot === 'has' || e.fmv === 'has')) boxes.push({ key: 'preview', label: this.i18n.translate('store.delOptPreview') });
    if (any((e) => e.info === 'has')) boxes.push({ key: 'info', label: this.i18n.translate('store.delOptInfo') });
    if (any((e) => e.cheats === 'has')) boxes.push({ key: 'cheats', label: this.i18n.translate('store.delOptCheats') });
    if (any((e) => e.state === 'has')) boxes.push({ key: 'states', label: this.i18n.translate('store.delOptStates') });
    if (any((e) => e.save)) boxes.push({ key: 'save', label: this.i18n.translate('store.delOptSave') });
    return boxes;
  }

  /** Delete a stem's selected on-card assets (not the ROM). Keys: cover (.cov + .gcv), preview
   *  (.gss/.fmv/.pcm), info (.yml), cheats (.yml), states (.state slots), save (.srm/.gtc/.mpk). */
  private async removeAssets(key: AssetKey, romDir: FileSystemDirectoryHandle | null | undefined, assets: ReadonlySet<string>): Promise<void> {
    const stem = key.stem;
    if (assets.has('cover') && romDir) { try { await this.card.remove(romDir, stem + '.cov'); } catch {  } }/* */
    if (assets.has('cheats')) {
      const d = await this.bucketDir(CHEATS_ROOT, key);
      if (d) { try { await this.card.remove(d, stem + '.yml'); } catch {  } }/* */
    }
    if (assets.has('save')) {
      const d = await this.bucketDir(SAVES_ROOT, key);
      if (d) for (const ext of ['.srm', '.gtc', '.mpk']) {
        try { await this.card.remove(d, stem + ext); } catch {  }/* */
      }
    }
    if (assets.has('states')) {
      for (const s of await this.listSaveStates(key)) { try { await this.card.remove(s.dir, s.name); } catch {  } }/* */
      this.stateKeys.delete(assetIndexKey(key));
    }
    if (this.rootHandle && (assets.has('cover') || assets.has('preview') || assets.has('info'))) {
      try {
        const infoDir = await this.getDir(infoDirFor(key));
        if (infoDir) {
          if (assets.has('cover')) { try { await this.card.remove(infoDir, stem + '.gcv'); } catch {  } }/* */
          if (assets.has('preview')) for (const ext of ['.gss', '.fmv', '.pcm']) {
            try { await this.card.remove(infoDir, stem + ext); } catch {  }/* */
          }
          if (assets.has('info')) { try { await this.card.remove(infoDir, stem + '.yml'); } catch {  } }/* */
        }
      } catch {  }/* */
    }
  }

  /** Delete the ROM file(s) + any opted-in on-card assets (keys per removeAssets). */
  async deleteEntries(ids: Iterable<string>, assets: ReadonlySet<string> = new Set()): Promise<void> {
    const idset = new Set(ids);
    const targets = this._entries().filter((e) => idset.has(e.id));
    for (const e of targets) {
      if (e.dirHandle) { try { await this.card.remove(e.dirHandle, e.file); } catch {  } }/* gone */
      if (assets.size) await this.removeAssets(this.key(e.file), e.dirHandle, assets);
    }
    this._entries.update((gs) => gs.filter((g) => !idset.has(g.id)));
    if (this._selId() && idset.has(this._selId()!)) this._selId.set(null);
    this._selected.update((s) => { const n = new Set(s); for (const id of idset) n.delete(id); return n; });
    if (targets.length) this.toast.show(this.i18n.translate(targets.length > 1 ? 'store.gamesDeletedMany' : 'store.gamesDeletedOne', { count: targets.length }), 'warn');
  }

  /** Remove a ROM's stem-keyed siblings in the fixed dirs (cheats/saves/states/info). */
  private async deleteSiblings(key: AssetKey): Promise<void> {
    const stem = key.stem;
    { const d = await this.bucketDir(CHEATS_ROOT, key);
      try { if (d) await this.card.remove(d, stem + '.yml'); } catch {  } }/* */
    // /sd2snes/saves: SRAM (.srm), Super Game Boy rtc (.gtc), BS-X Memory Pack (.mpk)
    { const d = await this.bucketDir(SAVES_ROOT, key);
      for (const ext of ['.srm', '.gtc', '.mpk']) {
        try { if (d) await this.card.remove(d, stem + ext); } catch {  }/* */
      } }
    // /sd2snes/states: save-state slots <stem>NN.state
    for (const s of await this.listSaveStates(key)) {
      try { await this.card.remove(s.dir, s.name); } catch {  }/* */
    }
    if (this.rootHandle) {
      try {
        const infoDir = await this.getDir(infoDirFor(key));
        if (infoDir) for (const ext of ['.yml', '.gcv', '.gss', '.fmv', '.pcm']) {
          try { await this.card.remove(infoDir, stem + ext); } catch {  }/* */
        }
        // guides (.man): <stem>.man + <stem>.0N.man. Otherwise deleting the ROM leaves orphaned
        // (potentially tens-of-MB) guide files behind forever.
        if (infoDir) for (const nn of GUIDE_SLOTS) {
          try { await this.card.remove(infoDir, guideFileName(stem, nn)); } catch {  }/* not present */
        }
      } catch {  }/* */
    }
  }

  /* ---- drag-and-drop ---- */
  beginDragEntry(id: string): void {
    this._dragFolder.set(null);
    const sel = this._selected();
    this._dragging.set(sel.has(id) ? [...sel] : [id]);
  }
  beginDragFolder(path: string): void {
    if (!path) return;
    this._dragging.set([]);
    this._dragFolder.set(path);
  }
  endDrag(): void { this._dragging.set([]); this._dragFolder.set(null); }

  /** Whether the current drag can drop onto `path` (entry move or folder reparent). */
  canDropOn(path: string): boolean {
    const fp = this._dragFolder();
    if (fp !== null) {
      if (path === fp || path.startsWith(fp + '/')) return false; // self / descendant
      const parent = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : '';
      return path !== parent; // already there → no-op
    }
    const set = new Set(this._dragging());
    if (!set.size) return false;
    return this._entries().some((e) => set.has(e.id) && e.folder !== path);
  }

  /* ---- move ---- */
  async moveEntries(ids: Iterable<string>, destFolderPath: string): Promise<void> {
    const idset = new Set(ids);
    const targets = this._entries().filter((e) => idset.has(e.id) && e.folder !== destFolderPath);
    if (!targets.length) { this.endDrag(); return; }
    if (this.rootHandle && this.bulkBusy()) { this.endDrag(); return; } // real-card move uses the bulk bar

    if (!this.rootHandle) { // demo, just reassign the folder
      this._entries.update((gs) => gs.map((g) => (idset.has(g.id) ? { ...g, folder: destFolderPath } : g)));
      this.addFolder(destFolderPath);
      this.endDrag();
      this.clearSel();
      this.toast.show(this.i18n.translate(targets.length > 1 ? 'store.gamesMovedMany' : 'store.gamesMovedOne', { count: targets.length, dest: destFolderPath || this._rootName() }), 'ok');
      return;
    }

    let dest: FileSystemDirectoryHandle;
    try { dest = await this.card.ensureDir(this.rootHandle, destFolderPath); }
    catch (err) { this.toast.show(this.i18n.translate('store.moveFailed', { error: msg(err) }), 'warn'); this.endDrag(); return; }

    this.bulkBegin(targets.length, this.i18n.translate('store.moving'));
    let moved = 0, done = 0;
    let bulkChoice: ConflictAction | null = null;
    for (const e of targets) {
      if (!e.dirHandle || !e.fileHandle) { done++; this._bulk.update((b) => (b ? { ...b, done } : b)); continue; }
      let name = e.file;
      if (await fileExists(dest, name)) {
        let action = bulkChoice;
        if (!action) {
          const r = await this.dialog.conflict(name);
          if (r.action === 'cancel') break;
          action = r.action;
          if (r.all) bulkChoice = r.action;
        }
        if (action === 'skip') { done++; this._bulk.update((b) => (b ? { ...b, done } : b)); continue; }
        if (action === 'keepboth') name = await this.uniqueName(dest, name);
        if (action === 'overwrite') { try { await dest.removeEntry(name); } catch {  } }/* */
      }
      try {
        const newStem = stemOf(name);
        const newFh = await this.card.moveFile(e.dirHandle, e.fileHandle, dest, name);
        if (e.cover === 'has' || e.cover === 'custom') {
          try {
            const covFh = await e.dirHandle.getFileHandle(stemOf(e.file) + '.cov');
            await this.card.moveFile(e.dirHandle, covFh, dest, newStem + '.cov');
          } catch {  }/* no .cov */
        }
        this.update(e.id, { folder: destFolderPath, dirHandle: dest, file: name, fileHandle: newFh });
        moved++;
      } catch (err) {
        this.toast.show(this.i18n.translate('store.moveFileFailed', { name: e.file, error: msg(err) }), 'warn');
      }
      done++; this._bulk.update((b) => (b ? { ...b, done } : b));
    }
    this._bulk.set(null);
    this.addFolder(destFolderPath);
    this.endDrag();
    if (moved) {
      this.clearSel();
      this.toast.show(this.i18n.translate(moved > 1 ? 'store.gamesMovedMany' : 'store.gamesMovedOne', { count: moved, dest: destFolderPath || this._rootName() }), 'ok');
    }
  }

  private async uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 1;
    let candidate = `${base} (${i})${ext}`;
    while (await fileExists(dir, candidate)) candidate = `${base} (${++i})${ext}`;
    return candidate;
  }

  /* ---- copy ---- */
  async copyEntries(ids: Iterable<string>, destFolderPath: string): Promise<void> {
    const idset = new Set(ids);
    const targets = this._entries().filter((e) => idset.has(e.id));
    if (!targets.length) return;
    if (this.rootHandle && this.bulkBusy()) return; // real-card copy uses the bulk bar

    if (!this.rootHandle) { // demo, clone the entries into the folder
      const clones = targets.map((e) => ({ ...e, id: 'copy' + ++this.copySeq, folder: destFolderPath, thumbUrl: undefined }));
      this._entries.update((gs) => [...gs, ...clones]);
      this.addFolder(destFolderPath);
      this.clearSel();
      this.toast.show(this.i18n.translate(targets.length > 1 ? 'store.gamesCopiedMany' : 'store.gamesCopiedOne', { count: targets.length, dest: destFolderPath || this._rootName() }), 'ok');
      return;
    }

    let dest: FileSystemDirectoryHandle;
    try { dest = await this.card.ensureDir(this.rootHandle, destFolderPath); }
    catch (err) { this.toast.show(this.i18n.translate('store.copyFailed', { error: msg(err) }), 'warn'); return; }

    this.bulkBegin(targets.length, this.i18n.translate('store.copying'));
    let copied = 0, done = 0;
    let bulkChoice: ConflictAction | null = null;
    for (const e of targets) {
      if (!e.fileHandle || !e.dirHandle) { done++; this._bulk.update((b) => (b ? { ...b, done } : b)); continue; }
      let name = e.file;
      if (await fileExists(dest, name)) {
        let action = bulkChoice;
        if (!action) {
          const r = await this.dialog.conflict(name);
          if (r.action === 'cancel') break;
          action = r.action;
          if (r.all) bulkChoice = r.action;
        }
        if (action === 'skip') { done++; this._bulk.update((b) => (b ? { ...b, done } : b)); continue; }
        if (action === 'keepboth') name = await this.uniqueName(dest, name);
        if (action === 'overwrite') { try { await dest.removeEntry(name); } catch {  } }/* */
      }
      try {
        const newStem = stemOf(name);
        const newFh = await this.card.copyFile(e.fileHandle, dest, name);
        let cover: Entry['cover'] = 'none';
        if (e.cover === 'has' || e.cover === 'custom') {
          try {
            const covFh = await e.dirHandle.getFileHandle(stemOf(e.file) + '.cov');
            await this.card.copyFile(covFh, dest, newStem + '.cov');
            cover = e.cover;
          } catch { cover = 'none'; }
        }
        // stem-keyed siblings (cheats/save/fmv) are shared only when the stem is unchanged
        const sameStem = newStem === stemOf(e.file);
        const clone: Entry = {
          ...e,
          id: 'copy' + ++this.copySeq,
          folder: destFolderPath,
          dirHandle: dest,
          fileHandle: newFh,
          file: name,
          cover,
          thumbUrl: undefined,
          cheats: sameStem ? e.cheats : 'none',
          cheatList: sameStem ? e.cheatList : undefined,
          cheatsRaw: sameStem ? e.cheatsRaw : undefined,
          save: sameStem ? e.save : false,
          fmv: sameStem ? e.fmv : 'none',
        };
        this._entries.update((gs) => [...gs, clone]);
        copied++;
      } catch (err) {
        this.toast.show(this.i18n.translate('store.copyFileFailed', { name: e.file, error: msg(err) }), 'warn');
      }
      done++; this._bulk.update((b) => (b ? { ...b, done } : b));
    }
    this._bulk.set(null);
    this.addFolder(destFolderPath);
    if (copied) {
      this.clearSel();
      this.toast.show(this.i18n.translate(copied > 1 ? 'store.gamesCopiedMany' : 'store.gamesCopiedOne', { count: copied, dest: destFolderPath || this._rootName() }), 'ok');
    }
  }

  /* ---- folder operations ---- */
  startNewFolder(parent: string): void { this._newFolderParent.set(parent); }
  cancelNewFolder(): void { this._newFolderParent.set(null); }

  async createFolder(parentPath: string, name: string): Promise<void> {
    this._newFolderParent.set(null);
    name = name.trim().replace(/[/\\]/g, '');
    if (!name) return;
    const full = parentPath ? parentPath + '/' + name : name;
    try {
      if (this.rootHandle) {
        const parent = await this.card.ensureDir(this.rootHandle, parentPath);
        await this.card.createFolder(parent, name);
      }
      this.addFolder(full);
      this.navTo(full);
      this.toast.show(this.i18n.translate('store.folderCreated', { name }), 'ok');
    } catch (err) {
      this.toast.show(this.i18n.translate('store.createFolderFailed', { error: msg(err) }), 'warn');
    }
  }

  async deleteFolder(path: string): Promise<void> {
    if (!path) return;
    const inFolder = this._entries().filter((e) => e.folder === path || e.folder.startsWith(path + '/'));
    const leafName = path.split('/').pop() ?? path;
    const r = await this.dialog.confirm({
      title: this.i18n.translate('store.deleteFolderTitle', { name: leafName }),
      body: inFolder.length
        ? this.i18n.translate(inFolder.length > 1 ? 'store.deleteFolderBodyMany' : 'store.deleteFolderBodyOne', { count: inFolder.length })
        : this.i18n.translate('store.deleteFolderBodyEmpty'),
      confirmLabel: this.i18n.translate('store.delete'), danger: true,
      checkboxLabel: inFolder.length ? this.i18n.translate('store.deleteFolderCheckbox') : undefined,
      checkboxDefault: false,
    });
    if (!r.ok) return;
    try {
      if (this.rootHandle) {
        const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const parent = parentPath ? await getDirByPath(this.rootHandle, parentPath) : this.rootHandle;
        if (parent) await this.card.removeFolder(parent, leafName);
      }
      if (r.checked) for (const e of inFolder) await this.deleteSiblings(this.key(e.file));
      const idset = new Set(inFolder.map((e) => e.id));
      this._entries.update((gs) => gs.filter((g) => !idset.has(g.id)));
      this.removeFolderPaths(path);
      if (this._cwd() === path || this._cwd().startsWith(path + '/')) {
        this.navTo(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
      }
      this.toast.show(this.i18n.translate('store.folderDeleted', { name: leafName }), 'warn');
    } catch (err) {
      this.toast.show(this.i18n.translate('store.deleteFolderFailed', { error: msg(err) }), 'warn');
    }
  }

  async renameFolder(path: string, newName: string): Promise<void> {
    newName = newName.trim().replace(/[/\\]/g, '');
    if (!path || !newName) return;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const newPath = parentPath ? parentPath + '/' + newName : newName;
    await this.relocateFolder(path, newPath);
  }

  /** Reparent a folder under `destParentPath` (drag-and-drop). */
  async moveFolder(path: string, destParentPath: string): Promise<void> {
    if (!path) { this.endDrag(); return; }
    const leaf = path.split('/').pop()!;
    const newPath = destParentPath ? destParentPath + '/' + leaf : leaf;
    await this.relocateFolder(path, newPath);
    this.endDrag();
  }

  /** Recursively relocate a folder (rename and/or reparent) on disk + in state. */
  private async relocateFolder(oldPath: string, newPath: string): Promise<void> {
    if (!oldPath || newPath === oldPath) return;
    if (newPath.startsWith(oldPath + '/')) {
      this.toast.show(this.i18n.translate('store.cantMoveFolderIntoItself'), 'warn');
      return;
    }
    const oldLeaf = oldPath.split('/').pop()!;
    const newLeaf = newPath.split('/').pop()!;
    const oldParentPath = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
    const newParentPath = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '';
    const inFolder = this._entries().filter((e) => e.folder === oldPath || e.folder.startsWith(oldPath + '/'));
    try {
      if (this.rootHandle) {
        const destParent = newParentPath ? await this.card.ensureDir(this.rootHandle, newParentPath) : this.rootHandle;
        if (await dirExists(destParent, newLeaf)) {
          this.toast.show(this.i18n.translate('store.folderAlreadyExistsThere', { name: newLeaf }), 'warn');
          return;
        }
        const srcDir = await getDirByPath(this.rootHandle, oldPath);
        if (srcDir) {
          await this.card.moveFolderRecursive(srcDir, destParent, newLeaf);
          const srcParent = oldParentPath ? await getDirByPath(this.rootHandle, oldParentPath) : this.rootHandle;
          try { if (srcParent) await this.card.removeFolder(srcParent, oldLeaf); } catch {  }/* */
        }
        // re-resolve each moved entry's handles at its new location
        for (const e of inFolder) {
          const nf = newPath + e.folder.slice(oldPath.length);
          const dh = await getDirByPath(this.rootHandle, nf);
          let fh = e.fileHandle;
          if (dh) { try { fh = await dh.getFileHandle(e.file); } catch {  } }/* */
          this.update(e.id, { folder: nf, dirHandle: dh ?? e.dirHandle, fileHandle: fh });
        }
      } else {
        for (const e of inFolder) this.update(e.id, { folder: newPath + e.folder.slice(oldPath.length) });
      }
      this.renameFolderPaths(oldPath, newPath);
      const cwd = this._cwd();
      if (cwd === oldPath || cwd.startsWith(oldPath + '/')) this.navTo(newPath + cwd.slice(oldPath.length));
      this.toast.show(
        oldParentPath === newParentPath
          ? this.i18n.translate('store.folderRenamedTo', { name: newLeaf })
          : this.i18n.translate('store.folderMovedTo', { name: oldLeaf, dest: newParentPath || this._rootName() }),
        'ok',
      );
    } catch (err) {
      this.toast.show(this.i18n.translate('store.folderOperationFailed', { error: msg(err) }), 'warn');
    }
  }

  /* ---- bulk ops (simulated generation; download-only this phase) ---- */
  async runBulk(kind: 'cover' | 'cheats', ids?: ReadonlySet<string>): Promise<void> {
    if (this.bulkBusy()) return;
    this.cancelImport = false; // shared cooperative-cancel flag. Reset so a Cancel actually stops this run
    this.card.resetWriteHealth(); // fresh write-health (latches + stops the run if the card goes unwritable)
    const inSel = (g: Entry): boolean => (ids ? ids.has(g.id) : true);
    if (kind === 'cheats') {
      const targets = this._entries().filter((g) => inSel(g) && g.cheats === 'available');
      if (!targets.length) return;
      this._bulk.set({ done: 0, total: targets.length, label: this.i18n.translate('store.downloadingCheats'), cancelable: true });
      let cheatsDone = 0;
      try {
        for (let i = 0; i < targets.length; i++) {
          if (this.cancelImport || this.card.unwritable) break;
          const g = targets[i];
          this.update(g.id, { busy: 'cheats' });
          if (g.fileHandle) {
            await this.dlCheats(g, true);   // reserved catalog from the CRC lookup → no /cheats/<CRC>.yml fetch
          } else {
            await sleep(420);
            this.update(g.id, (gg) => ({ cheats: 'has', busy: null, cheatList: gg.cheatList ?? this.defaultCheats.map((c) => ({ ...c })) }));
          }
          cheatsDone++;
          this._bulk.update((b) => (b ? { ...b, done: i + 1 } : b));
        }
      } finally {
        this._bulk.set(null);
        if (ids) this.clearSel();
      }
      this.toast.show(
        `${this.cancelImport ? this.i18n.translate('store.stoppedPrefix') : ''}${this.i18n.translate(cheatsDone === 1 ? 'store.cheatsDownloadedOne' : 'store.cheatsDownloadedMany', { count: cheatsDone })}`,
        this.cancelImport ? 'warn' : 'info',
      );
      if (this.card.unwritable) this.toast.show(this.i18n.translate('store.cardUnwritable'), 'warn');
      return;
    }

    // covers: auto-identify (CRC → gamedb) then really generate the capa per game (no simulation). A capa
    // is incomplete when it lacks the browser .cov or the game info .gcv (fillPresent('capa') = both), so a
    // .cov-without-.gcv is targeted too, the loop derives the missing .gcv from the existing .cov.
    const targets = this._entries().filter((g) => inSel(g) && g.fileHandle && !this.fillPresent(g, 'capa'));
    if (!targets.length) {
      // Don't no-op silently, the user clicked a button. Explain why nothing ran.
      const scope = this._entries().filter((g) => inSel(g) && g.fileHandle);
      const withCover = scope.filter((g) => this.fillPresent(g, 'capa')).length; // capa complete = .cov + .gcv
      this.toast.show(
        withCover
          ? withCover === scope.length
            ? this.i18n.translate(ids ? 'store.nothingToGenerateAllSelected' : 'store.nothingToGenerateAll')
            : this.i18n.translate('store.nothingToGenerateSome', { count: withCover })
          : this.i18n.translate(ids ? 'store.noEligibleSelectedRoms' : 'store.noEligibleRoms'),
        'info',
      );
      return;
    }
    // Batch-identify the unidentified up-front (one gamedb request per IDENTIFY_BATCH=50) so the per-cover loop
    // below works from already-resolved matches instead of a lookup-per-ROM.
    const unident = targets.filter((g) => !g.identified);
    if (unident.length) {
      this.bulkBegin(unident.length, this.i18n.translate('store.identifying'), true);
      await this.identifyEntries(unident, {
        shouldStop: () => this.cancelImport,
        onProgress: (n) => this._bulk.update((b) => (b ? { ...b, done: n } : b)),
      });
      if (this.cancelImport) {
        this._bulk.set(null);
        this.toast.show(this.i18n.translate('store.stoppedNothingWritten'), 'info');
        return;
      }
    }
    this._bulk.set({ done: 0, total: targets.length, label: this.i18n.translate('store.generatingCovers'), cancelable: true });
    // made = real .cov written · gdFail = .cov ok but .gd skipped · covFail = .cov itself failed
    // unreached = GameDB lookup never completed (transient) · noMatch = lookup ok, no cover there
    let made = 0, gdFail = 0, covFail = 0, unreached = 0, noMatch = 0, shotMiss = 0;
    const shotRetry: string[] = []; // covers whose GameDB screenshot fetch dropped (retry-worthy)
    try {
      for (let i = 0; i < targets.length; i++) {
        if (this.cancelImport || this.card.unwritable) break;
        // re-read the entry: the batch pre-pass above already identified most, so this is current
        let g = this.entriesById().get(targets[i].id) ?? targets[i];
        if (!g.identified) {
          await this.identify(g); // fallback for any the batch pre-pass missed (chunk failure)
          g = this.entriesById().get(g.id) ?? g; // identify() flushed, so this sees the match
        }
        if (g.coverUrl) {
          const res = await this.encodeAndPlaceCover(g, g.coverUrl, 'has', 'Generated .cov', true);
          if (res === 'cov-failed') covFail++;
          else if (res === 'cov-readonly') {  }/* read-only folder → recorded in the fill report, not a failure */
          else { made++; if (res === 'gd-failed') gdFail++; else if (res === 'shot-missing') shotRetry.push(g.id); }
        } else if (g.cover === 'has' || g.cover === 'custom') {
          // No GameDB cover image, but a .cov is already on the card → derive the missing game info .gcv
          // from it (the reason this game is a target). Bounded + fail-safe.
          if (await this.genGcvFromCov(g, true)) made++; else covFail++;
        } else if (!g.identified) {
          unreached++; // identify() left it unidentified → transient network/CORS/5xx, not a true miss
        } else {
          noMatch++;
        }
        this._bulk.update((b) => (b ? { ...b, done: i + 1 } : b));
      }
      // Recover snapshots a transient CDN blip dropped (cheap, rewrites only the .gd).
      if (shotRetry.length && !this.cancelImport && !this.card.unwritable) {
        this._bulk.set({ done: 0, total: shotRetry.length, label: this.i18n.translate('store.retryingSnapshots'), cancelable: true });
        let recovered = 0;
        for (let i = 0; i < shotRetry.length; i++) {
          if (this.cancelImport || this.card.unwritable) break;
          const gg = this.entriesById().get(shotRetry[i]);
          if (gg && (await this.retryGdSnapshot(gg))) recovered++;
          this._bulk.update((b) => (b ? { ...b, done: i + 1 } : b));
        }
        shotMiss = shotRetry.length - recovered;
      } else {
        shotMiss = shotRetry.length;
      }
    } finally {
      this._bulk.set(null);
      if (ids) this.clearSel();
    }
    if (made) {
      const bits: string[] = [];
      if (gdFail) bits.push(this.i18n.translate(gdFail > 1 ? 'store.tailGdSkippedMany' : 'store.tailGdSkippedOne', { count: gdFail }));
      if (shotMiss) bits.push(this.i18n.translate(shotMiss > 1 ? 'store.tailSnapshotsFailedMany' : 'store.tailSnapshotsFailedOne', { count: shotMiss }));
      if (covFail) bits.push(this.i18n.translate('store.tailFailed', { count: covFail }));
      if (unreached) bits.push(this.i18n.translate('store.tailNotReached', { count: unreached }));
      const extra = bits.length ? ` · ${bits.join(' · ')}` : '';
      this.toast.show(`${this.i18n.translate(made > 1 ? 'store.coversGeneratedMany' : 'store.coversGeneratedOne', { count: made })}${extra}`, bits.length ? 'warn' : 'ok');
    } else if (covFail) {
      this.toast.show(this.i18n.translate(ids ? 'store.coverGenFailedSelected' : 'store.coverGenFailedAll', { count: covFail }), 'warn');
    } else if (unreached) {
      this.toast.show(this.i18n.translate(ids ? 'store.gamedbUnreachedSelected' : 'store.gamedbUnreachedAll', { count: unreached }), 'warn');
    } else {
      this.toast.show(this.i18n.translate(ids ? 'store.noGamedbCoverSelected' : 'store.noGamedbCoverAll', { count: noMatch }), 'warn');
    }
    if (this.card.unwritable) this.toast.show(this.i18n.translate('store.cardUnwritable'), 'warn');
  }
  async bulkDelete(ids: ReadonlySet<string>): Promise<void> {
    const n = ids.size;
    if (!n) return;
    const anyReal = this._entries().some((e) => ids.has(e.id) && e.fileHandle);
    if (!anyReal) { // demo
      this._entries.update((gs) => gs.filter((g) => !ids.has(g.id)));
      if (this._selId() && ids.has(this._selId()!)) this._selId.set(null);
      this.clearSel();
      this.toast.show(this.i18n.translate(n > 1 ? 'store.deletedRomsMany' : 'store.deletedRomsOne', { count: n }), 'warn');
      return;
    }
    const r = await this.dialog.confirm({
      title: this.i18n.translate(n > 1 ? 'store.deleteGamesTitleMany' : 'store.deleteGamesTitleOne', { count: n }),
      body: this.i18n.translate(n > 1 ? 'store.deleteGamesBodyMany' : 'store.deleteGamesBodyOne', { count: n }),
      confirmLabel: this.i18n.translate('store.delete'), danger: true,
      checkboxes: this.assetDeleteBoxes(this._entries().filter((e) => ids.has(e.id))),
    });
    if (!r.ok) return;
    const keys = new Set(r.checkedKeys);
    if (keys.has('rom')) await this.deleteEntries(ids, keys);   // ROM(s) (+ their forced assets)
    else await this.deleteAssetsOnly(ids, keys);                // keep the ROMs, drop only the assets
  }
}

/** Shape returned by the ported scanRoms (untyped JS). */
interface ScannedRom {
  name: string;
  folder: string;
  system: System | null;
  fileHandle: FileSystemFileHandle;
  dirHandle: FileSystemDirectoryHandle;
}

/** A scanned `.thm`/`.skin` file (untyped JS scanTree result). */
interface ScannedTheme {
  name: string;
  folder: string;
  path: string;
  fileHandle: FileSystemFileHandle;
  dirHandle: FileSystemDirectoryHandle;
}

/** What scanTree (untyped JS) hands back. */
interface ScannedTree {
  roms: ScannedRom[];
  dirs: string[];
  themes: ScannedTheme[];
  patches: ScannedName[];
  /** `covKey(folder, stem)` of every `.cov` in the ROM tree, see LibraryStore.covStems. */
  covStems: ReadonlySet<string>;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
