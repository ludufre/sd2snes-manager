// CRC32 (IEEE 802.3), matches No-Intro / the gamedb crc32 dedup key.
// SNES ROMs may carry a 512-byte copier header; No-Intro checksums are computed
// Without it, so we strip it (detected by `size % 1024 === 512`) before hashing.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/* ---- incremental API ----
 * The one-shot `crc32(bytes)` needs the whole file in memory at once, which is how the identify pass
 * used to work: `arrayBuffer()` on every ROM, six at a time, on the main thread. These three let the
 * bytes be folded in as they arrive, so a ROM can be streamed (see core/crc.worker.ts) instead of
 * materialized, constant memory regardless of ROM size, and no multi-hundred-ms task on the UI thread.
 * The state is just the running register, so it is a plain number a caller can keep anywhere. */

/** Start a running CRC32. */
export function crcBegin() {
  return 0xffffffff;
}

/** Fold one chunk of bytes into a running CRC32 → the new state. */
export function crcUpdate(state, chunk) {
  let c = state >>> 0;
  for (let i = 0; i < chunk.length; i++) c = TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** Finish a running CRC32 → the 8-char uppercase hex string the gamedb stores. */
export function crcEnd(state) {
  return (((state >>> 0) ^ 0xffffffff) >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, '0');
}

/** Raw CRC32 over the given bytes. */
export function crc32(bytes) {
  return (crcUpdate(crcBegin(), bytes) ^ 0xffffffff) >>> 0;
}

/** True when a 512-byte copier header is present (SNES). */
export function hasCopierHeader(byteLength) {
  return byteLength % 1024 === 512;
}

/** iNES / NES 2.0 magic: "NES" + 0x1A, the start of the 16-byte header that precedes NES ROM data. */
export function hasINesHeader(bytes) {
  return bytes.length >= 16 && bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a;
}

/** Lowercased extension (no dot) of a filename, or '' when there is none. */
function extLower(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/* ---- SFROM (SNES Classic container) ----
 * The cartridge image sits INSIDE the file, so neither the whole file nor "the file minus N bytes" is
 * what the firmware loads or what the gamedb indexes: the catalog CRC is the CRC of the embedded image,
 * which is why a `.sfrom` resolves to the very same game as the plain `.sfc` dump.
 * The rule is the firmware's load_sfrom_info(), kept byte for byte:
 *   magic 0x00000100 (LE) at 0; image offset at 0x08; image size either in the footer the header
 *   points to at 0x14 (Nintendo layout, a u32 at footer+1) or, failing that, inline at 0x31 (the
 *   0x50-byte header some converters write).
 * A container that does not parse is refused by the firmware, so there is no right CRC for it; it is
 * hashed by the plain rule and simply matches nothing. */

/** How many leading bytes the SFROM rule looks at. */
export const SFROM_HEAD_BYTES = 0x50;
/** Bytes read at the footer offset: one flag byte, then the u32 image size. */
export const SFROM_FOOT_BYTES = 5;

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0;

/** True when the filename says SFROM. The container rule is gated on the name, like the firmware's. */
export function isSfromName(name) {
  return extLower(name) === 'sfrom';
}

/** Where the footer of this container has to be read from (SFROM_FOOT_BYTES at this offset), 0 when
 *  the header names none that fits in the file, and -1 when `head` is not an SFROM header at all.
 *  Split from sfromSpan so a streaming caller reads two small slices instead of the whole file. */
export function sfromFooterOffset(head, byteLength) {
  if (head.length < 0x30 || le32(head, 0) !== 0x00000100) return -1;
  const footer = le32(head, 0x14);
  return footer && footer + SFROM_FOOT_BYTES <= byteLength ? footer : 0;
}

/** The embedded image as `{ off, len }`, or null when the container is not valid. `head` is the first
 *  SFROM_HEAD_BYTES of the file (fewer if the file is shorter), `foot` the SFROM_FOOT_BYTES at
 *  sfromFooterOffset() (null/empty when that returned 0). */
export function sfromSpan(head, foot, byteLength) {
  if (head.length < 0x30 || le32(head, 0) !== 0x00000100) return null;
  const declared = le32(head, 4);
  const off = le32(head, 8);
  if (off >= byteLength) return null;
  if (declared && declared > byteLength) return null;
  let len = 0;
  if (foot && foot.length >= SFROM_FOOT_BYTES) len = le32(foot, 1);
  if (!len && head.length >= 0x35) len = le32(head, 0x31);
  if (!len || off + len > byteLength) return null;
  return { off, len };
}

/** sfromSpan() for a file that is already in memory. */
function sfromSpanOfBytes(bytes) {
  const fo = sfromFooterOffset(bytes, bytes.length);
  if (fo < 0) return null;
  return sfromSpan(bytes.subarray(0, SFROM_HEAD_BYTES), fo ? bytes.subarray(fo, fo + SFROM_FOOT_BYTES) : null, bytes.length);
}

/** The bytes of `file` that are hashed and that the firmware loads, as `{ off, len }`, for any ROM:
 *  the image inside an `.sfrom`, else everything past headerOffset(). Reads at most two small slices,
 *  never the ROM. This is the streaming counterpart of headerlessCrc32(), and both must agree exactly,
 *  or the same ROM hashes differently depending on which path ran. */
export async function romSpan(file, name = '') {
  const size = file.size;
  const head = new Uint8Array(await file.slice(0, SFROM_HEAD_BYTES).arrayBuffer());
  if (isSfromName(name)) {
    const fo = sfromFooterOffset(head, size);
    if (fo >= 0) {
      const foot = fo ? new Uint8Array(await file.slice(fo, fo + SFROM_FOOT_BYTES).arrayBuffer()) : null;
      const span = sfromSpan(head, foot, size);
      if (span) return span;
    }
  }
  const off = headerOffset(head, size, name);
  return { off, len: size - off };
}

/** Headerless CRC32 as an 8-char uppercase hex string (the form gamedb stores). `name` is the ROM's
 * filename, its extension gates the NES path, so header-stripping is decided by what the ROM is, not
 * just by bytes that could collide.
 *
 * NES (`.nes`): the 16-byte iNES header is metadata that varies by tool/era (iNES 1.0 vs NES 2.0) and
 * changes the whole-file CRC without changing the game, so the same dump under two header formats hashes
 * to two different CRCs. The gamedb therefore indexes NES by the data CRC (file minus the 16-byte header),
 * so we strip that header, gated on the `.nes` extension and the iNES magic, so a non-NES ROM that
 * happens to start with those bytes is never mis-stripped. A truly headerless `.nes` (no magic) already
 * Is the data and is hashed whole, so both header formats and raw dumps resolve to the same CRC.
 *
 * SFROM (`.sfrom`): the image embedded in the container (see the SFROM block above).
 *
 * SNES: strip the 512-byte copier header (No-Intro checksums are computed without it). */
export function headerlessCrc32(bytes, name = '') {
  if (isSfromName(name)) {
    const span = sfromSpanOfBytes(bytes);
    if (span) return crcEnd(crcUpdate(crcBegin(), bytes.subarray(span.off, span.off + span.len)));
  }
  const off = headerOffset(bytes, bytes.length, name);
  return crcEnd(crcUpdate(crcBegin(), off ? bytes.subarray(off) : bytes));
}

/** Byte offset where the hashed data starts (0 = hash the file whole), the header rule of
 *  headerlessCrc32 for everything but an `.sfrom`, factored out so a streaming caller can apply the
 *  same decision without holding the file: `head` only has to be the first 16 bytes (the iNES magic),
 *  `byteLength` the file's full size. Streaming callers want romSpan(), which also covers `.sfrom`. */
export function headerOffset(head, byteLength, name = '') {
  if (extLower(name) === 'nes' && hasINesHeader(head)) return 16;
  return hasCopierHeader(byteLength) ? 512 : 0;
}
