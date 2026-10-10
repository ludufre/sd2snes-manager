/**
 * Opus decoding for the music pack: libopus compiled to WebAssembly, driven through its plain C API.
 *
 * The module is `opus.wasm` from the `@evan/opus` package (MIT wrapper, libopus 1.3.x under the
 * BSD-3-Clause licence; both notices ship next to the file in public/opus/). It is the scalar build,
 * not `simd.wasm`: the same bits on every browser and CPU. It is staged into public/opus/ by
 * scripts/setup-opus.sh and fetched only when the dialog actually builds a pack (the main bundle never
 * contains it).
 *
 * Why this and not the other options looked at:
 *  - `opus-decoder` (wasm-audio-decoders): its libopus build disagrees with libopus 1.3.1 and 1.6.1 on
 *    rare low-bitrate CELT packets by up to ~1 % of the amplitude (the stream's range check still
 *    passes, it is a synthesis difference), and it exposes no final range.
 *  - WebCodecs `AudioDecoder`: the Opus rounding, pre-skip and state handling differ per engine, there
 *    is no final range, and a pack that sounds different per browser is not acceptable.
 *  This build matches libopus 1.6.1 (the system library the reference pack was made with) to within 1
 *  LSB on every sample of every stream, and it exposes OPUS_GET_FINAL_RANGE.
 *
 * Every packet's decoder final range is compared with the one the encoder recorded in the stream. That
 * is libopus' own end-to-end integrity test: it only matches when the decoder read exactly the bits the
 * encoder wrote, so a damaged dump (or a wrong stream table) fails loudly instead of producing noise.
 */

export interface FrameDecoder {
  /** Decode one packet to 960 interleaved stereo frames (20 ms at 48 kHz), 16-bit. `expectedRange` 0 = not recorded. */
  decode(data: Uint8Array, expectedRange: number): Int16Array;
  /** Every packet that carried a recorded range matched it (false until one has been compared). */
  readonly rangeChecked: boolean;
}

export const FRAME_SAMPLES = 960;
const OPUS_GET_FINAL_RANGE = 4031;
const MAX_PACKET = 1500;
const MAX_FRAME = 5760; // longest frame libopus may return per channel (120 ms at 48 kHz)

export class RangeMismatchError extends Error {
  constructor(public readonly packet: number, public readonly expected: number, public readonly actual: number) {
    super(`Opus final range mismatch at packet ${packet}: stream says ${hex(expected)}, decoder got ${hex(actual)}`);
    this.name = 'RangeMismatchError';
  }
}
const hex = (v: number): string => '0x' + (v >>> 0).toString(16).padStart(8, '0');

interface OpusExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  opus_decoder_get_size(channels: number): number;
  opus_decoder_init(p: number, rate: number, channels: number): number;
  opus_decoder_ctl_get(p: number, request: number): number;
  opus_decode(p: number, data: number, len: number, pcm: number, frameSize: number, fec: number): number;
  opus_strerror(code: number): number;
}

/** Compile `opus.wasm` once; every decoder instantiates its own copy (its own memory, nothing shared). */
export async function compileOpus(bytes: Uint8Array | ArrayBuffer): Promise<WebAssembly.Module> {
  return WebAssembly.compile(bytes as BufferSource);
}

/** A fresh stereo 48 kHz decoder (state starts cold, as the game's does at the start of a stream). */
export function createOpusDecoder(mod: WebAssembly.Module): FrameDecoder {
  const inst = new WebAssembly.Instance(mod, {
    wasi_snapshot_preview1: { fd_seek() { return 0; }, fd_write() { return 0; }, fd_close() { return 0; }, proc_exit() {} },
    env: { emscripten_notify_memory_growth() {} },
  });
  const w = inst.exports as unknown as OpusExports;
  const dec = w.malloc(w.opus_decoder_get_size(2));
  const rc = w.opus_decoder_init(dec, 48000, 2);
  if (rc < 0) throw new Error(`opus_decoder_init failed (${rc})`);
  const inPtr = w.malloc(MAX_PACKET);
  const outPtr = w.malloc(MAX_FRAME * 2 * 2);
  let packetNo = 0;
  let compared = 0;

  return {
    get rangeChecked() { return compared > 0; },
    decode(data, expectedRange) {
      const idx = packetNo++;
      if (data.length > MAX_PACKET) throw new Error(`packet ${idx} is ${data.length} bytes`);
      new Uint8Array(w.memory.buffer, inPtr, data.length).set(data);
      const n = w.opus_decode(dec, inPtr, data.length, outPtr, MAX_FRAME, 0);
      if (n !== FRAME_SAMPLES) throw new Error(`Opus decode failed at packet ${idx} (returned ${n})`);
      if (expectedRange) {
        const got = w.opus_decoder_ctl_get(dec, OPUS_GET_FINAL_RANGE) >>> 0;
        if (got !== expectedRange >>> 0) throw new RangeMismatchError(idx, expectedRange, got);
        compared++;
      }
      return new Int16Array(w.memory.buffer, outPtr, FRAME_SAMPLES * 2).slice();
    },
  };
}
