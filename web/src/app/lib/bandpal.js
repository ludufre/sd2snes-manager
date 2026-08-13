// Paletted game-info band encoder, the "band toda paletada" path, decoupled.
//
// The pre-boot info screen's top band (256x128, mode-3 BG1 8bpp) is rendered paletted
// (not DirectColor): one shared CGRAM holds text 0..47, the cover 48..167 (120 colours,
// static) and the screenshot/FMV 168..255 (88 colours, per-frame). Cover-favoured split.
// So the cover gets a smooth single-palette look (no .cov per-block seams) and the
// screenshot/FMV gets a real palette (no 3-3-2 cast, no per-tile checkerboard, no crawl).
//
// Two separate files now (cover decoupled so it survives "FMV off"):
//
// `.gcv` cover file (LE):
//   0 2 magic "GC" · 2 1 version=1 · 3 1 flags · 4 1 cover_w_tiles · 5 1 cover_h_tiles
//   6 1 ncolors(=120) · 7 1 reserved
//   8        ncolors*2            cover palette (BGR555 LE) -> CGRAM 48..
//   8+240    cover_w*cover_h*64   cover tiles (8bpp; value = 48+idx if opaque, else 0)
//
// `.fmv` layout (LE), cover-less, 1+ frames (1 = static screenshot):
//   0 2 magic "fv" · 2 1 version=1 · 3 1 flags · 4 1 box_w_tiles(12) · 5 1 box_h_tiles(9)
//   6 1 fmv_ncolors(=88) · 7 1 fps · 8 2 num_frames(u16) · 10 6 reserved
//   16  per frame (num_frames x):
//        fmv_ncolors*2            frame palette (BGR555 LE) -> CGRAM 168..
//        box_w*box_h*64           frame tiles (8bpp; value = 168+idx, fully opaque)

export const FMV_MAGIC0 = 0x46; // 'F'
export const FMV_MAGIC1 = 0x56; // 'V'
export const FMV_VERSION = 1;   // cover-less (the cover is a standalone .gcv); 1+ frames
export const BOX_W_TILES = 12, BOX_H_TILES = 9;
export const BOX_W = BOX_W_TILES * 8, BOX_H = BOX_H_TILES * 8; // 96x72
export const COVER_W_TILES = 16, COVER_H_TILES = 16;           // 128x128 = 256 tiles (fills window-0 exactly; 17 wide overflowed into the BG2 font at $4000)
export const COVER_W = COVER_W_TILES * 8, COVER_H = COVER_H_TILES * 8;
export const COVER_NCOLORS = 120, FMV_NCOLORS = 88;           // cover-favoured split (120 + 88 + text 48 = 256)
export const COVER_CGBASE = 48, FMV_CGBASE = 168;             // cover CGRAM 48..167, FMV/screenshot 168..255
export const HEADER_SIZE = 16;
// standalone .gcv cover file (paletted 120c, decoupled from the .fmv so it survives FMV-off)
export const GCV_MAGIC0 = 0x47, GCV_MAGIC1 = 0x43; // 'G','C'
export const GCV_VERSION = 1, GCV_HEADER_SIZE = 8;

/* ---------- BGR555 ---------- */
export const snap5 = (v) => { const q = Math.round(Math.max(0, Math.min(255, v)) / 255 * 31); return (q << 3) | (q >> 2); };
export const rgbToBGR555 = (r, g, b) =>
  ((Math.round(b / 255 * 31) & 31) << 10) | ((Math.round(g / 255 * 31) & 31) << 5) | (Math.round(r / 255 * 31) & 31);
export const bgr555ToRgb = (w) => {
  const r5 = w & 31, g5 = (w >> 5) & 31, b5 = (w >> 10) & 31;
  return [(r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2)];
};

/* ---------- median cut: pixels [[r,g,b]..] -> k BGR555-snapped colours ---------- */
function boxAxis(box) {
  let mn = [255, 255, 255], mx = [0, 0, 0];
  for (const p of box) for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
  const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  let a = 0; if (r[1] > r[a]) a = 1; if (r[2] > r[a]) a = 2;
  return { axis: a, range: r[a] };
}
export function medianCut(pixels, k) {
  if (!pixels.length) return [[0, 0, 0]];
  // Each box caches its split axis+range, computed once on creation. The old code re-scanned
  // boxAxis over every box each iteration (O(k*n)) and called it twice on the chosen box; for the
  // 17408-px cover that was ~1.4M scans/game. Caching -> O(k^2) to pick the max + O(n log n) sorts.
  const mk = (pix) => { const a = boxAxis(pix); return { pix, axis: a.axis, range: a.range }; };
  let boxes = [mk(pixels)];
  while (boxes.length < k) {
    let bi = -1, br = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].pix.length < 2) continue;
      if (boxes[i].range > br) { br = boxes[i].range; bi = i; }
    }
    if (bi < 0) break;
    const b = boxes[bi], ax = b.axis;
    b.pix.sort((p, q) => p[ax] - q[ax]);
    const mid = b.pix.length >> 1;
    boxes.splice(bi, 1, mk(b.pix.slice(0, mid)), mk(b.pix.slice(mid)));
  }
  const pal = boxes.map((box) => {
    let r = 0, g = 0, bl = 0; for (const p of box.pix) { r += p[0]; g += p[1]; bl += p[2]; }
    const n = box.pix.length || 1; return [snap5(r / n), snap5(g / n), snap5(bl / n)];
  });
  while (pal.length < k) pal.push([0, 0, 0]); // pad
  return pal;
}
function nearest(r, g, b, pal) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = r - pal[i][0], dg = g - pal[i][1], db = b - pal[i][2], d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

const snap5cache = new Int16Array(256).fill(-1);
function snap5fast(v) { let s = snap5cache[v]; if (s < 0) { s = snap5(v); snap5cache[v] = s; } return s; }

/* ---------- quantise a region to ncolors. opaque optional (null = all opaque) ----------
 * Returns { idx: Int16Array (0..ncolors-1 opaque, -1 transparent), pal: [[r,g,b]..] }.
 * The source is snapped to BGR555 up front (the SNES colour space, so no quality loss): fewer
 * distinct colours -> a fast median-cut and an effective nearest-colour cache (flat areas cost
 * One search, not one per pixel). The nearest() search is O(pixels*ncolors), which froze the UI
 * per frame before the cache. */
export function quantiseRegion(rgb, opaque, W, H, ncolors, dither) {
  const N = W * H;
  const sr = new Uint8Array(N), sg = new Uint8Array(N), sb = new Uint8Array(N);
  for (let i = 0; i < N; i++) { sr[i] = snap5fast(rgb[i * 3]); sg[i] = snap5fast(rgb[i * 3 + 1]); sb[i] = snap5fast(rgb[i * 3 + 2]); }
  const pix = [];
  for (let i = 0; i < N; i++) if (!opaque || opaque[i]) pix.push([sr[i], sg[i], sb[i]]);
  const pal = medianCut(pix, ncolors);
  const idx = new Int16Array(N).fill(-1);
  if (!dither) {
    const cache = new Map();
    for (let i = 0; i < N; i++) {
      if (opaque && !opaque[i]) continue;
      const key = (sr[i] << 16) | (sg[i] << 8) | sb[i];
      let k = cache.get(key);
      if (k === undefined) { k = nearest(sr[i], sg[i], sb[i], pal); cache.set(key, k); }
      idx[i] = k;
    }
  } else {
    const work = new Float64Array(W * H * 3);
    for (let i = 0; i < work.length; i++) work[i] = rgb[i];
    const nb = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = y * W + x; if (opaque && !opaque[o]) continue;
      const r = work[o * 3], g = work[o * 3 + 1], b = work[o * 3 + 2];
      const k = nearest(r, g, b, pal); idx[o] = k;
      const er = r - pal[k][0], eg = g - pal[k][1], eb = b - pal[k][2];
      for (const [dx, dy, f] of nb) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && (!opaque || opaque[ny * W + nx])) {
          const n = (ny * W + nx) * 3;
          work[n] += er * f / 16; work[n + 1] += eg * f / 16; work[n + 2] += eb * f / 16;
        }
      }
    }
  }
  return { idx, pal };
}

/* ---------- 8bpp SNES planar tile from an index plane (value = base+idx, 0 if idx<0) ---------- */
function encodeTile8(idx, W, tx, ty, base) {
  const out = new Uint8Array(64); let o = 0;
  for (let pp = 0; pp < 4; pp++) {
    const pLo = pp * 2, pHi = pp * 2 + 1;
    for (let row = 0; row < 8; row++) {
      let lo = 0, hi = 0;
      for (let col = 0; col < 8; col++) {
        const ix = idx[(ty * 8 + row) * W + (tx * 8 + col)];
        const v = ix < 0 ? 0 : (base + ix) & 0xff;
        lo |= ((v >> pLo) & 1) << (7 - col);
        hi |= ((v >> pHi) & 1) << (7 - col);
      }
      out[o++] = lo; out[o++] = hi;
    }
  }
  return out;
}
/** Encode an idx plane (Wt*8 x Ht*8) into Wt*Ht 8bpp planar SNES tiles, tile-order, value=base+idx
 *  (idx<0 -> 0/transparent). Exported (base=0 usable), reused by lib/man.js for the .man Manual
 *  asset's 8bpp tiles (same planar codec as utils/snesgfx.py's encode_tile_8bpp). */
export function encodeTiles8(idx, Wt, Ht, base) {
  const W = Wt * 8, out = new Uint8Array(Wt * Ht * 64); let off = 0;
  for (let ty = 0; ty < Ht; ty++) for (let tx = 0; tx < Wt; tx++) { out.set(encodeTile8(idx, W, tx, ty, base), off); off += 64; }
  return out;
}
/** pal ([[r,g,b]..]) -> ncolors*2B BGR555 LE bytes. Exported, reused by lib/man.js. */
export function palToBytes(pal, ncolors) {
  const b = new Uint8Array(ncolors * 2);
  for (let i = 0; i < ncolors; i++) { const w = rgbToBGR555(pal[i][0], pal[i][1], pal[i][2]); b[i * 2] = w & 0xff; b[i * 2 + 1] = (w >> 8) & 0xff; }
  return b;
}
/** 4bpp SNES planar tile codec for the scrollable `.man` ZOOM/SCL1 sections. idx4 is T*64 (values
 *  0..15, tile-major then row-major) -> T*32 planar bytes (planes 0&1 in 0..15, 2&3 in 16..31,
 *  Msb-first). Mirrors snesgfx.encode_tiles_4bpp / man.ts encodeTiles4. Exported, reused by man.js. */
export function encodeTiles4(idx4, T) {
  const out = new Uint8Array(T * 32);
  for (let t = 0; t < T; t++) {
    const tb = t * 32, tp = t * 64;
    for (let y = 0; y < 8; y++) {
      let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
      for (let x = 0; x < 8; x++) {
        const iv = idx4[tp + y * 8 + x], v = (iv < 0 ? 0 : iv) & 0x0f, bit = 7 - x;
        p0 |= ((v >> 0) & 1) << bit; p1 |= ((v >> 1) & 1) << bit;
        p2 |= ((v >> 2) & 1) << bit; p3 |= ((v >> 3) & 1) << bit;
      }
      out[tb + 2 * y] = p0; out[tb + 2 * y + 1] = p1;
      out[tb + 16 + 2 * y] = p2; out[tb + 16 + 2 * y + 1] = p3;
    }
  }
  return out;
}
/** Decode Wt*Ht planar 4bpp tiles at `off` -> a (Wt*8 x Ht*8) index plane (0..15), inverse of
 *  encodeTiles4. Reused by lib/man.js to render a scrollable `.man` page back to palette indices. */
export function decodeTiles4(blob, off, Wt, Ht) {
  const W = Wt * 8, plane = new Uint8Array(W * Ht * 8);
  for (let ty = 0; ty < Ht; ty++) for (let tx = 0; tx < Wt; tx++) {
    const t = off + (ty * Wt + tx) * 32;
    for (let row = 0; row < 8; row++) {
      const p0 = blob[t + row * 2], p1 = blob[t + row * 2 + 1], p2 = blob[t + 16 + row * 2], p3 = blob[t + 16 + row * 2 + 1];
      for (let col = 0; col < 8; col++) {
        const bit = 7 - col;
        plane[(ty * 8 + row) * W + (tx * 8 + col)] = (((p0 >> bit) & 1) << 0) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
      }
    }
  }
  return plane;
}

/* ---------- public encode ---------- */
/** Encode the cover: {coverRgb (COVER_W*COVER_H*3), opaque (COVER_W*COVER_H)} -> {tiles, palBytes}. */
export function encodeCover(coverRgb, opaque) {
  const { idx, pal } = quantiseRegion(coverRgb, opaque, COVER_W, COVER_H, COVER_NCOLORS, true);
  return { tiles: encodeTiles8(idx, COVER_W_TILES, COVER_H_TILES, COVER_CGBASE), palBytes: palToBytes(pal, COVER_NCOLORS) };
}
/** Encode one FMV frame (rgb BOX_W*BOX_H*3, fully opaque) -> {tiles, palBytes}. */
export function encodeFmvFrame(frameRgb, dither = false) {
  const { idx, pal } = quantiseRegion(frameRgb, null, BOX_W, BOX_H, FMV_NCOLORS, dither);
  return { tiles: encodeTiles8(idx, BOX_W_TILES, BOX_H_TILES, FMV_CGBASE), palBytes: palToBytes(pal, FMV_NCOLORS) };
}
/** Assemble the cover-less `.fmv` blob from a pre-encoded frame list (1+ frames; 1 = static shot). */
export function encodeFmv(frames, fps) {
  const frameBlock = FMV_NCOLORS * 2 + BOX_W_TILES * BOX_H_TILES * 64;
  const out = new Uint8Array(HEADER_SIZE + frames.length * frameBlock);
  out[0] = FMV_MAGIC0; out[1] = FMV_MAGIC1; out[2] = FMV_VERSION; out[3] = 0;
  out[4] = BOX_W_TILES; out[5] = BOX_H_TILES; out[6] = FMV_NCOLORS; out[7] = fps;
  out[8] = frames.length & 0xff; out[9] = (frames.length >> 8) & 0xff;
  let off = HEADER_SIZE;
  for (const f of frames) { out.set(f.palBytes, off); off += FMV_NCOLORS * 2; out.set(f.tiles, off); off += BOX_W_TILES * BOX_H_TILES * 64; }
  return out;
}
/** Assemble the standalone `.gcv` cover file from a pre-encoded cover ({tiles, palBytes}). */
export function encodeCoverFile(cover) {
  const out = new Uint8Array(GCV_HEADER_SIZE + COVER_NCOLORS * 2 + COVER_W_TILES * COVER_H_TILES * 64);
  out[0] = GCV_MAGIC0; out[1] = GCV_MAGIC1; out[2] = GCV_VERSION; out[3] = 0;
  out[4] = COVER_W_TILES; out[5] = COVER_H_TILES; out[6] = COVER_NCOLORS; out[7] = 0;
  let off = GCV_HEADER_SIZE;
  out.set(cover.palBytes, off); off += COVER_NCOLORS * 2;
  out.set(cover.tiles, off);
  return out;
}

/* ---------- decode (preview / qa): the cover (.gcv) and the screenshot/FMV (.fmv) are now
 * two separate files; the player composites them into one CGRAM + planes ---------- */
/** Read `nc` BGR555 LE colours at `off` -> [[r,g,b]..]. Exported, reused by lib/man.js's `.man` decoder. */
export function readPal(blob, off, nc) { const p = []; for (let i = 0; i < nc; i++) p.push(bgr555ToRgb(blob[off + i * 2] | (blob[off + i * 2 + 1] << 8))); return p; }
/** Decode Wt*Ht planar 8bpp tiles at `off` -> a (Wt*8 x Ht*8) index plane (inverse of encodeTiles8).
 *  Exported, reused by lib/man.js to render a `.man` block's tiles back to palette indices. */
export function decodeTiles8(blob, off, Wt, Ht) {
  const W = Wt * 8, plane = new Uint8Array(W * Ht * 8);
  for (let ty = 0; ty < Ht; ty++) for (let tx = 0; tx < Wt; tx++) {
    const t = off + (ty * Wt + tx) * 64;
    for (let pp = 0; pp < 4; pp++) for (let row = 0; row < 8; row++) {
      const lo = blob[t + pp * 16 + row * 2], hi = blob[t + pp * 16 + row * 2 + 1];
      for (let col = 0; col < 8; col++) { const bit = 7 - col; const v = (((lo >> bit) & 1) << (pp * 2)) | (((hi >> bit) & 1) << (pp * 2 + 1)); plane[(ty * 8 + row) * W + (tx * 8 + col)] |= v; }
    }
  }
  return plane; // values are the 8bpp CGRAM indices (0=transparent, 48..167 cover, 168..255 fmv)
}
/** Decode the standalone .gcv cover: returns the palette (-> CGRAM COVER_CGBASE) + the index plane. */
export function decodeCoverFile(blob) {
  if (blob.length < GCV_HEADER_SIZE || blob[0] !== GCV_MAGIC0 || blob[1] !== GCV_MAGIC1 || blob[2] !== GCV_VERSION) throw new Error('not a .gcv');
  const coverW = blob[4], coverH = blob[5], nc = blob[6];
  const pal = readPal(blob, GCV_HEADER_SIZE, nc);
  const plane = decodeTiles8(blob, GCV_HEADER_SIZE + nc * 2, coverW, coverH);
  return { coverW, coverH, nc, pal, plane };
}
export function decodeFmvHeader(blob) {
  if (blob.length < HEADER_SIZE || blob[0] !== FMV_MAGIC0 || blob[1] !== FMV_MAGIC1 || blob[2] !== FMV_VERSION) throw new Error('not a .fmv');
  return { boxW: blob[4], boxH: blob[5], fmvNc: blob[6], fps: blob[7], numFrames: blob[8] | (blob[9] << 8) };
}
/** Decode frame `n` of a cover-less .fmv: returns the frame palette (-> CGRAM FMV_CGBASE) + plane. */
export function decodeFmvFrame(blob, n) {
  const h = decodeFmvHeader(blob);
  const frameBlock = h.fmvNc * 2 + h.boxW * h.boxH * 64;
  const fOff = HEADER_SIZE + n * frameBlock;
  const pal = readPal(blob, fOff, h.fmvNc);
  const plane = decodeTiles8(blob, fOff + h.fmvNc * 2, h.boxW, h.boxH);
  return { h, pal, plane };
}
/** Compose a 256-colour CGRAM for the preview: bg fill, cover pal at COVER_CGBASE, fmv pal at FMV_CGBASE. */
export function composeCgram(coverPal, framePal, bg = [8, 40, 56]) {
  const cgram = new Array(256).fill(bg);
  if (coverPal) for (let i = 0; i < coverPal.length; i++) cgram[COVER_CGBASE + i] = coverPal[i];
  if (framePal) for (let i = 0; i < framePal.length; i++) cgram[FMV_CGBASE + i] = framePal[i];
  return cgram;
}
