// Shared domain & view-model types. Grows as the ux is built out.

import type { IconName } from '../ui/icon/icon';

/** The three result layouts (toolbar segmented control + Display popover). */
export type View = 'list' | 'gallery' | 'split';

/** Languages a game description can be localized into on the card (`description_<lang>` in the
 *  `.yml`). English is not one of them: it is the canonical `description` and the console's
 *  fallback. Mirrors DESC_LANGS in lib/yml.js (and the gamedb translationLangSchema). */
export type DescLang = 'fr' | 'pt' | 'es' | 'de' | 'it';
export type Descriptions = Partial<Record<DescLang, string>>;

/** Row-height density (Display popover). */
export type Density = 'compact' | 'regular' | 'comfy';

/** Persisted appearance preferences (localStorage). */
export interface Prefs {
  view: View;
  density: Density;
  /** Accent colour as a CSS colour string (one of ACCENT_SWATCHES, or custom). */
  accent: string;
  /** Folder sidebar open/closed. */
  sidebarOpen: boolean;
  /** Statbar's per-system board expanded/collapsed. */
  boardOpen: boolean;
}

/** Accent swatches offered in the Display popover (first is the default violet). */
export const ACCENT_SWATCHES = [
  '#7c6cff', // violet (default)
  '#22c1c3', // teal
  '#3ecf6b', // green
  '#ff5c8a', // pink
  '#ffb020', // amber
] as const;

export const DEFAULT_PREFS: Prefs = {
  view: 'list',
  density: 'regular',
  accent: ACCENT_SWATCHES[0],
  sidebarOpen: true,
  boardOpen: false,
};

/* ---------------- Library domain ---------------- */

export type System = 'SNES' | 'GB' | 'GBC' | 'SGB' | 'BSX' | 'NES' | 'SMS' | 'A26';

/** Canonical display order for platforms, the single source of truth for anything that lists
 *  systems (the statbar board, the toolbar's system chips). Ordered by how common they are on a
 *  card, not alphabetically. */
export const SYSTEM_ORDER: readonly System[] = ['SNES', 'GB', 'GBC', 'SGB', 'BSX', 'NES', 'SMS', 'A26'];

/** A menu-theme file (`.thm`/`.skin`) sitting in a visible card folder. Not a ROM, kept in a parallel
 *  list so it shows in the browser and can be "set as menu theme" without touching the ROM pipeline. */
export interface ThemeFile {
  id: string;      // stable id (the full relative path)
  name: string;    // filename incl. extension
  stem: string;    // filename without extension (display)
  folder: string;  // parent folder relative path ('' = card root)
  path: string;    // full relative path from the card root (folder + '/' + name)
  fileHandle: FileSystemFileHandle;
  dirHandle: FileSystemDirectoryHandle; // parent dir (to remove the file)
}

/** `.cov` on card (has/custom) · matched but not generated (available) · no match (none). */
export type CoverStatus = 'has' | 'custom' | 'available' | 'none';

/** cheats `.yml` on card (has) · available on server (available) · none. */
export type CheatsStatus = 'has' | 'available' | 'none';

/** What a per-game action is currently doing (drives the busy badge). */
export type Busy = 'cover' | 'snapshot' | 'cheats' | 'fmv' | 'guide' | null;

/** Per-category choice in the "Preencher automaticamente" dialog. */
// Escada cumulativa, cada modo contém o anterior: 'off' não mexe; 'complete' escreve só onde falta;
// 'update' escreve onde falta E onde já existe mas está desatualizado vs o GameDB (comparação por token
// sync_* no `<rom>.yml`); 'replace' reescreve todos, inclusive os que já estão em dia.
export type FillMode = 'off' | 'complete' | 'replace' | 'update';
/** The fillable categories and their chosen mode. `manual` is the official GameDB manual (`.man`
 *  with zoom, written to card slot 0, see Entry.manual/manualUrl); it's distinct from `guides`
 *  (slots 2..8), which are user-supplied and never touched by auto-fill. */
export interface FillPlan {
  capa: FillMode;
  tela: FillMode;
  previa: FillMode;
  info: FillMode;
  cheats: FillMode;
  manual: FillMode;
}
export type FillCategory = keyof FillPlan;

/** A single cheat code. `on` mirrors the firmware's `Enabled`; `codes` are the
 *  raw 8-hex (or gg) strings written to /sd2snes/cheats/<stem>.yml. */
export interface Cheat {
  name: string;
  on: boolean;
  codes?: string[];
}

/** One on-card guide's header info (GuidesEditor list row; lib/man.js parseManHeader + file
 *  metadata). `nn` is the slot number (0 = principal `<stem>.man`, 2..8 = `<stem>.0N.man`). */
export interface GuideInfo {
  nn: number;
  fileName: string;
  /** free-text title (user guide), or '' for an official slug-tagged doc, use `slug` for its label */
  title: string;
  /** type slug (1..5) when the `.man` is an official gamedb document, else null (a user guide) */
  slug: number | null;
  npages: number;
  nblocks: number;
  zoomNblocks: number;
  zoom: boolean;
  sizeBytes: number;
}

/** A scanned ROM, enriched by gamedb lookup + on-card status probe. The view
 *  model the whole UI binds to (mock fixture or the real pipeline). */
export interface Entry {
  id: string;
  title: string;
  file: string;
  folder: string;
  system: System;
  crc: string;
  size: number;
  matched: boolean;
  /** CRC computed + gamedb lookup attempted (intentional "Identify"). */
  identified?: boolean;
  /** GameDB game id (from the match), powers the "report on GameDB" deep link. */
  gamedbId?: string;
  cover: CoverStatus;
  /** GameInfo paletted cover (.gcv in /sd2snes/info) present on card. The browser thumbnail uses the
   *  `.cov` next to the ROM (-> `cover`); the game-info screen wants the paletted `.gcv` so it can
   *  coexist with the screenshot. A game with a `.cov` but no `.gcv` still needs its capa filled. */
  gcv?: 'has' | 'none';
  cheats: CheatsStatus;
  /** Sram save (.srm in /sd2snes/saves) present on card. */
  save: boolean;
  /** Save states (<stem>NN.state in /sd2snes/states) present on card. */
  state?: 'has' | 'none';
  /** Animated screenshot (.fmv) on card. */
  fmv?: 'has' | 'none';
  /** Snapshot (the screenshot region inside the .gd) present and non-blank. */
  snapshot?: 'has' | 'none';
  /** Game-info game info (.yml in /sd2snes/info) present on card. */
  info?: 'has' | 'none';
  /** Number of in-game manual/guide `.man` files on card for this stem (0..8; see lib/man.js
   *  GUIDE_SLOTS/MAX_GUIDES, <stem>.man + <stem>.0N.man, N=2..8). Includes slot 0 (the official
   *  GameDB manual, see `manual` below) plus any user-supplied slots (2..8, edited via the
   *  GuidesEditor dialog, never touched by autofill). */
  guides?: number;
  /** Slot 0 (`<stem>.man`, the official GameDB manual) present on card. This is the autofill-owned
   *  slot, 'has'/'none' mirrors fmv/snapshot/info. User guides live in slots 2..8 and are tracked
   *  only by `guides` (count) / GuideInfo, never by this field. */
  manual?: 'has' | 'none';
  /** URL of the ready-made `.man` (with zoom) from the GameDB for this ROM's CRC, or undefined when
   *  the GameDB has none. The Manager downloads this file as-is, it never builds/converts a `.man`
   *  from the GameDB's PDF locally (that's server-side, at approval time). */
  manualUrl?: string;
  /** All manuals the GameDB offers for this game/facet (region ∪ generic), autofill writes each to a
   *  free card slot (0,2..8), deduped by sha256. `manuals[0]` is the primary (= `manualUrl`). */
  manuals?: GameManualMatch[];
  /** Live on-card thumbnail, decoded from the `.cov`, lazily on scroll. */
  thumbUrl?: string;
  /** Real box-art URL from the gamedb (set only on intentional Identify). */
  coverUrl?: string;
  /** Video URL from the gamedb (drives .fmv generation). */
  videoUrl?: string;
  /** Still screenshot URL from the gamedb (preview only). */
  screenshotUrl?: string;
  /** URL of the pre-built `.s2pkg` bundle for this ROM's CRC, when the gamedb has one. Auto-fill
   *  prefers it (one fetch, no ffmpeg) over generating cover/gss/fmv/pcm/cheats from raw media. */
  packageUrl?: string;
  /** Compressed size (bytes) of that `.s2pkg`, the download size, for the auto-fill time estimate. */
  packageBytes?: number;
  /** Legacy "no-audio" `.s2pkg` variant (no `.pcm`), only for packages that still embed the audio.
   *  New packages are audio-less by construction (the base `packageUrl` has no `.pcm`; audio is `pcmUrl`). */
  packageNoAudioUrl?: string;
  packageNoAudioBytes?: number;
  /** Separated, zstd-compressed `.pcm` (audio). Fetched + inflated only when audio is wanted. Present
   *  for new packages (audio-less base); null for legacy packages that embed the `.pcm` in the `.s2pkg`. */
  pcmUrl?: string;
  pcmBytes?: number;
  /** Server-computed digest of this ROM's `.yml` metadata (info staleness token). Stored on the card as
   *  `sync_meta`; a diff on a later lookup means the info/.yml is stale. Set on Identify. */
  metaRev?: string | null;
  /** The on-card `<rom>.yml` parsed into fields (incl. `sync_*` tokens), pre-loaded before the autofill
   *  analysis so staleness can be computed synchronously and token-only rewrites can preserve metadata.
   *  null = no `.yml` on card; undefined = not loaded yet. */
  onCardYml?: Record<string, string> | null;
  /** Which GameDB document sits in each `.man` slot, read from the game info file's `man_slots` (see yml.js).
   *  The card cannot answer this on its own (`<stem>.NN.man` carries no document identity) so without
   *  it an extra manual is only recognizable by its exact bytes, and a GameDB re-encode makes every
   *  extra look brand new and take yet another slot. IN-MEMORY source of truth during a run: the worker
   *  rewrites the game info file from metadata (stripping the key), so re-reading the card mid-run would lose it.
   *  null = the game info file has no map (legacy card → sha-only dedup); undefined = not loaded yet (same
   *  convention as `onCardYml`). Only autofill writes entries here; a user-added guide is never in it. */
  manSlots?: ManSlotMap | null;
  /** Match metadata from the gamedb (for the game info editor + the game-info .yml). */
  developer?: string | null;
  publisher?: string | null;
  releaseYear?: number | null;
  players?: string | null;
  genre?: string | null;
  specialChip?: string | null;
  /** Canonical english description, the `description:` of the `.yml` and the console's fallback. */
  description?: string | null;
  /** Localized descriptions (`description_<lang>` in the `.yml`); the console picks by menu language. */
  descriptions?: Descriptions;
  /** Cover gradient swatches, mock art stand-in (demo mode only). */
  c1?: string;
  c2?: string;
  cheatList?: Cheat[];
  /** Reserved per-CRC cheat catalog from the gamedb lookup, lets auto-fill (dlCheats) write the
   *  catalog without re-fetching <CRC>.yml (the lookup already carried it). */
  dbCheats?: Cheat[];
  /** Raw on-card/fetched cheats YAML, patched in place on toggle to preserve
   *  names (HTML entities), codes and comments exactly. */
  cheatsRaw?: string;
  busy?: Busy;
  /** No-Intro region string parsed from the filename (for region matching). */
  region?: string | null;
  /** File System Access handles (real pipeline; absent for mock entries). */
  fileHandle?: FileSystemFileHandle;
  dirHandle?: FileSystemDirectoryHandle;
}

/** Guide slot (0, 2..8) → the short `groupUuid` tag of the GameDB document installed there. See
 *  Entry.manSlots and yml.js MAN_SLOTS_KEY for why the card needs this written down. */
export type ManSlotMap = ReadonlyMap<number, string>;

/** One GameDB document for a match's facet, a ready `.man` (with zoom) to write to a card slot. */
export interface GameManualMatch {
  uuid: string;
  groupUuid: string;
  /** document kind (manual/guide/map/insert/other), replaces the old free-text title */
  type: 'manual' | 'guide' | 'map' | 'insert' | 'other';
  /** free-text content author (proper noun), or null, distinct from who uploaded it to GameDB */
  author: string | null;
  regionBucket: string | null;
  /** ready-made `.man` (with zoom) URL, served ZSTD-COMPRESSED (`.man.zst`); autofill inflates it (fzstd)
   *  and writes the raw `.man` to the card slot. */
  manualUrl: string | null;
  /** compressed (zstd) download size of the `.man.zst` (for the autofill download estimate). */
  manBytes: number | null;
  /** Raw `.man` size = the bytes written to the card after inflating (for the card-write estimate). */
  manRawBytes: number | null;
  /** reduced PDF (a future in-app viewer), never fed to autofill */
  manualPdfUrl: string | null;
  /** sha256 of the raw `.man`, lets autofill dedup/skip a manual already on the card (compared after
   *  inflating) without re-downloading */
  sha256: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
}

/** Flat, render-ready match returned by GameDbService (from lib/gamedb resolveMatch). */
export interface GameMatch {
  id: string;
  title: string;
  platform: 'snes' | 'gb' | 'gbc' | 'bsx' | 'nes' | 'sms' | 'a26';
  developer: string | null;
  publisher: string | null;
  releaseYear: number | null;
  players: string | null;
  genre: string | null;
  specialChip: string | null;
  /** Canonical english description (the lookup deliberately sends no `?lang=`). */
  description: string | null;
  /** Every translation the GameDB stores for this game, by language code. */
  descriptions: Descriptions;
  bucket: string | null;
  coverUrl: string | null;
  screenshotUrl: string | null;
  videoUrl: string | null;
  /** URL of this ROM's pre-built `.s2pkg` bundle on the gamedb (absolute), or null if none yet. */
  packageUrl?: string | null;
  /** Compressed `.s2pkg` size (bytes), the download size for the auto-fill estimate. */
  packageBytes?: number | null;
  /** Legacy "no-audio" `.s2pkg` variant (no `.pcm`), only for packages that still embed the audio. */
  packageNoAudioUrl?: string | null;
  packageNoAudioBytes?: number | null;
  /** Separated, zstd-compressed `.pcm` (audio). Fetched + inflated only when audio is wanted. Present
   *  for new (audio-less) packages; null for legacy packages that embed the `.pcm`. */
  pcmUrl?: string | null;
  pcmBytes?: number | null;
  /** Server-computed digest of the fields that land in this ROM's `<rom>.yml` (info staleness token).
   *  The Manager stores it as `sync_meta`; a diff on a later lookup means the info/.yml is stale. */
  metaRev?: string | null;
  /** URL of the ready-made `.man` (with zoom, official manual) for this game/region, or null when
   *  the GameDB has none. Resolved from the active `manual` asset (same activeAsset(game,type,bucket)
   *  path as coverUrl/screenshotUrl/videoUrl), falling back to the dto's top-level `manualUrl`. */
  manualUrl?: string | null;
  /** All manuals the GameDB offers for this ROM's region bucket, autofill writes each to a card slot
   *  (0,2..8). Region-specific only (resolveMatch filters on the exact bucket): the GameDB materializes
   *  a row per region, so generic (null-bucket) manuals don't exist in practice, see gamedb.js.
   *  Primary is `manuals[0]` (= the deprecated `manualUrl`). */
  manuals?: GameManualMatch[];
  /** the gamedb has a cheats set for this ROM's CRC (derived from the lookup → no extra probe) */
  cheatsAvailable?: boolean;
  /** the matching per-CRC cheat catalog, reserved from the lookup so auto-fill can write it without
   *  re-fetching <CRC>.yml. null/absent when there's none for this CRC. */
  cheats?: Cheat[] | null;
}

/* ---------------- Filters ---------------- */

export type SystemFilter = 'all' | System;
/** Each `missing-X` has an exact inverse `has-X`, the board's cells drill down to either side. */
export type StatusFilter =
  | 'all'
  | 'missing-cover'
  | 'missing-snapshot'
  | 'missing-preview'
  | 'missing-info'
  | 'missing-cheats'
  | 'missing-guides'
  | 'has-cover'
  | 'has-snapshot'
  | 'has-preview'
  | 'has-info'
  | 'has-cheats'
  | 'has-guides'
  | 'unmatched';

/* ---------------- Per-system asset board (statbar) ---------------- */

/** The board's columns. Deliberately not `FillCategory`: that one's `manual` is only slot 0 (the
 *  official GameDB manual auto-fill owns), while the board's `guias` counts any `.man` on the card
 *  (slot 0 + the user's slots 2..8), it reports what's there, not what auto-fill would write. */
export type BoardCol = 'capa' | 'tela' | 'previa' | 'info' | 'cheats' | 'guias';

/** Column metadata for the board: icon, colour and the status filter a cell drills down to.
 *  Consolidates the icon/colour pairs that were duplicated verbatim across statbar's CSS,
 *  `ui/badge/asset-icons.ts` and autofill-dialog's rows. */
export interface BoardColSpec {
  key: BoardCol;
  icon: IconName;
  /** CSS colour (token or literal), the canonical per-asset colour. */
  color: string;
  /** i18n key for the column header. */
  label: string;
  /** Status filter for the cell's "missing" side. */
  status: StatusFilter;
  /** Status filter for the cell's "on the card" side. */
  statusHas: StatusFilter;
}

export const BOARD_COLS: readonly BoardColSpec[] = [
  { key: 'capa',   icon: 'image',   color: 'var(--accent)',  label: 'statbar.board.capa',   status: 'missing-cover',    statusHas: 'has-cover' },
  { key: 'tela',   icon: 'monitor', color: 'var(--info)',    label: 'statbar.board.tela',   status: 'missing-snapshot', statusHas: 'has-snapshot' },
  { key: 'previa', icon: 'film',    color: '#ff5c8a',        label: 'statbar.board.previa', status: 'missing-preview',  statusHas: 'has-preview' },
  { key: 'info',   icon: 'info',    color: 'var(--tx-mid)',  label: 'statbar.board.info',   status: 'missing-info',     statusHas: 'has-info' },
  { key: 'cheats', icon: 'cheats',  color: 'var(--ok)',      label: 'statbar.board.cheats', status: 'missing-cheats',   statusHas: 'has-cheats' },
  { key: 'guias',  icon: 'book',    color: '#c98cff',        label: 'statbar.board.guias',  status: 'missing-guides',   statusHas: 'has-guides' },
];

/** One cell of the board: what's on the card, what's missing, and the fill ratio (0..100). */
export interface BoardCell {
  have: number;
  missing: number;
  pct: number;
}

/** One row of the board, a platform present on the card (or the aggregate total row, `system: null`). */
export interface BoardRow {
  system: System | null;
  total: number;
  cells: Record<BoardCol, BoardCell>;
}

/* ---------------- Folder tree ---------------- */

export interface FolderNode {
  name: string;
  path: string;
  children: Record<string, FolderNode>;
  childList: FolderNode[];
  direct: number;
  total: number;
  /** Theme files (`.thm`) directly in / anywhere under this folder (so counts aren't "0" for a
   *  themes-only folder like `_themes`). */
  themeDirect: number;
  themeTotal: number;
}

/* ---------------- Toasts ---------------- */

export type ToastKind = 'ok' | 'info' | 'warn';
export interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
}
