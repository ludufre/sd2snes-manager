/**
 * Local validation of the whole pipeline against a reference pack, on a REAL dump. The dump is the
 * owner's own game data and is never part of this repository, so this suite is skipped unless both
 * paths are given:
 *
 *   XC_DUMP=/path/xenocrisis_rp2040.bin XC_REF=/path/to/reference-pack-dir XC_STEM=xenocrisis \
 *     pnpm test -- --include '**\/xeno-pack.validate.spec.ts'
 *
 * The reference pack was built with an independent toolchain (libopus via the system library, ffmpeg's
 * resampler), so the comparison is per track: the sample count must match exactly (it is a property
 * of the algorithm, not of the resampler), and the signal must agree to within the noise of two
 * different 16-bit resamplers (each adds its own rounding/dither noise).
 *
 * With XC_OUT48 as well (a directory of `stream-<n>.raw`: the same streams decoded by the system
 * libopus to 48 kHz stereo s16le, one pass) two more checks separate the two stages: the Opus
 * decoder alone against that output, and, on the tracks played once, our resampler alone fed with
 * that output against the reference pack.
 */
import { describe, expect, it } from 'vitest';
import { parsePcmFile, buildPcmFile } from './msu-pcm';
import { compileOpus, createOpusDecoder } from './opus-wasm';
import { buildTrackBody, OUT_FRAMES_PER_PACKET } from './xc-pack';
import { Dither, resampleRange } from './xc-resample';
import { checkDump, ONCE_TRACKS, parseStream, TRACK_COUNT } from './xc-streams';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DUMP = env['XC_DUMP'];
const REF = env['XC_REF'];
const STEM = env['XC_STEM'] ?? 'xenocrisis';
const OUT48 = env['XC_OUT48'];
const MIN_SNR_DB = Number(env['XC_MIN_SNR'] ?? 60);

/** No @types/node in this project: load the two builtins through a variable specifier. */
const WASM = env['XC_WASM'] ?? 'node_modules/@evan/opus/wasm/opus.wasm';
const nodeFs = async (): Promise<{ readFileSync(p: string): Uint8Array }> => { const m = 'node:fs'; return import(/* @vite-ignore */ m); };
const join = (a: string, b: string): string => a.replace(/\/$/, '') + '/' + b;

const snrDb = (a: Int16Array, b: Int16Array): number => {
  let sig = 0, err = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; err += d * d; sig += b[i] * b[i]; }
  return err === 0 ? Infinity : 10 * Math.log10(sig / err);
};
const read16 = (readFileSync: (p: string) => Uint8Array, path: string): Int16Array => {
  const b = readFileSync(path);
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

describe.skipIf(!DUMP || !REF)('Xeno Crisis pack vs reference (real dump)', () => {
  it('rebuilds all 26 tracks', async () => {
    const { readFileSync } = await nodeFs();
    const dump = new Uint8Array(readFileSync(DUMP!));
    const mod = await compileOpus(readFileSync(WASM));
    expect(checkDump(dump)).toEqual({ ok: true });
    const rows: string[] = ['track  kind  packets  samples  match   maxdiff   SNR dB   range'];
    let worst = Infinity;
    for (let n = 1; n <= TRACK_COUNT; n++) {
      const body = await buildTrackBody(dump, n, () => createOpusDecoder(mod));
      const ref = parsePcmFile(new Uint8Array(readFileSync(join(REF!, `${STEM}-${n}.pcm`))));
      expect(ref.loopPoint).toBe(0);
      const same = body.samples.length === ref.samples.length;
      let maxd = 0, sig = 0, err = 0;
      if (same) {
        for (let i = 0; i < ref.samples.length; i++) {
          const d = body.samples[i] - ref.samples[i];
          if (Math.abs(d) > maxd) maxd = Math.abs(d);
          err += d * d;
          sig += ref.samples[i] * ref.samples[i];
        }
      }
      const snr = same ? (err === 0 ? Infinity : 10 * Math.log10(sig / err)) : -Infinity;
      worst = Math.min(worst, snr);
      rows.push(
        `${String(n).padStart(5)}  ${body.loops ? 'loop' : 'once'}  ${String(body.packets).padStart(7)}  ${String(body.samples.length / 2).padStart(7)}  ` +
        `${same ? 'yes  ' : 'NO   '}  ${String(maxd).padStart(7)}  ${snr.toFixed(1).padStart(7)}   ${body.rangeChecked ? 'checked' : 'UNCHECKED'}`,
      );
      expect(same, `track ${n} length`).toBe(true);
      expect(body.rangeChecked, `track ${n} final range`).toBe(true);
      expect(buildPcmFile(body.samples).length).toBe(8 + ref.samples.length * 2);
    }
    console.log('\n' + rows.join('\n') + `\nworst SNR ${worst.toFixed(1)} dB`);
    expect(worst).toBeGreaterThan(Number(env["XC_MIN_PACK_SNR"] ?? 40));
  }, 900_000);

  it.skipIf(!OUT48)('separates the decoder from the resampler', async () => {
    const { readFileSync } = await nodeFs();
    const dump = new Uint8Array(readFileSync(DUMP!));
    const mod = await compileOpus(readFileSync(WASM));
    const rows: string[] = ['track  decoder-only SNR dB   max |diff|   resampler-only SNR dB (once tracks)'];
    let worstResampler = Infinity;
    for (let n = 1; n <= TRACK_COUNT; n++) {
      const raw = read16(readFileSync, join(OUT48!, `stream-${n}.raw`));
      const pk = parseStream(dump, n).filter((p) => p.length > 0);
      const dec = createOpusDecoder(mod);
      const ours = new Int16Array(raw.length);
      pk.forEach((p, i) => ours.set(dec.decode(p.data, p.range), i * 1920));
      let maxd = 0;
      for (let i = 0; i < raw.length; i++) maxd = Math.max(maxd, Math.abs(ours[i] - raw[i]));
      let res = '';
      if (ONCE_TRACKS.has(n)) {
        // the reference decoder's samples through OUR resampler vs the reference pack
        const ref = parsePcmFile(new Uint8Array(readFileSync(join(REF!, `${STEM}-${n}.pcm`)))).samples;
        const mine = resampleRange(raw, 0, 0, pk.length * OUT_FRAMES_PER_PACKET, new Dither(1234 + n));
        const v = snrDb(mine, ref);
        worstResampler = Math.min(worstResampler, v);
        res = v.toFixed(1);
      }
      rows.push(`${String(n).padStart(5)}  ${snrDb(ours, raw).toFixed(1).padStart(18)}   ${String(maxd).padStart(10)}   ${res.padStart(8)}`);
    }
    console.log('\n' + rows.join('\n') + `\nworst resampler-only SNR ${worstResampler.toFixed(1)} dB`);
    expect(worstResampler).toBeGreaterThan(MIN_SNR_DB);
  }, 900_000);
});
