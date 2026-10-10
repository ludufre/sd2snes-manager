import { describe, expect, it } from 'vitest';
import { buildPcmFile, msuFileName, parsePcmFile, pcmFileName } from './msu-pcm';
import { compileOpus, createOpusDecoder, FRAME_SAMPLES, RangeMismatchError, type FrameDecoder } from './opus-wasm';
import { buildTrackBody, OUT_FRAMES_PER_PACKET } from './xc-pack';
import { Dither, HALF, kernel, resampleRange, TAPS } from './xc-resample';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { crc32 } from '../../lib/crc32.js';
import { checkDump, DUMP_CODE_BYTES, DUMP_CRC32, DUMP_SIZE, FLASH_BASE, MAX_PACKET, ONCE_TRACKS, parseStream, STREAM_BASES, TRACK_COUNT } from './xc-streams';

/* ----- synthetic dumps: invented packet framing, never game data ----- */

interface SynthPacket { length: number; range: number }

function putPacket(d: Uint8Array, at: number, p: SynthPacket, fill = 0x5a): number {
  const dv = new DataView(d.buffer);
  dv.setUint32(at, p.length);
  dv.setUint32(at + 4, p.range);
  d.fill(fill, at + 8, at + 8 + p.length);
  return at + 8 + p.length;
}

/** A 16 MiB image with `streams[n-1]` written at the stream base of track n. */
function synthDump(streams: Record<number, SynthPacket[]>): Uint8Array {
  const d = new Uint8Array(DUMP_SIZE);
  for (const [n, packets] of Object.entries(streams)) {
    let a = STREAM_BASES[Number(n) - 1] - FLASH_BASE;
    for (const p of packets) a = putPacket(d, a, p);
  }
  return d;
}

const packetsOf = (count: number, length = 3): SynthPacket[] => Array.from({ length: count }, (_, i) => ({ length, range: i + 1 }));

describe('stream table', () => {
  it('has 26 ascending bases inside the flash', () => {
    expect(STREAM_BASES.length).toBe(TRACK_COUNT);
    for (let i = 0; i < TRACK_COUNT; i++) {
      expect(STREAM_BASES[i] - FLASH_BASE).toBeLessThan(DUMP_SIZE);
      if (i) expect(STREAM_BASES[i]).toBeGreaterThan(STREAM_BASES[i - 1]);
    }
    for (const t of ONCE_TRACKS) expect(t >= 1 && t <= TRACK_COUNT).toBe(true);
  });
});

describe('parseStream', () => {
  it('reads packets until the zero padding', () => {
    const d = synthDump({ 3: [{ length: 5, range: 0x11 }, { length: 0, range: 0x22 }, { length: 7, range: 0x33 }] });
    const pk = parseStream(d, 3);
    expect(pk.map((p) => [p.length, p.range])).toEqual([[5, 0x11], [0, 0x22], [7, 0x33]]);
    expect(pk[0].data.length).toBe(5);
    expect(pk[2].data.length).toBe(7);
  });

  it('keeps a skipped slot (length 0, range set) but stops at length 0 with range 0', () => {
    const d = synthDump({ 1: [{ length: 4, range: 1 }, { length: 0, range: 9 }, { length: 4, range: 2 }, { length: 0, range: 0 }, { length: 4, range: 3 }] });
    expect(parseStream(d, 1).length).toBe(3);
  });

  it('stops at an impossible length', () => {
    const d = synthDump({ 2: [{ length: 4, range: 1 }, { length: MAX_PACKET + 1, range: 1 }] });
    expect(parseStream(d, 2).length).toBe(1);
    const ok = synthDump({ 2: [{ length: MAX_PACKET, range: 1 }] });
    expect(parseStream(ok, 2)[0].length).toBe(MAX_PACKET);
  });

  it('never runs into the next stream', () => {
    // stream 18 is 0x950 bytes before stream 19: packets that do not stop would cross into it
    const gap = STREAM_BASES[18] - STREAM_BASES[17];
    const d = new Uint8Array(DUMP_SIZE);
    let a = STREAM_BASES[17] - FLASH_BASE;
    const end = a + gap;
    while (a + 8 + 1 <= end) a = putPacket(d, a, { length: 1, range: 1 });
    expect(() => parseStream(d, 18)).not.toThrow();
    const n = parseStream(d, 18).length;
    expect(n).toBeLessThanOrEqual(Math.floor(gap / 9));
  });

  it('refuses a packet that would cross the end of its data', () => {
    const gap = STREAM_BASES[18] - STREAM_BASES[17];
    const start = STREAM_BASES[17] - FLASH_BASE;
    const d = new Uint8Array(DUMP_SIZE);
    // empty slots (8 bytes each) up to 8 bytes before the next stream, then a packet claiming 100 bytes
    let a = start;
    while (a + 8 <= start + gap - 8) a = putPacket(d, a, { length: 0, range: 1 });
    expect(a).toBe(start + gap - 8);
    const dv = new DataView(d.buffer);
    dv.setUint32(a, 100);
    dv.setUint32(a + 4, 1);
    expect(() => parseStream(d, 18)).toThrow(/runs past/);
  });

  it('rejects a track number that does not exist', () => {
    const d = new Uint8Array(DUMP_SIZE);
    expect(() => parseStream(d, 0)).toThrow(RangeError);
    expect(() => parseStream(d, 27)).toThrow(RangeError);
  });
});

describe('checkDump', () => {
  const hex = (n: number): string => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

  it('pins the v1.00 value and the size of the checked span', () => {
    expect(DUMP_CRC32).toBe('B4C799CC');
    expect(DUMP_CODE_BYTES).toBe(0xff8000);
    expect(DUMP_SIZE - DUMP_CODE_BYTES).toBe(32 * 1024);
  });

  it('refuses the wrong size', () => {
    expect(checkDump(new Uint8Array(1024))).toEqual({ ok: false, reason: 'size', actual: 1024 });
    expect(checkDump(new Uint8Array(DUMP_SIZE + 1))).toEqual({ ok: false, reason: 'size', actual: DUMP_SIZE + 1 });
  });

  it('refuses a 16 MiB image whose CRC is not the release value', () => {
    expect(checkDump(new Uint8Array(DUMP_SIZE))).toEqual({ ok: false, reason: 'crc' });
  });

  it('checks only the bytes before the save area', () => {
    const d = new Uint8Array(DUMP_SIZE);
    for (let i = 0; i < DUMP_CODE_BYTES; i += 7) d[i] = (i * 2654435761) >>> 24;
    const want = hex(crc32(d.subarray(0, DUMP_CODE_BYTES)));
    expect(checkDump(d, want)).toEqual({ ok: true });
    // the save area differs per player: any change there still passes
    for (let i = DUMP_CODE_BYTES; i < DUMP_SIZE; i += 13) d[i] ^= 0x5a;
    d[DUMP_SIZE - 1] ^= 0xff;
    expect(checkDump(d, want)).toEqual({ ok: true });
    // one flipped bit before it does not
    d[DUMP_CODE_BYTES - 1] ^= 1;
    expect(checkDump(d, want)).toEqual({ ok: false, reason: 'crc' });
    d[DUMP_CODE_BYTES - 1] ^= 1;
    d[0] ^= 1;
    expect(checkDump(d, want)).toEqual({ ok: false, reason: 'crc' });
  });
});

/* ----- MSU-1 files ----- */

describe('MSU-1 pcm file', () => {
  it('writes MSU1, a little-endian loop point and little-endian samples', () => {
    const f = buildPcmFile(Int16Array.of(1, -2, 0x1234, -32768), 0x01020304);
    expect(Array.from(f.subarray(0, 8))).toEqual([0x4d, 0x53, 0x55, 0x31, 4, 3, 2, 1]);
    expect(Array.from(f.subarray(8))).toEqual([1, 0, 0xfe, 0xff, 0x34, 0x12, 0x00, 0x80]);
  });

  it('defaults to loop point 0 and round-trips', () => {
    const s = Int16Array.from({ length: 2000 }, (_, i) => ((i * 7919) % 65536) - 32768);
    const back = parsePcmFile(buildPcmFile(s));
    expect(back.loopPoint).toBe(0);
    expect(Array.from(back.samples)).toEqual(Array.from(s));
  });

  it('does not touch its input and handles an empty track', () => {
    const s = Int16Array.of(5, 6);
    buildPcmFile(s);
    expect(Array.from(s)).toEqual([5, 6]);
    expect(buildPcmFile(new Int16Array(0)).length).toBe(8);
  });

  it('rejects an odd sample count, a bad loop point and a foreign file', () => {
    expect(() => buildPcmFile(new Int16Array(3))).toThrow(RangeError);
    expect(() => buildPcmFile(new Int16Array(2), -1)).toThrow(RangeError);
    expect(() => buildPcmFile(new Int16Array(2), 2 ** 32)).toThrow(RangeError);
    expect(() => parsePcmFile(new Uint8Array(12))).toThrow();
  });

  it('names the files after the ROM stem', () => {
    expect(msuFileName('Xeno Crisis')).toBe('Xeno Crisis.msu');
    expect(pcmFileName('Xeno Crisis', 26)).toBe('Xeno Crisis-26.pcm');
  });
});

/* ----- resampler ----- */

const sine = (frames: number, freq: number, amp: number, rate = 48000, phase = 0): Int16Array => {
  const s = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    s[i * 2] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate + phase));
    s[i * 2 + 1] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate + phase + 1));
  }
  return s;
};

describe('resampler', () => {
  it('has unity gain at DC in every phase and a symmetric prototype', () => {
    const k = kernel();
    expect(k.length).toBe(147 * TAPS);
    for (let ph = 0; ph < 147; ph++) {
      let sum = 0;
      for (let m = 0; m < TAPS; m++) sum += k[ph * TAPS + m];
      expect(sum).toBeCloseTo(1, 12);
    }
    // phase 0 is centred on tap HALF - 1: mirror taps carry the same weight
    for (let j = 1; j < HALF - 1; j++) expect(k[HALF - 1 - j]).toBeCloseTo(k[HALF - 1 + j], 12);
  });

  it('turns n frames at 48 kHz into n x 147/160 frames', () => {
    const src = sine(1600, 1000, 8000);
    const out = resampleRange(src, 0, 0, 1470, new Dither(1));
    expect(out.length).toBe(1470 * 2);
  });

  it('keeps a 1 kHz tone: right frequency, level and phase', () => {
    const frames = 4800;
    const src = sine(frames, 1000, 12000);
    const n = 4410;
    const out = resampleRange(src, 0, 0, n, new Dither(7));
    let worst = 0;
    // skip the edges, where the signal starts from silence
    for (let k = 100; k < n - 100; k++) {
      const t = k / 44100;
      const l = 12000 * Math.sin(2 * Math.PI * 1000 * t);
      const r = 12000 * Math.sin(2 * Math.PI * 1000 * t + 1);
      worst = Math.max(worst, Math.abs(out[k * 2] - l), Math.abs(out[k * 2 + 1] - r));
    }
    expect(worst).toBeLessThanOrEqual(3); // rounding + triangular dither only
  });

  it('passes 20 kHz and removes what 44.1 kHz cannot hold', () => {
    const rms = (a: Int16Array, from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i++) s += a[i * 2] * a[i * 2];
      return Math.sqrt(s / (to - from));
    };
    const pass = resampleRange(sine(9600, 20000, 10000), 0, 0, 8820, new Dither(3));
    expect(rms(pass, 500, 8000) / (10000 / Math.SQRT2)).toBeGreaterThan(0.97);
    const stop = resampleRange(sine(9600, 23500, 10000), 0, 0, 8820, new Dither(3));
    expect(rms(stop, 500, 8000)).toBeLessThan(10); // > 60 dB down (the dither floor is ~1 LSB)
  });

  it('is deterministic, and a range equals the same part of the whole', () => {
    const src = sine(9600, 440, 9000);
    const whole = resampleRange(src, 0, 0, 8820, new Dither(5));
    const again = resampleRange(src, 0, 0, 8820, new Dither(5));
    expect(Array.from(again)).toEqual(Array.from(whole));
    // origin shifts the source: output k is centred on origin + k x 160/147
    const part = resampleRange(src.subarray(2 * 480), 0, 0, 400, new Dither(5));
    const shifted = resampleRange(src, 480, 0, 400, new Dither(5));
    // identical positions, identical dither stream: same numbers (a 480-frame shift is 3 x 160)
    // (the first outputs differ: `part` sees silence before its first frame, `shifted` sees the real signal)
    expect(Array.from(shifted.subarray(200))).toEqual(Array.from(part.subarray(200)));
    // and firstOut moves the window the same way as slicing outputs (dither aside, stay within 2 LSB)
    const tail = resampleRange(src, 0, 4410, 100, new Dither(9));
    for (let i = 0; i < 200; i++) expect(Math.abs(tail[i] - whole[4410 * 2 + i])).toBeLessThanOrEqual(3);
  });

  it('never clips past 16 bits', () => {
    const src = new Int16Array(4000).fill(32767);
    const out = resampleRange(src, 0, 0, 1500, new Dither(2));
    for (const v of out) { expect(v).toBeLessThanOrEqual(32767); expect(v).toBeGreaterThanOrEqual(-32768); }
  });
});

/* ----- decoder (the real libopus wasm), fed by the wasm's own encoder: no game data needed ----- */

interface OpusEncExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  opus_encoder_get_size(c: number): number;
  opus_encoder_init(p: number, rate: number, c: number, app: number): number;
  opus_encode(p: number, pcm: number, frame: number, out: number, max: number): number;
  opus_encoder_ctl_get(p: number, req: number): number;
}

const nodeFs = async (): Promise<{ readFileSync(p: string): Uint8Array }> => { const m = 'node:fs'; return import(/* @vite-ignore */ m); };

async function loadWasm(): Promise<WebAssembly.Module | null> {
  try {
    const { readFileSync } = await nodeFs();
    return await compileOpus(readFileSync('node_modules/@evan/opus/wasm/opus.wasm'));
  } catch {
    return null;
  }
}

/** Encode `frames` 20 ms stereo frames of a chirp with libopus itself; returns packets + the encoder's final range. */
function encodeSynthetic(mod: WebAssembly.Module, frames: number): { data: Uint8Array; range: number }[] {
  const inst = new WebAssembly.Instance(mod, {
    wasi_snapshot_preview1: { fd_seek() { return 0; }, fd_write() { return 0; }, fd_close() { return 0; }, proc_exit() {} },
    env: { emscripten_notify_memory_growth() {} },
  });
  const w = inst.exports as unknown as OpusEncExports;
  const enc = w.malloc(w.opus_encoder_get_size(2));
  expect(w.opus_encoder_init(enc, 48000, 2, 2049)).toBe(0);
  const pcmPtr = w.malloc(960 * 4);
  const outPtr = w.malloc(1500);
  const out: { data: Uint8Array; range: number }[] = [];
  for (let f = 0; f < frames; f++) {
    const pcm = new Int16Array(w.memory.buffer, pcmPtr, 1920);
    for (let i = 0; i < 960; i++) {
      const t = (f * 960 + i) / 48000;
      pcm[i * 2] = Math.round(9000 * Math.sin(2 * Math.PI * (300 + 200 * t) * t));
      pcm[i * 2 + 1] = Math.round(7000 * Math.sin(2 * Math.PI * 523 * t));
    }
    const n = w.opus_encode(enc, pcmPtr, 960, outPtr, 1500);
    expect(n).toBeGreaterThan(0);
    out.push({ data: new Uint8Array(w.memory.buffer, outPtr, n).slice(), range: w.opus_encoder_ctl_get(enc, 4031) >>> 0 });
  }
  return out;
}

describe('Opus decoder', async () => {
  const mod = await loadWasm();
  const run = mod ? it : it.skip;

  run('decodes 20 ms frames and agrees with the encoder\'s final range', () => {
    const pk = encodeSynthetic(mod!, 40);
    const dec = createOpusDecoder(mod!);
    let energy = 0;
    for (const p of pk) {
      const f = dec.decode(p.data, p.range);
      expect(f.length).toBe(FRAME_SAMPLES * 2);
      for (const v of f) energy += v * v;
    }
    expect(dec.rangeChecked).toBe(true);
    expect(Math.sqrt(energy / (40 * FRAME_SAMPLES * 2))).toBeGreaterThan(1000); // real audio came out
  });

  run('fails loudly when a packet does not decode to the recorded range', () => {
    const pk = encodeSynthetic(mod!, 10);
    const dec = createOpusDecoder(mod!);
    for (let i = 0; i < 4; i++) dec.decode(pk[i].data, pk[i].range);
    expect(() => dec.decode(pk[4].data, pk[4].range ^ 0x100)).toThrow(RangeMismatchError);
    // the wrong payload for a recorded range (a dump from another build, or a corrupted read) is caught too
    const dec2 = createOpusDecoder(mod!);
    dec2.decode(pk[0].data, pk[0].range);
    expect(() => dec2.decode(pk[7].data, pk[1].range)).toThrow(RangeMismatchError);
  });

  run('skips the check for a packet with no recorded range', () => {
    const pk = encodeSynthetic(mod!, 3);
    const dec = createOpusDecoder(mod!);
    dec.decode(pk[0].data, 0);
    expect(dec.rangeChecked).toBe(false);
  });

  run('keeps its state between calls (a fresh decoder sounds different mid-stream)', () => {
    const pk = encodeSynthetic(mod!, 6);
    const warm = createOpusDecoder(mod!);
    for (let i = 0; i < 5; i++) warm.decode(pk[i].data, 0);
    const a = warm.decode(pk[5].data, 0);
    const b = createOpusDecoder(mod!).decode(pk[5].data, 0);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(0);
  });
});

/* ----- track assembly, with a decoder that is a continuous tone ----- */

/** Packets decode to one endless 1 kHz tone: the "decoder state" is the running phase, so passes continue each other. */
function toneDecoder(): FrameDecoder & { calls: number } {
  const d = {
    calls: 0,
    rangeChecked: true,
    decode(_data: Uint8Array, _range: number): Int16Array {
      const out = new Int16Array(FRAME_SAMPLES * 2);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const t = (d.calls * FRAME_SAMPLES + i) / 48000;
        out[i * 2] = Math.round(10000 * Math.sin(2 * Math.PI * 1000 * t));
        out[i * 2 + 1] = Math.round(-10000 * Math.sin(2 * Math.PI * 1000 * t));
      }
      d.calls++;
      return out;
    },
  };
  return d;
}

describe('buildTrackBody', () => {
  const PK = 30;
  const dump = synthDump({
    1: [...packetsOf(PK), { length: 0, range: 7 }, ...packetsOf(2)], // plays once, with one skipped slot
    2: packetsOf(PK), // loops
  });

  it('plays-once track: every playable packet, exactly 882 frames each, skipped slot dropped', async () => {
    const dec = toneDecoder();
    const r = await buildTrackBody(dump, 1, () => dec);
    expect(ONCE_TRACKS.has(1)).toBe(true);
    expect(r.loops).toBe(false);
    expect(r.packets).toBe(PK + 2);
    expect(dec.calls).toBe(PK + 2);
    expect(r.samples.length).toBe((PK + 2) * OUT_FRAMES_PER_PACKET * 2);
  });

  it('looping track: three decodes of every packet plus one, the middle pass kept', async () => {
    const dec = toneDecoder();
    const progress: number[] = [];
    const r = await buildTrackBody(dump, 2, () => dec, (done) => progress.push(done));
    expect(r.loops).toBe(true);
    expect(dec.calls).toBe(PK * 3 + 1);
    expect(r.samples.length).toBe(PK * OUT_FRAMES_PER_PACKET * 2);
    expect(progress[progress.length - 1]).toBe(PK * 3 + 1);
    // pass 3 is calls 2 x PK .. 3 x PK - 1: the output is that stretch of the tone, seam-free at both ends
    const t0 = (2 * PK * FRAME_SAMPLES) / 48000;
    let worst = 0;
    for (let k = 0; k < PK * OUT_FRAMES_PER_PACKET; k++) {
      const want = 10000 * Math.sin(2 * Math.PI * 1000 * (t0 + k / 44100));
      worst = Math.max(worst, Math.abs(r.samples[k * 2] - want), Math.abs(r.samples[k * 2 + 1] + want));
    }
    expect(worst).toBeLessThanOrEqual(3);
  });

  it('plays-once track starts and ends from silence (no wrap-around)', async () => {
    const r = await buildTrackBody(dump, 1, () => toneDecoder());
    // the tone starts at sine phase 0, so the first frame is ~0; a wrapped tail would not be
    expect(Math.abs(r.samples[0])).toBeLessThan(400);
  });

  it('is reproducible', async () => {
    const a = await buildTrackBody(dump, 2, () => toneDecoder());
    const b = await buildTrackBody(dump, 2, () => toneDecoder());
    expect(Array.from(b.samples)).toEqual(Array.from(a.samples));
  });

  it('refuses a stream with no audio and passes a decoder error through', async () => {
    await expect(buildTrackBody(synthDump({}), 5, () => toneDecoder())).rejects.toThrow(/no audio/);
    const boom: FrameDecoder = { rangeChecked: false, decode() { throw new RangeMismatchError(3, 1, 2); } };
    await expect(buildTrackBody(dump, 2, () => boom)).rejects.toBeInstanceOf(RangeMismatchError);
  });
});
