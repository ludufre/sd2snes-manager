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
 * SNES: strip the 512-byte copier header (No-Intro checksums are computed without it). */
export function headerlessCrc32(bytes, name = '') {
  const off = headerOffset(bytes, bytes.length, name);
  return crcEnd(crcUpdate(crcBegin(), off ? bytes.subarray(off) : bytes));
}

/** Byte offset where the hashed data starts (0 = hash the file whole), the header rule of
 *  headerlessCrc32, factored out so a streaming caller can apply the same decision without holding the
 *  file: `head` only has to be the first 16 bytes (the iNES magic), `byteLength` the file's full size.
 *  Both callers must agree exactly, or the same ROM hashes differently depending on which path ran. */
export function headerOffset(head, byteLength, name = '') {
  if (extLower(name) === 'nes' && hasINesHeader(head)) return 16;
  return hasCopierHeader(byteLength) ? 512 : 0;
}
