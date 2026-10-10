/**
 * MSU-1 audio track files.
 *
 * `<rom stem>-<n>.pcm` = ASCII "MSU1", a 32-bit little-endian loop point (in sample frames from the
 * start of the audio), then 16-bit signed little-endian stereo samples at 44.1 kHz. `<rom stem>.msu`
 * is the data file the cartridge looks for; the game reads no MSU-1 data from it, so it is empty.
 */

export const PCM_MAGIC = 'MSU1';
export const PCM_HEADER_BYTES = 8;

export const pcmFileName = (stem: string, track: number): string => `${stem}-${track}.pcm`;
export const msuFileName = (stem: string): string => `${stem}.msu`;

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Header + samples. `samples` is interleaved L/R 16-bit; the input is not modified. */
export function buildPcmFile(samples: Int16Array, loopPoint = 0): Uint8Array {
  if (!Number.isInteger(loopPoint) || loopPoint < 0 || loopPoint > 0xffffffff) throw new RangeError('bad loop point');
  if (samples.length % 2) throw new RangeError('stereo samples come in pairs');
  const out = new Uint8Array(PCM_HEADER_BYTES + samples.length * 2);
  for (let i = 0; i < 4; i++) out[i] = PCM_MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, loopPoint, true);
  if (LITTLE_ENDIAN_HOST) {
    out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), PCM_HEADER_BYTES);
  } else {
    const dv = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) dv.setInt16(PCM_HEADER_BYTES + i * 2, samples[i], true);
  }
  return out;
}

/** The samples of a `.pcm` file (the inverse of buildPcmFile); throws when the header is wrong. */
export function parsePcmFile(file: Uint8Array): { loopPoint: number; samples: Int16Array } {
  if (file.length < PCM_HEADER_BYTES || String.fromCharCode(file[0], file[1], file[2], file[3]) !== PCM_MAGIC) {
    throw new Error('not an MSU-1 pcm file');
  }
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const n = (file.length - PCM_HEADER_BYTES) >> 1;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getInt16(PCM_HEADER_BYTES + i * 2, true);
  return { loopPoint: dv.getUint32(4, true), samples };
}
