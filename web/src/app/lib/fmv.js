// Band-asset orchestrator: `.gcv` cover + `.gss`/`.fmv` screenshot/clip + `.pcm` audio.
//
// Frame/audio extraction runs through ffmpeg.wasm (official @ffmpeg/ffmpeg, prebuilt core
// self-hosted under public/ffmpeg/): fps + fill-crop to 96×72 rgb24, audio 44.1 kHz s16 stereo.
// The cover + frames are paletted-quantised (median-cut) and the band assets assembled by
// lib/bandpal; this file drives the ffmpeg pass + the image decode/fit.
// `.pcm`: "MSU1" + u32 loop=0 + 44.1 kHz s16 stereo LE.

import * as bandpal from './bandpal.js';
import { decodeCov } from './cov.js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

export const BOX_W_TILES = 12;
export const BOX_H_TILES = 9;
export const BOX_W = BOX_W_TILES * 8; // 96
export const BOX_H = BOX_H_TILES * 8; // 72
export const TILES_PER_FRAME = BOX_W_TILES * BOX_H_TILES; // 108
export const FRAME_BYTES = TILES_PER_FRAME * 64; // 6912
export const FRAME_RGB_BYTES = BOX_W * BOX_H * 3; // 20736
export const DEFAULT_FPS = 12;
export const MAX_FRAMES = 0xffff;
export const PCM_RATE = 44100;


/* ---------- ffmpeg.wasm (singleton, self-hosted core) ---------- */

let _ffReady = null;
let _seq = 0;

// ffmpeg.wasm is a single wasm instance with one virtual FS, concurrent exec()/file ops corrupt
// each other (encoding works one game at a time, but many at once fails). Serialize every ffmpeg
// job through one promise chain so overlapping buildFmv/buildPcm calls queue instead of racing.
let _ffLock = Promise.resolve();
/**
 * Run an ffmpeg job exclusively (queued behind any in-flight job).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
// ffmpeg.wasm's worker heap only grows (WASM memory never shrinks), so a long bulk run (hundreds of
// videos) eventually exhausts it and the next worker call (writeFile/exec/readFile, all blocking wasm
// ops on the worker's single thread) hangs forever, freezing the whole sequential job. So: recycle the
// instance every N jobs to release that memory, and hard-timeout the whole job (not just exec) so a
// wedged worker is terminated and the queue keeps moving. `_ffJobs` counts completed jobs since reload.
let _ffJobs = 0;
const FF_RECYCLE_EVERY = 8; // ≈ 4 games (fmv + pcm job each); 16 (≈8 games) still bloated the worker
                            // enough that a mid-batch job slowed into the 120s timeout. Reload is cheap
                            // (core is HTTP-cached) vs a single 120s timeout, so recycle eagerly.
const FF_JOB_TIMEOUT_MS = 120_000; // whole job (write + exec + read); 120s ⇒ the worker is wedged

/** Drop the ffmpeg instance so the next ensureFfmpeg() loads a fresh one (frees the worker's heap). */
async function terminateFfmpeg() {
  const ready = _ffReady;
  _ffReady = null;
  _ffJobs = 0;
  if (!ready) return;
  try { (await ready.catch(() => null))?.terminate?.(); } catch {  }/* already gone */
}

/** Run one ffmpeg job under a hard whole-job timeout. A hang anywhere (writeFile/exec/readFile) ⇒
 *  terminate the wedged worker so the next job reloads clean and the queue keeps moving (instead of
 *  the job promise never settling and freezing every queued game behind it). Recycles proactively. */
async function guardedJob(fn, retried = false) {
  if (_ffJobs >= FF_RECYCLE_EVERY) await terminateFfmpeg(); // free the worker heap before it wedges
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`ffmpeg job timed out after ${FF_JOB_TIMEOUT_MS}ms`), { ffTimeout: true })), FF_JOB_TIMEOUT_MS);
  });
  const job = fn();
  job.catch(() => {}); // if the job rejects after the timeout already won the race, don't leak an unhandled rejection
  try {
    const out = await Promise.race([job, timeout]);
    _ffJobs++;
    return out;
  } catch (e) {
    if (e?.ffTimeout) {
      await terminateFfmpeg(); // wedged worker, discard so the next job reloads clean
      // The same job almost always succeeds on a fresh worker (the timeout was bloat, not the video),
      // so auto-retry once here, the batch self-heals instead of leaving that game for a manual retry.
      if (!retried) { console.warn('[fmv] job timed out; recycled the worker, retrying ONCE on a fresh instance'); return guardedJob(fn, true); }
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function withFfmpeg(fn) {
  const run = _ffLock.then(() => guardedJob(fn), () => guardedJob(fn));
  _ffLock = run.then(() => {}, () => {}); // keep the chain alive regardless of this job's outcome
  return run;
}

/** Public, serialized entry points (impl below runs exclusively on the shared ffmpeg instance). */
export function buildFmv(...args) { return withFfmpeg(() => _buildFmv(...args)); } // cover-less animated screenshot
export function buildPcm(...args) { return withFfmpeg(() => _buildPcm(...args)); }

/** Standalone `.gcv` cover file (paletted 120c), no ffmpeg, decoupled from the .fmv. */
export async function buildCoverFile(coverBytes) {
  if (!coverBytes) throw new Error('no cover bytes');
  const c = await coverToRgb(coverBytes);
  return bandpal.encodeCoverFile(bandpal.encodeCover(c.rgb, c.opaque));
}
/** Derive a `.gcv` from an existing on-card `.cov`, for games with no GamesDB cover image (so the
 *  game info still gets a pixel-centered cover instead of the firmware's tile-quantised OBJ fallback).
 *  Decodes the `.cov`, crops to its opaque art (the `.cov` letterbox bars are transparent, value 0),
 *  then re-encodes through the standard `.gcv` path, which letterbox-fits + centers into 128×128. The
 *  crop is what makes the result match a GamesDB `.gcv`: it discards the `.cov`'s top-aligned padding so
 *  the centering acts on the art, not the grid. Returns the `.gcv` bytes. */
export async function buildGcvFromCov(covBytes) {
  const blob = covBytes instanceof Uint8Array ? covBytes : new Uint8Array(covBytes);
  const d = decodeCov(blob);
  const W = d.wSpr * 16, H = d.hSpr * 16;
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  const fctx = full.getContext('2d');
  const img = fctx.createImageData(W, H);
  const data = img.data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let sy = 0; sy < d.hSpr; sy++) for (let sx = 0; sx < d.wSpr; sx++) {
    let pi = d.blockmap[sy * d.wSpr + sx];
    if (pi < 0 || pi >= d.nPalettes) pi = 0;
    const pal = d.palettes[pi];
    for (let dy = 0; dy < 16; dy++) for (let dx = 0; dx < 16; dx++) {
      const cy = 2 * sy + (dy >> 3), cx = 2 * sx + (dx >> 3);
      const v = d.tiles[cy * 8 + (dy & 7)][cx * 8 + (dx & 7)];
      const X = sx * 16 + dx, Y = sy * 16 + dy;
      const p = (Y * W + X) * 4;
      if (v === 0) { data[p + 3] = 0; continue; } // transparent letterbox pixel
      const c = pal[v];
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
      if (X < minX) minX = X; if (X > maxX) maxX = X;
      if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
    }
  }
  if (maxX < 0) throw new Error('empty .cov (no opaque art)');
  fctx.putImageData(img, 0, 0);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const crop = document.createElement('canvas');
  crop.width = cw; crop.height = ch;
  crop.getContext('2d').drawImage(full, minX, minY, cw, ch, 0, 0, cw, ch);
  const pngBlob = await new Promise((res) => crop.toBlob(res, 'image/png'));
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  return buildCoverFile(pngBytes); // letterbox-fit + centered into 128×128 -> .gcv
}
/** Static screenshot as a 1-frame paletted screenshot `.gss` (88c, same format as `.fmv`), no ffmpeg. For non-video games. */
export async function buildStaticShot(shotBytes, { fps = 0, dither = false } = {}) {
  if (!shotBytes) throw new Error('no screenshot bytes');
  const rgb = await shotToRgb(shotBytes);
  return bandpal.encodeFmv([bandpal.encodeFmvFrame(rgb, dither)], fps);
}

function publicUrl(file) {
  return new URL('ffmpeg/' + file, document.baseURI).href;
}

/** Load + cache the ffmpeg.wasm engine once (≈31 MB core, cached after first load). */
export function ensureFfmpeg() {
  if (_ffReady) return _ffReady;
  const ff = new FFmpeg();
  // self-hosted: esbuild doesn't emit @ffmpeg/ffmpeg's `new URL('./worker.js', import.meta.url)`
  // worker, so point at our own copy (its ./const.js/./errors.js resolve same-origin).
  const urls = {
    classWorkerURL: publicUrl('esm/worker.js'),
    coreURL: publicUrl('ffmpeg-core.js'),
    wasmURL: publicUrl('ffmpeg-core.wasm'),
  };
  console.log('[fmv] loading ffmpeg.wasm core', urls);
  _ffReady = ff
    .load(urls)
    .then(() => {
      console.log('[fmv] ffmpeg.wasm ready');
      return ff;
    })
    .catch((e) => {
      _ffReady = null; // allow a retry on failure
      console.error('[fmv] ffmpeg.wasm failed to load', urls, e);
      throw e;
    });
  return _ffReady;
}

/* ---------- mp4 → .fmv / .pcm (ffmpeg.wasm extraction) ---------- */

/* ---------- paletted band: cover + screenshot/FMV ---------- */

/** Letterbox-fit the cover into COVER_W×COVER_H, returning { rgb, opaque } (alpha 0 margins →
 *  transparent). Uses createImageBitmap (decodes the raw bytes by content, not MIME -- an <img>
 *  on a typeless blob URL fails). */
async function coverToRgb(coverBytes) {
  const blob = new Blob([coverBytes instanceof Uint8Array ? coverBytes : new Uint8Array(coverBytes)]);
  let img;
  try { img = await createImageBitmap(blob); }
  catch (e) { throw new Error('cover image decode failed: ' + (e?.message ?? e)); }
  const cw = bandpal.COVER_W, ch = bandpal.COVER_H;
  const iw = img.width || cw, ih = img.height || ch;
  const s = Math.min(cw / iw, ch / ih), nw = Math.max(1, Math.round(iw * s)), nh = Math.max(1, Math.round(ih * s));
  // HIGH-QUALITY downscale: createImageBitmap with resizeQuality:'high' uses a proper area/Lanczos-ish
  // filter (multi-step), unlike a single-pass canvas drawImage scale -- which at 'low' quality (the
  // default) undersamples a big reduction (a ~600px box -> ~91px) and aliases ("serrilhado").
  let scaled = null;
  try { scaled = await createImageBitmap(img, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' }); }
  catch (e) { scaled = null; }
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, cw, ch);
  if (scaled) { ctx.drawImage(scaled, (cw - nw) >> 1, (ch - nh) >> 1); scaled.close?.(); }
  else { ctx.drawImage(img, (cw - nw) >> 1, (ch - nh) >> 1, nw, nh); }   /* fallback: smoothed scale */
  img.close?.();
  const d = ctx.getImageData(0, 0, cw, ch).data;
  const rgb = new Uint8Array(cw * ch * 3), opaque = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
    opaque[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  }
  return { rgb, opaque };
}

/** Fill-crop a still screenshot into the 96×72 FMV box, fully opaque (matches the ffmpeg frames'
 *  scale+crop). High-quality downscale via createImageBitmap. */
async function shotToRgb(shotBytes) {
  const blob = new Blob([shotBytes instanceof Uint8Array ? shotBytes : new Uint8Array(shotBytes)]);
  let img;
  try { img = await createImageBitmap(blob); }
  catch (e) { throw new Error('screenshot decode failed: ' + (e?.message ?? e)); }
  const cw = bandpal.BOX_W, ch = bandpal.BOX_H;
  const iw = img.width || cw, ih = img.height || ch;
  const s = Math.max(cw / iw, ch / ih), nw = Math.max(1, Math.round(iw * s)), nh = Math.max(1, Math.round(ih * s)); // cover (fill-crop)
  let scaled = null;
  try { scaled = await createImageBitmap(img, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' }); }
  catch (e) { scaled = null; }
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  if (scaled) { ctx.drawImage(scaled, (cw - nw) >> 1, (ch - nh) >> 1); scaled.close?.(); }
  else { ctx.drawImage(img, (cw - nw) >> 1, (ch - nh) >> 1, nw, nh); }
  img.close?.();
  const d = ctx.getImageData(0, 0, cw, ch).data;
  const rgb = new Uint8Array(cw * ch * 3);
  for (let i = 0; i < cw * ch; i++) { rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; }
  return rgb;
}

/** Mean channel value of one BOX_W×BOX_H rgb24 frame at byte offset `off` (a quick all-black test). */
function frameMeanLuma(raw, off) {
  let s = 0;
  for (let i = 0; i < FRAME_RGB_BYTES; i++) s += raw[off + i];
  return s / FRAME_RGB_BYTES;
}

/** Build a cover-less paletted `.fmv` (screenshot/video 88c/frame) from a video source, and a
 *  representative still for the `.gss` snapshot (middle non-black frame). Returns { fmv, snap }.
 *  ffmpeg samples to BOX_W×BOX_H rgb24; each frame is median-cut quantised by lib/bandpal. The cover
 *  is a separate .gcv (buildCoverFile). */
async function _buildFmv(src, { fps = DEFAULT_FPS, dither = false, start = 0, duration = 0, maxFrames = MAX_FRAMES, onProgress } = {}) {
  const ff = await ensureFfmpeg();
  const inName = `fmv_${_seq++}.in`;
  const outName = `fmv_${_seq++}.raw`;
  try {
    await ff.writeFile(inName, await fetchFile(src));
    const vf = `fps=${fps},scale=${BOX_W}:${BOX_H}:force_original_aspect_ratio=increase,crop=${BOX_W}:${BOX_H}`;
    const args = ['-v', 'error', '-y'];
    if (start) args.push('-ss', String(start));
    args.push('-i', inName);
    if (duration) args.push('-t', String(duration));
    args.push('-vf', vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', outName);
    await ff.exec(args);
    const raw = await ff.readFile(outName);
    const total = Math.min(maxFrames, Math.floor(raw.length / FRAME_RGB_BYTES));
    if (total < 1) throw new Error('ffmpeg produced no frames');
    const frames = [];
    for (let i = 0; i < total; i++) {
      const off = i * FRAME_RGB_BYTES;
      frames.push(bandpal.encodeFmvFrame(raw.subarray(off, off + FRAME_RGB_BYTES), dither));
      onProgress?.(i + 1, total);
      // median-cut + nearest run synchronously on the main thread; yield every few frames so the
      // browser can paint/respond instead of freezing for the whole clip.
      if ((i % 3) === 2) await new Promise((r) => setTimeout(r));
    }
    // also derive a representative still for the .gss snapshot: start at the middle frame and skip
    // all-black ones (intros/fades) by scanning forward to the next non-black frame (mean luma >= 16).
    let snapI = total >> 1;
    for (let i = snapI; i < total; i++) {
      if (frameMeanLuma(raw, i * FRAME_RGB_BYTES) >= 16) { snapI = i; break; }
    }
    const snap = bandpal.encodeFmv([bandpal.encodeFmvFrame(raw.subarray(snapI * FRAME_RGB_BYTES, (snapI + 1) * FRAME_RGB_BYTES), dither)], 0);
    return { fmv: bandpal.encodeFmv(frames, fps), snap };
  } finally {
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});
  }
}

/** Decode a video's audio → MSU-1 `.pcm` (44.1 kHz s16 stereo, loop 0), or null if no audio.
 *  `input` may be an ArrayBuffer/Uint8Array of the file, or a URL/Blob/File. */
async function _buildPcm(input, { start = 0, duration = 0 } = {}) {
  const ff = await ensureFfmpeg(); // recycle + whole-job timeout are handled by guardedJob (withFfmpeg)
  const inName = `pcm_${_seq++}.in`;
  const outName = `pcm_${_seq++}.raw`;
  try {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : await fetchFile(input);
    await ff.writeFile(inName, bytes);
    const args = ['-v', 'error', '-y'];
    if (start) args.push('-ss', String(start));
    args.push('-i', inName);
    if (duration) args.push('-t', String(duration));
    args.push('-vn', '-ar', String(PCM_RATE), '-ac', '2', '-f', 's16le', '-acodec', 'pcm_s16le', outName);
    let data;
    try {
      await ff.exec(args);
      data = await ff.readFile(outName);
    } catch (e) {
      if (e?.ffTimeout) throw e; // a wedged-worker timeout must not masquerade as "no audio"
      return null; // no audio track / undecodable
    }
    if (!data || data.length === 0) return null;
    const usable = data.length - (data.length % 4); // whole stereo frames only
    const out = new Uint8Array(8 + usable);
    out[0] = 0x4d; out[1] = 0x53; out[2] = 0x55; out[3] = 0x31; // "MSU1"; bytes 4..7 = loop point 0
    out.set(data.subarray(0, usable), 8);
    return out;
  } finally {
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});
  }
}
