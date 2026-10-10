// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { crc32 } from '../../lib/crc32.js';

/**
 * A store-only ZIP writer for the pack. 16-bit PCM barely compresses, so the files are stored as they
 * are (no deflate pass over a few hundred MB), and the output is a list of chunks that goes straight
 * into `new Blob(chunks)`: the browser never needs one 234 MB buffer, and the track bytes are not copied
 * (each file's data is its own chunk, between its small header and the next).
 *
 * Plain ZIP, no ZIP64: every file here is a few tens of MB and the whole archive is far below 4 GB.
 * Names are written as UTF-8 (general purpose flag bit 11), which is what a ROM name with accents needs.
 */
export class PackZip {
  private readonly parts: Uint8Array[] = [];
  private readonly central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  private done = false;
  private readonly dosTime: number;
  private readonly dosDate: number;

  constructor(now: Date = new Date()) {
    this.dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    this.dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }

  add(name: string, data: Uint8Array): void {
    if (this.done) throw new Error('zip already finished');
    const nameBytes = new TextEncoder().encode(name);
    if (!nameBytes.length || nameBytes.length > 0xffff) throw new RangeError('bad zip entry name');
    if (data.length > 0xfffffffe || this.offset > 0xfffffffe || this.count >= 0xfffe) throw new RangeError('archive too large for plain ZIP');
    const crc = crc32(data) >>> 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, this.dosTime, true);
    lv.setUint16(12, this.dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, this.dosTime, true);
    cv.setUint16(14, this.dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, this.offset, true); // local header offset
    cd.set(nameBytes, 46);

    this.parts.push(local, data);
    this.central.push(cd);
    this.offset += local.length + data.length;
    this.count++;
  }

  /** Close the archive and return its chunks (stable: calling again returns the same list). */
  finish(): Uint8Array[] {
    if (!this.done) {
      const cdSize = this.central.reduce((n, c) => n + c.length, 0);
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, this.count, true);
      ev.setUint16(10, this.count, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, this.offset, true);
      this.parts.push(...this.central, end);
      this.done = true;
    }
    return this.parts;
  }
}
