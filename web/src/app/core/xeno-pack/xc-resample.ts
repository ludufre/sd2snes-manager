/**
 * 48 kHz -> 44.1 kHz stereo sample-rate conversion, the one the MSU-1 pack needs.
 *
 * A polyphase windowed-sinc FIR: 44100/48000 = 147/160 exactly, so the converter is a bank of 147
 * fixed filters (one per fractional position) and never interpolates between coefficients. The
 * prototype is the one the reference pack was built with (ffmpeg's swresample defaults at
 * filter_size 64, cutoff 0.97): a Kaiser-windowed sinc with beta 9, cut at 97 % of the output
 * Nyquist, ceil(64 / 0.97 * 48/44.1) = 72 taps, every phase normalised to unity gain at DC. That keeps
 * the pass-band flat to ~21.4 kHz and the stop band around -90 dB, well under the 16-bit noise floor.
 *
 * Output is rounded to 16 bits with triangular (TPDF) dither from a fixed-seed PRNG, so the same input
 * always gives byte-identical output (a retry or a second run reproduces the pack exactly).
 */

export const IN_RATE = 48000;
export const OUT_RATE = 44100;
/** 160 input frames in -> 147 output frames out (both rates divided by 300). */
const STEP_NUM = 160;
const PHASES = 147;
export const TAPS = 72;
/** Frames of context the filter reads on each side of the position it computes. */
export const HALF = TAPS / 2;
const CUTOFF = 0.97;
const KAISER_BETA = 9;

/** Modified Bessel function of the first kind, order 0 (power series; converges fast for |x| <= 9). */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

let kernelCache: Float64Array | null = null;

/** coef[phase * TAPS + m]: weight of input frame (i0 - HALF + 1 + m) for an output centred on i0 + phase/147. */
export function kernel(): Float64Array {
  if (kernelCache) return kernelCache;
  const factor = (CUTOFF * OUT_RATE) / IN_RATE;
  const norm = bessel0(KAISER_BETA);
  const k = new Float64Array(PHASES * TAPS);
  for (let ph = 0; ph < PHASES; ph++) {
    const frac = ph / PHASES;
    let sum = 0;
    for (let m = 0; m < TAPS; m++) {
      const d = m - (HALF - 1) - frac; // distance (input frames) from the output centre
      const r = d / HALF;
      const w = Math.abs(r) >= 1 ? 0 : bessel0(KAISER_BETA * Math.sqrt(1 - r * r)) / norm;
      const v = factor * sinc(factor * d) * w;
      k[ph * TAPS + m] = v;
      sum += v;
    }
    for (let m = 0; m < TAPS; m++) k[ph * TAPS + m] /= sum;
  }
  kernelCache = k;
  return k;
}

/** xorshift32 -> TPDF dither in (-1, 1) LSB. Deterministic for a given seed. */
export class Dither {
  private s: number;
  constructor(seed: number) { this.s = (seed | 0) || 0x2545f491; }
  private next(): number {
    let x = this.s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.s = x | 0;
    return (x >>> 0) / 4294967296;
  }
  tpdf(): number { return this.next() + this.next() - 1; }
}

/**
 * Resample a range of output frames.
 *
 * `src` is interleaved stereo 16-bit; frames outside it read as silence. Output frame k (k = firstOut
 * .. firstOut + count - 1) is centred on source frame `origin + k * 160/147`. Returns interleaved
 * stereo 16-bit, `count` frames.
 */
export function resampleRange(src: Int16Array, origin: number, firstOut: number, count: number, dither: Dither): Int16Array {
  const coef = kernel();
  const out = new Int16Array(count * 2);
  const frames = src.length >> 1;
  const pn = firstOut * STEP_NUM;
  let i0 = origin + Math.floor(pn / PHASES);
  let ph = pn % PHASES;
  for (let k = 0; k < count; k++) {
    const base = ph * TAPS;
    const first = i0 - (HALF - 1); // frame read by tap 0
    let l = 0;
    let r = 0;
    if (first >= 0 && first + TAPS <= frames) {
      let s = first * 2;
      for (let m = 0; m < TAPS; m++, s += 2) {
        const c = coef[base + m];
        l += c * src[s];
        r += c * src[s + 1];
      }
    } else {
      for (let m = 0; m < TAPS; m++) {
        const f = first + m;
        if (f < 0 || f >= frames) continue;
        const c = coef[base + m];
        l += c * src[f * 2];
        r += c * src[f * 2 + 1];
      }
    }
    out[k * 2] = to16(l + dither.tpdf());
    out[k * 2 + 1] = to16(r + dither.tpdf());
    ph += STEP_NUM - PHASES; // 13
    i0 += 1;
    if (ph >= PHASES) { ph -= PHASES; i0++; }
  }
  return out;
}

function to16(v: number): number {
  const r = Math.round(v);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}
