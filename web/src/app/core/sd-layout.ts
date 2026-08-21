/**
 * The SD card layout for firmware 2.15+, two-letter bucket directories.
 *
 *   /sd2snes/info/SU/Super Mario World (USA).yml
 *   /sd2snes/cheats/SU/Super Mario World (USA).yml
 *   /sd2snes/saves/SU/Super Mario World (USA).srm
 *   /sd2snes/states/SU/Super Mario World (USA)01.state
 *
 * Game Boy ROMs get a namespace of their own inside each root:
 *
 *   /sd2snes/saves/sgb/TE/Tetris.srm            (Tetris.gb)
 *   /sd2snes/saves/TE/Tetris.srm                (Tetris.sfc)
 *
 * because a sidecar is named from the ROM's stem, so without it those two games would share one
 * save file. See isGbRom() for the predicate; it has a trap in it.
 *
 * The buckets exist because a FAT lookup is linear and long-name compares are expensive. On a real
 * card /sd2snes/cheats held 2121 entries and /sd2snes/info/S held 1512, costing the firmware ~720ms
 * and ~300ms per game load (measured on hardware). Two characters take the median directory from
 * ~770 files to ~40.
 *
 * The rule:
 *   bucket(leaf) = f(leaf[0]) + f(leaf[1])
 *   f(c) = upper(c) if [0-9A-Z] after uppercasing, else '_'      a missing character -> '_'
 *
 * It runs on the raw leaf, before the extension is stripped. Deriving from the stem gives the same
 * answer: the only index-1 difference is a one-character stem, where the raw leaf gives '.'->'_' and
 * the stem gives the pad '_'. Worth stating, since the two mirrors could drift by picking the other
 * order.
 *
 * Those mirrors: the Manager writes these paths and the firmware reads them. If they disagree the
 * device looks in a directory we never created and the user sees saves, cheats and covers
 * "disappear".
 *   firmware: _repo/src/fileops.c  path_bucket2() / path_asset(), pinned by tests/host/run_bucket.sh
 *   here:     bucketOf() / isGbRom(), pinned by sd-layout.spec.ts (same cases)
 *
 * ASCII-only on purpose: the firmware works on bytes with no Unicode case mapping, so anything
 * outside [0-9A-Z] has to collapse identically on both sides.
 */

export const SD_ROOT = 'sd2snes';
export const INFO_ROOT = `${SD_ROOT}/info`;
export const CHEATS_ROOT = `${SD_ROOT}/cheats`;
export const SAVES_ROOT = `${SD_ROOT}/saves`;
export const STATES_ROOT = `${SD_ROOT}/states`;

/** The roots that carry per-game assets and therefore get bucketed. */
export const BUCKETED_ROOTS = [INFO_ROOT, CHEATS_ROOT, SAVES_ROOT, STATES_ROOT] as const;
export type BucketedRoot = (typeof BUCKETED_ROOTS)[number];

export const BUCKET_LEN = 2;
const PAD = '_';

/** One bucket character: a-z→A-Z, keep 0-9/A-Z, anything else (or missing) → '_'. */
export function bucketCharOf(c: string | undefined): string {
  if (!c) return PAD;
  const u = c.charCodeAt(0);
  const up = u >= 97 && u <= 122 ? u - 32 : u;
  return (up >= 48 && up <= 57) || (up >= 65 && up <= 90) ? String.fromCharCode(up) : PAD;
}

/** ROM filename stem (strip the last extension), as the firmware does with strrchr('.'). */
export function romStem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Bucket directory for a ROM leaf/stem. Always BUCKET_LEN characters.
 * Pass the raw leaf where you have it; passing the stem gives the same answer (see the header).
 */
export function bucketOf(leaf: string): string {
  let out = '';
  for (let i = 0; i < BUCKET_LEN; i++) out += bucketCharOf(leaf[i]);
  return out;
}

/** The pre-2.15 single-character bucket. Only the migration reads this, nothing writes it. */
export function legacyBucketOf(leaf: string): string {
  return bucketCharOf(leaf[0]);
}

/** The Game Boy namespace segment, directly under each bucketed root. */
export const SGB_SEG = 'sgb';

/**
 * Sufami Turbo minicarts get a namespace for the same reason Game Boy does: a sidecar is named
 * from the ROM stem, so without it "Tetris.st" and "Tetris.sfc" would share one .srm.
 *
 * THREE letters, not two: FAT is case-insensitive, so "st/" would BE the "ST" bucket -- the one
 * holding Star Ocean and the ST010 carts. Same reason sgb/ is three.
 */
export const SFT_SEG = 'sft';

/**
 * Quarantine for sidecars whose ROM cannot be identified: the stem matches both a Game Boy and a
 * SNES game on the card, so nothing can say which one the file belongs to.
 *
 * They go here rather than staying loose in the root because the firmware cannot read them in
 * Either place, but loose in the root they also slow down every directory scan and look like the
 * migration failed. The folder drains itself: the planner still evaluates what is inside it, so
 * the moment the user renames one of the two ROMs the file moves on to its real bucket.
 */
export const AMBIGUOUS_SEG = '_ambiguous';

export function ambiguousDirFor(root: BucketedRoot | string): string {
  return `${root}/${AMBIGUOUS_SEG}`;
}

/**
 * Does the firmware load this ROM through the Super Game Boy core?
 *
 * Mirrors _repo/src/sgb.c:66-71, which is the one and only GB detection the firmware has:
 *   if(!ext || ext[0] != '.' || tolower(ext[1]) != 'g' || tolower(ext[2]) != 'b') return;
 * i.e. the extension starts with "gb", so .gb and .gbc.
 *
 * ⚠️ ".sgb" is not game boy. It starts with 's', so the firmware loads a .sgb as a plain SNES ROM.
 * Meanwhile this app's own SYSTEM_BY_EXT (lib/scan.js) maps sgb -> 'SGB', which is exactly why
 * this must never key off Entry.system: the system literally named 'SGB' is the one that must
 * stay out of sgb/. Keying off the extension keeps us byte-for-byte with the device.
 */
export function isGbRom(filename: string): boolean {
  const i = filename.lastIndexOf('.');
  return i >= 0 && filename.slice(i + 1, i + 3).toLowerCase() === 'gb';
}

/**
 * THE Sufami Turbo test, mirroring path_is_st() in fileops.c: an EXACT ".st". Not a prefix match
 * like the Game Boy one -- a prefix would swallow ".state", which is a savestate sidecar.
 */
export function isSufamiRom(filename: string): boolean {
  const i = filename.lastIndexOf('.');
  return i >= 0 && filename.slice(i + 1).toLowerCase() === 'st';
}

/** Which namespace a ROM's sidecars live under, '' for the ordinary SNES case. One function so
 *  the two predicates above can never both win at a call site. */
export type AssetNs = '' | typeof SGB_SEG | typeof SFT_SEG;

export function nsOf(filename: string): AssetNs {
  if (isGbRom(filename)) return SGB_SEG;
  if (isSufamiRom(filename)) return SFT_SEG;
  return '';
}

/**
 * Which layout to write.
 *
 * The Manager is a website: users get a new version simply by loading the page, while the firmware
 * on their console only changes when they deliberately flash it. So "the Manager and the firmware
 * ship together" is not a guarantee we can make. The app must be able to write the layout the
 * card's own firmware reads, or a 2.14 user who just opens the page finds newly-downloaded covers
 * and cheats invisible on the console.
 *
 *   'legacy'. Firmware < 2.15: only /sd2snes/info was bucketed, by one character;
 *               cheats/saves/states were flat. No Game Boy namespace existed.
 *   'buckets', firmware >= 2.15: two-letter buckets everywhere, plus sgb/ for Game Boy.
 *
 * Reading tolerates both regardless (see library-store's indexSidecarRoot), this only governs
 * where new files are written.
 */
export type LayoutMode = 'legacy' | 'buckets';

/**
 * A ROM's identity for asset paths: the stem sidecars are named from, which namespace it lives in,
 * and which layout to write.
 *
 * An object rather than loose parameters on purpose. Loose parameters only error on arity. Once a
 * boolean is in scope at these call sites, `infoDirFor(stem, someOtherFlag)` would compile and
 * silently write the wrong path. Bundling means the fields cannot disagree, and it let the layout
 * mode reach ~30 call sites without touching any of them individually: they all go through
 * LibraryStore's `key()` accessor, which is the one place the mode is injected.
 */
export interface AssetKey {
  readonly stem: string;
  readonly ns: AssetNs;
  readonly mode: LayoutMode;
}

/** The asset key for a ROM filename. Extension included, since that is what decides `ns`. */
export function assetKeyOf(romFilename: string, mode: LayoutMode): AssetKey {
  return { stem: romStem(romFilename), ns: nsOf(romFilename), mode };
}

/** Explicit escape hatches for the few places that genuinely only have a stem. */
export const snesKey = (stem: string, mode: LayoutMode): AssetKey => ({ stem, ns: '', mode });
export const gbKey = (stem: string, mode: LayoutMode): AssetKey => ({ stem, ns: SGB_SEG, mode });
export const sufamiKey = (stem: string, mode: LayoutMode): AssetKey => ({ stem, ns: SFT_SEG, mode });

export function bucketDirFor(root: BucketedRoot | string, k: AssetKey): string {
  if (k.mode === 'legacy') {
    // Pre-2.15: info was bucketed by a single character, everything else sat flat in its root,
    // and sgb/ did not exist. A firmware that old would not look inside it.
    return root === INFO_ROOT ? `${root}/${legacyBucketOf(k.stem)}` : `${root}`;
  }
  return k.ns ? `${root}/${k.ns}/${bucketOf(k.stem)}` : `${root}/${bucketOf(k.stem)}`;
}

export const infoDirFor = (k: AssetKey) => bucketDirFor(INFO_ROOT, k);
export const cheatsDirFor = (k: AssetKey) => bucketDirFor(CHEATS_ROOT, k);
export const savesDirFor = (k: AssetKey) => bucketDirFor(SAVES_ROOT, k);
export const statesDirFor = (k: AssetKey) => bucketDirFor(STATES_ROOT, k);

/**
 * Key for the in-memory sidecar index (which saves/cheats/states exist on the card).
 *
 * Branded deliberately: the maps become Map<AssetIndexKey,...>/Set<AssetIndexKey>, so any surviving
 * `saveKeys.has(stem)` is a compile error instead of a silent miss. Without the namespace in the
 * key, saves/TE/Tetris.srm and saves/sgb/TE/Tetris.srm collapse together and the GB game
 * false-positives on the SNES game's save. '/' cannot occur in a FAT leaf, so the prefix is
 * collision-free and still readable in a debugger.
 */
export type AssetIndexKey = string & { readonly __assetIndexKey: unique symbol };

/** Takes only the identity half of an AssetKey: which layout a file is written in has no bearing
 *  on which game it belongs to, and the index is built from files already on the card. */
export function assetIndexKey(k: Pick<AssetKey, 'stem' | 'ns'>): AssetIndexKey {
  return (k.ns ? `${k.ns}/${k.stem}` : k.stem) as AssetIndexKey;
}

/**
 * What a directory found under a bucketed root denotes, `depth` levels below that root.
 *
 * One definition, called by both library-store's sidecar indexer and sd-migration's planner, so
 * the reader and the writer cannot disagree about which directories exist. They each used to
 * carry their own `name.length <= BUCKET_LEN` test, which silently skipped the 3-character sgb/
 * directory, the indexer read every GB sidecar as absent and the planner reported an
 * already-migrated tree as junk.
 *
 * `sgb`/`sft` are recognised only at depth 0, so a stray saves/SG/sgb/ is never followed.
 */
export type RootChild = 'sgb' | 'sft' | 'ambiguous' | 'bucket' | 'unknown';

export function classifyRootChild(name: string, depth: 0 | 1): RootChild {
  if (depth === 0 && name.toLowerCase() === SGB_SEG) return 'sgb';
  if (depth === 0 && name.toLowerCase() === SFT_SEG) return 'sft';
  if (depth === 0 && name.toLowerCase() === AMBIGUOUS_SEG) return 'ambiguous';
  return name.length > 0 && name.length <= BUCKET_LEN ? 'bucket' : 'unknown';
}

/**
 * The ROM stem a file on the card belongs to. I.e. what its bucket must be computed from.
 *
 * This is the sharpest edge in the whole layout. The bucket keys off the ROM name, not off the
 * sidecar's own filename, and several sidecars append to the stem rather than just swapping the
 * extension:
 *   states  "Foo01.state"     -> "Foo"   (slot digits are part of the name, not the extension)
 *   guides  "Foo.02.man"      -> "Foo"
 *   srm     "Foo.03.srm"      -> "Foo"
 * Get this wrong for a short name and the two sides split: ROM "A.sfc" buckets to "A_", but its
 * state "A01.state" would bucket to "A0" and the firmware would never find it.
 */
export function bucketKeyForFile(filename: string): string {
  // savestate slots: <stem>NN.state
  const st = /^(.*?)\d+\.state$/i.exec(filename);
  if (st) return st[1];
  // extra guides / extra SRM slots: <stem>.NN.man, <stem>.NN.srm
  const nn = /^(.*)\.\d{2}\.(man|srm)$/i.exec(filename);
  if (nn) return nn[1];
  return romStem(filename);
}

/**
 * Bucket directory a file should live in, given the root it is under.
 *
 * `sgb` must be supplied by the caller: a sidecar's own extension (.srm, .yml, .state) says
 * nothing about whether its ROM is Game Boy. Only the ROM library can answer that, see
 * buildRomIndex() in sd-migration.service.ts.
 */
export function bucketDirForFile(root: BucketedRoot | string, filename: string, ns: AssetNs): string {
  // Always the new layout: the only caller is the migration, whose whole job is to produce it.
  return bucketDirFor(root, { stem: bucketKeyForFile(filename), ns, mode: 'buckets' });
}

/**
 * Files that are pure noise on the card, but that FAT scans all the same, which doubles every
 * directory lookup the firmware does. See the cleanup in sd-migration.
 *
 * Three families, all of them written by a host and never by a game:
 *   macOS    `._<name>` (AppleDouble), `.DS_Store`, `.Spotlight-V100`
 *   Windows  `Thumbs.db`, `desktop.ini`
 *   us       `<name>.crswap`, Chromium creates one beside the target on every createWritable() of
 *            the File System Access API and renames it into place on close(). A crash, a closed
 *            tab or a cancelled run leaves it behind, so a card the Manager has written to
 *            accumulates them. It is never a legitimate file, and it is the one kind of junk that
 *            looks enough like a sidecar for the migration planner to have moved it into a bucket.
 *
 * Matching
 * Exact names, except the two shapes that are inherently open-ended (`._` prefix, `.crswap`
 * suffix). Never a loose suffix otherwise: `Thumbs.db` as a suffix would eat a user's
 * `myThumbs.db`. Compared case-insensitively because FAT is, two names differing only in case
 * cannot coexist on the card, so a case-sensitive test can only ever miss junk.
 */
const JUNK_FILE_NAMES = new Set(['.ds_store', '.spotlight-v100', 'thumbs.db', 'desktop.ini']);

export function isJunkFile(name: string): boolean {
  if (name.startsWith('._')) return true;      // AppleDouble: punctuation only, no case to fold
  const n = name.toLowerCase();
  return n.endsWith('.crswap') || JUNK_FILE_NAMES.has(n);
}

/**
 * Directories that never belong to the library: the recycle bins, trash and volume metadata that
 * Windows and macOS drop on a removable card. Same matching rule as isJunkFile, exact name,
 * case-insensitive.
 *
 * `.Spotlight-V100` is in both lists on purpose: macOS creates it as a directory, but a card that
 * has been through a FAT repair can carry the same name as a file.
 *
 * The consumer (the whole-card sweep) lands in the next package of this release. It lives here
 * so the sweep and the sidecar indexer cannot end up with two different ideas of what junk is.
 */
const JUNK_DIR_NAMES = new Set([
  'system volume information',
  '$recycle.bin',
  'recycler',
  '.trashes',
  '.temporaryitems',
  '.fseventsd',
  '.spotlight-v100',
]);

export function isJunkDir(name: string): boolean {
  return JUNK_DIR_NAMES.has(name.toLowerCase());
}

/* IPS/BPS patches
 * Patches are not part of the bucket layout: they live next to their ROM, outside /sd2snes
 * entirely. They are in this file because deciding which patch belongs to which ROM is another
 * rule the Manager must mirror byte-for-byte, and because the migration renames the patches that
 * the rule strands.
 *   firmware: _repo/src/patch.c  patch_ext_type() / patch_belongs_to_rom()
 *             pinned by _repo/tests/host/run_patchmatch.sh
 *   here:     patchExtOf() / patchBelongsToRom() / patchShadowsRom()
 *             pinned by sd-layout.spec.ts (same cases)
 */

/** The two patch formats the firmware applies. Mirrored by PATCH_EXTS in lib/scan.js, which decides
 *  which files the card walk collects. The two lists must agree. */
export const PATCH_EXTS = ['ips', 'bps'] as const;
export type PatchExt = (typeof PATCH_EXTS)[number];

/**
 * Mirrors patch_ext_type(): the extension must be exactly "ips"/"bps", case-insensitive, and
 * Exactly three characters, `.ips` yes, `.ips2` and `.ip` no. Returns null when it is neither.
 */
export function patchExtOf(name: string): PatchExt | null {
  const i = name.lastIndexOf('.');
  if (i < 0 || name.length - i !== 4) return null;
  const e = name.slice(i + 1).toLowerCase();
  return PATCH_EXTS.find((x) => x === e) ?? null;
}

/** A patch's own stem. Only meaningful once patchExtOf() has confirmed the 3-char extension. */
export function patchStemOf(name: string): string {
  return name.slice(0, -4);
}

/**
 * Mirrors patch_belongs_to_rom(): will the firmware offer `patchName` when loading `romName` from
 * the same directory? Extension is ips/bps, the name starts with the ROM's stem (case-insensitive,
 * as FAT is), and the patch's own stem is strictly longer than the ROM's.
 *
 * That last condition is the whole reason this file knows about patches at all, see
 * patchShadowsRom below, which is its exact complement.
 */
export function patchBelongsToRom(patchName: string, romName: string): boolean {
  if (!patchExtOf(patchName)) return false;
  const rom = romStem(romName);
  const patch = patchStemOf(patchName);
  if (!rom || patch.length <= rom.length) return false;
  return patch.slice(0, rom.length).toLowerCase() === rom.toLowerCase();
}

/**
 * The patch the firmware deliberately refuses: its stem is exactly the ROM's, so it is
 * indistinguishable from the patch that produced that ROM.
 *
 * "Create patched ROM" writes `<patch stem>.sfc`, so `Zelda - PT-BR.ips` leaves a
 * `Zelda - PT-BR.sfc` sitting beside it under exactly that stem. Offering it again on the patched
 * copy would re-apply the patch over an already-patched image, which corrupts it, an IPS carries
 * no checksum, source size or target size to defend itself. So the firmware skips same-stem
 * patches outright, and the honest `Foo.sfc` + `Foo.ips` convention is collateral damage.
 *
 * Recovering that convention is what the migration's rename does. See planPatchRenames() in
 * sd-migration.service.ts for why "same stem" alone is not enough to justify renaming.
 */
export function patchShadowsRom(patchName: string, romName: string): boolean {
  if (!patchExtOf(patchName)) return false;
  return patchStemOf(patchName).toLowerCase() === romStem(romName).toLowerCase();
}

/**
 * The name a stranded patch is given: `Foo.ips` -> `Foo - Patch 1.ips`.
 *
 * Not translated, and not up for redesign: this exact spelling is what _repo/src/patch.c promises
 * the Manager writes, and the firmware's patch screen renders it as a bare "Patch 1" because
 * patch_display_name() shows the suffix after the ROM stem with leading separators (` `, `-`)
 * stripped. The number is what keeps `Foo.ips` and `Foo.bps` from colliding on one name.
 */
export function patchRenameFor(stem: string, ext: string, n: number): string {
  return `${stem} - Patch ${n}.${ext}`;
}

/** _repo/src/patch.h: patch_scan_dir drops a patch whose basename is >= 128 chars or whose full
 *  path is >= 192, "leaving the patch out of the list is the honest failure". A rename must not
 *  produce a name the firmware would then refuse. */
export const PATCH_BASENAME_MAX = 128;
export const PATCH_PATH_MAX = 192;
