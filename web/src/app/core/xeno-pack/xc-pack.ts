/**
 * Xeno Crisis MSU-1 music pack: from the cartridge's RP2040 flash dump to the .pcm tracks.
 *
 * Track n is the game's music stream n (the order in which the sd2snes core asks for MSU-1 tracks).
 * The game decides whether a track repeats, so every file gets loop point 0 (the whole track, which
 * is what the game itself does when it restarts a stream).
 *
 *  - Streams the game plays once (ONCE_TRACKS): one decoder pass, resampled, exactly npackets x 882
 *    frames (20 ms at 44.1 kHz per packet).
 *  - Looping streams: the game keeps one decoder running across repeats, so the second and later
 *    plays start from the decoder state the end of the previous play left. The pack keeps the middle
 *    one of four consecutive passes through ONE decoder and resamples it with the end of the pass
 *    before and the start of the pass after as context, so the loop seam is the game's own
 *    steady-state seam rather than a cold start spliced onto a tail.
 *
 * Passes 1 and 2 only have to be *decoded* (they carry the decoder state), and of pass 4 only its first
 * packet is needed (the filter's look-ahead), so a looping track costs three decodes, not four, and
 * only one pass of resampling. The result equals resampling passes 2-4 joined and cutting
 * [seg, 2 seg), because output frame seg is centred exactly on the first frame of pass 3
 * (seg x 160/147 = npackets x 960).
 */
import { FRAME_SAMPLES, type FrameDecoder } from './opus-wasm';
import { Dither, HALF, resampleRange } from './xc-resample';
import { ONCE_TRACKS, parseStream, type OpusPacket } from './xc-streams';

/** 20 ms at 44.1 kHz. */
export const OUT_FRAMES_PER_PACKET = 882;
/** Context frames kept either side of the kept pass (the filter reads HALF - 1 behind and HALF ahead). */
const CONTEXT = HALF + 4;

export interface TrackBody {
  track: number;
  /** Interleaved stereo 16-bit, 44.1 kHz. */
  samples: Int16Array;
  /** Decoded packets (skipped slots excluded). */
  packets: number;
  loops: boolean;
  /** Packets carried a recorded final range and every one matched the decoder (a mismatch throws, so false = none to compare). */
  rangeChecked: boolean;
}

export type TrackProgress = (done: number, total: number) => void;

/** The track's own packets: skipped slots (length 0) play no samples and are dropped. */
function playable(dump: Uint8Array, n: number): OpusPacket[] {
  return parseStream(dump, n).filter((p) => p.length > 0);
}

export async function buildTrackBody(
  dump: Uint8Array,
  n: number,
  makeDecoder: () => FrameDecoder | Promise<FrameDecoder>,
  onProgress?: TrackProgress,
): Promise<TrackBody> {
  const pk = playable(dump, n);
  if (pk.length === 0) throw new Error(`stream ${n} holds no audio`);
  const loops = !ONCE_TRACKS.has(n);
  const total = loops ? pk.length * 3 + 1 : pk.length;
  let done = 0;
  const tick = (): void => { if (onProgress && (++done % 64 === 0 || done === total)) onProgress(done, total); };
  const dither = new Dither(0x9e3779b9 ^ (n * 0x01000193));
  const dec = await makeDecoder();
  if (!loops) {
    const pcm = new Int16Array(pk.length * FRAME_SAMPLES * 2);
    pk.forEach((p, i) => { pcm.set(dec.decode(p.data, p.range), i * FRAME_SAMPLES * 2); tick(); });
    const samples = resampleRange(pcm, 0, 0, pk.length * OUT_FRAMES_PER_PACKET, dither);
    return { track: n, samples, packets: pk.length, loops, rangeChecked: dec.rangeChecked };
  }

  // pass 1: state only
  for (const p of pk) { dec.decode(p.data, p.range); tick(); }
  // pass 2: state, and its last CONTEXT frames
  let tail = new Int16Array(0);
  for (let i = 0; i < pk.length; i++) {
    const f = dec.decode(pk[i].data, pk[i].range);
    if (i === pk.length - 1) tail = f.slice(f.length - CONTEXT * 2);
    tick();
  }
  // pass 3: the kept pass, laid out as [tail of 2][pass 3][head of 4]
  const body = pk.length * FRAME_SAMPLES * 2;
  const src = new Int16Array(CONTEXT * 2 + body + CONTEXT * 2);
  src.set(tail, 0);
  pk.forEach((p, i) => { src.set(dec.decode(p.data, p.range), CONTEXT * 2 + i * FRAME_SAMPLES * 2); tick(); });
  // pass 4: only the first packet
  src.set(dec.decode(pk[0].data, pk[0].range).subarray(0, CONTEXT * 2), CONTEXT * 2 + body);
  tick();

  const samples = resampleRange(src, CONTEXT, 0, pk.length * OUT_FRAMES_PER_PACKET, dither);
  return { track: n, samples, packets: pk.length, loops, rangeChecked: dec.rangeChecked };
}
