/*  SNES internal header identification, kept in lockstep with the firmware's smc_id() and
 *  smc_headerscore() (_repo/src/smc.c:106-149 and :431-530).
 *
 *  savestate_inputs.yml and savestate_fixes.yml are keyed by "%04X" of romprops.header.chk
 *  (_repo/src/savestate.c:240 and :385), which is the checksum field of whichever header slot
 *  smc_id() elected when the game was loaded. Electing a different slot here writes a key the
 *  console never looks up, and nothing reports an error: the entry is simply inert. So this
 *  scores the same six slots with the same weights and the same tie-break instead of
 *  approximating it. Anything changed on the firmware side has to be mirrored here.
 */

/** Header slots the firmware probes, in its order (smc.c:41). The odd ones carry a copier header. */
const HDR_ADDR = [0xffb0, 0x101b0, 0x7fb0, 0x81b0, 0x40ffb0, 0x4101b0];

/** Slot the firmware falls back to when nothing scores: LoROM (smc.c:107, `score_idx=2`). */
const FALLBACK_SLOT = 2;

/** sizeof(snes_header_t): 0xb0..0xff of the bank (smc.h:39-70). Offsets below are from 0xb0. */
const HEADER_SIZE = 0x50;
const OFF_GAMECODE = 0x02;
const OFF_MAP = 0x25;
const OFF_CARTTYPE = 0x26;
const OFF_ROMSIZE = 0x27;
const OFF_RAMSIZE = 0x28;
const OFF_DESTCODE = 0x29;
const OFF_LICENSEE = 0x2a;
const OFF_CCHK = 0x2c;
const OFF_CHK = 0x2e;
const OFF_VECT_RESET = 0x4c;

/** Reset opcodes and their weights (smc.c:484-524). */
const RESET_INST_SCORE = new Map<number, number>([
  [0x78, 8], [0x18, 8], [0x38, 8], [0x9c, 8], [0x4c, 8], [0x5c, 8],
  [0xc2, 4], [0xe2, 4], [0xad, 4], [0xae, 4], [0xac, 4], [0xaf, 4],
  [0xa9, 4], [0xa2, 4], [0xa0, 4], [0x20, 4], [0x22, 4],
]);
/** These two are penalties, and the BS-X bytecode case softens them by 2 (smc.c:508-523). */
const RESET_INST_PENALTY = new Map<number, number>([
  [0x40, 4], [0x60, 4], [0x6b, 4], [0xcd, 4], [0xec, 4], [0xcc, 4],
  [0x00, 8], [0x02, 8], [0xdb, 8], [0x42, 8], [0xff, 8],
]);

const word = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8);

async function readBytes(file: File, offset: number, size: number): Promise<Uint8Array | null> {
  if (offset < 0 || offset + size > file.size) return null;
  return new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
}

/** One slot's score, mirroring smc_headerscore(). `chk` is null when the slot is past the file,
 *  which stands in for the firmware's short read (smc.c:447-450). */
async function scoreSlot(file: File, addr: number): Promise<{ score: number; chk: number | null }> {
  const header = await readBytes(file, addr, HEADER_SIZE);
  if (!header) return { score: 0, chk: null };

  const headerOffset = (addr & 0xfff) === 0x1b0 ? 0x200 : 0;
  const mapper = header[OFF_MAP] & ~0x10;
  const bsxmapper = header[OFF_RAMSIZE] & ~0x10;
  const resetvector = word(header, OFF_VECT_RESET);
  const destcode = header[OFF_DESTCODE];
  const chk = word(header, OFF_CHK);
  let score = 0;

  score += 2 * (header[OFF_LICENSEE] === 0x33 ? 1 : 0);
  score += 4 * (word(header, OFF_CCHK) + chk === 0xffff ? 1 : 0);
  if (header[OFF_CARTTYPE] < 0x08) score++;
  if (header[OFF_ROMSIZE] < 0x10) score++;
  if (header[OFF_RAMSIZE] < 0x08) score++;
  if (destcode < 0x0e) score++;
  // BS-X ROM type / run flags
  if (!(destcode & 0x40) && !(destcode & 0x0f)) score++;
  // BS-X bytecode instead of a 65c816 binary: the vectors are invalid by design
  let bsxAdjust = 0;
  if (header[OFF_GAMECODE] === 0x00 && header[OFF_GAMECODE + 1] === 0x01
      && header[OFF_GAMECODE + 2] === 0x00 && header[OFF_GAMECODE + 3] === 0x00) {
    score++;
    bsxAdjust = 2;
  }

  // Short-circuit on an invalid reset vector, except for BS-X bytecode
  if (!bsxAdjust && resetvector < 0x8000) return { score: 0, chk };

  const slot = addr - headerOffset;
  if (slot === 0x007fb0 && (mapper === 0x20 || bsxmapper === 0x20)) score += 2;
  if (slot === 0x00ffb0 && (mapper === 0x21 || bsxmapper === 0x21)) score += 2;
  if (slot === 0x007fb0 && mapper === 0x22) score += 2;
  if (slot === 0x40ffb0 && mapper === 0x25) score += 2;

  const fileAddr = ((slot & ~0x7fff) | (resetvector & 0x7fff)) + headerOffset;
  const resetInst = await readBytes(file, fileAddr, 1);
  if (resetInst) {
    // A read past the end leaves the firmware's reset_inst uninitialised; treat it as no match,
    // which is what an unmapped opcode scores anyway.
    score += RESET_INST_SCORE.get(resetInst[0]) ?? 0;
    const penalty = RESET_INST_PENALTY.get(resetInst[0]);
    if (penalty !== undefined) score -= penalty - bsxAdjust;
  }

  // Prefer a header in the upper area for big ROMs
  if (score && addr > 0x400000) score += 4;
  if (score < 0) score = 0;
  return { score, chk };
}

/** The checksum the firmware would key this ROM by, as four uppercase hex digits. */
export async function snesHeaderChecksum(file: File): Promise<string | null> {
  const slots = await Promise.all(HDR_ADDR.map((addr) => scoreSlot(file, addr)));

  // smc_id()'s election, verbatim: maxscore starts at 1 so a zero score never wins, and `>=`
  // means a tie goes to the LAST slot probed, not the first (smc.c:107, :134-141).
  let maxscore = 1;
  let scoreIdx = FALLBACK_SLOT;
  for (let num = 0; num < slots.length; num++) {
    if (slots[num].score >= maxscore) {
      scoreIdx = num;
      maxscore = slots[num].score;
    }
  }

  const chk = slots[scoreIdx].chk;
  // Only when the elected slot is past the end of the file, i.e. this is not a ROM we can key.
  if (chk == null) return null;
  return chk.toString(16).toUpperCase().padStart(4, '0');
}
