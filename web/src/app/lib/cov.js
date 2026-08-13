// `.cov` v4 OBJ-sprite cover format: reader, thumbnail renderer, and the bridge to the
// WebAssembly encoder.
//
// The firmware draws the cover as a w_spr x h_spr grid of 16x16 OBJ sprites (4bpp, up to 8
// OBJ palettes, one per 16x16 block via the BLOCKMAP) floating over the file list:
//   Header(12): 'C','V',ver=4,flags,w_spr,h_spr,n_palettes,0,bpp=4,0,0,0
//   Palettes:   n_palettes x 16 BGR555-LE entries (index 0 = transparent)
//   Blockmap:   w_spr*h_spr palette indices (1 byte each)
//   Tiles:      (2*h_spr) rows x 16 cols of 8x8 4bpp planar tiles (name-grid order)
//
// Encoding is not done here. It goes through covwasm.js, which runs the Go encoder in
// `covgen/` compiled to WebAssembly, so the bytes match the firmware and server tools exactly.
// A pure-JS encoder used to live in this file (a port of the same Go code) and was removed once
// the wasm became the only path: it resampled with Canvas instead of Catmull-Rom, so it was
// visually equivalent but never byte-identical. `covgen/internal/cov/cov.go` is the reference.

import { encodeCovWasm } from './covwasm.js';

export const MAGIC0 = 0x43; // 'C'
export const MAGIC1 = 0x56; // 'V'
export const VERSION = 4;
export const BPP = 4;
export const HEADER_SIZE = 12;

export function bgr555ToRgb(word) {
  let r = (word & 0x1f) << 3;
  let g = ((word >> 5) & 0x1f) << 3;
  let b = ((word >> 10) & 0x1f) << 3;
  r |= r >> 5;
  g |= g >> 5;
  b |= b >> 5;
  return [r, g, b];
}

/* ---------- decoder (round-trip qa; mirrors cover_conv.py verify_cov_v4) ---------- */

export function decodeCov(blob) {
  if (blob.length < HEADER_SIZE || blob[0] !== MAGIC0 || blob[1] !== MAGIC1 || blob[2] !== VERSION || blob[8] !== BPP) {
    throw new Error('not a .cov v4 file');
  }
  const d = {
    dithered: (blob[3] & 0x01) !== 0,
    wSpr: blob[4],
    hSpr: blob[5],
    nPalettes: blob[6],
  };
  let off = HEADER_SIZE;
  const palSize = d.nPalettes * 16 * 2;
  const bmSize = d.wSpr * d.hSpr;
  const tilesSize = 2 * d.hSpr * 16 * 32;
  if (blob.length < off + palSize + bmSize + tilesSize) throw new Error('truncated .cov v4 file');

  d.palettes = [];
  for (let p = 0; p < d.nPalettes; p++) {
    const pal = [];
    for (let i = 0; i < 16; i++) {
      const w = blob[off] | (blob[off + 1] << 8);
      pal.push(bgr555ToRgb(w));
      off += 2;
    }
    d.palettes.push(pal);
  }

  d.blockmap = blob.slice(off, off + bmSize); off += bmSize;

  const rows = 2 * d.hSpr, cols = 16;
  d.tiles = Array.from({ length: rows * 8 }, () => new Uint8Array(cols * 8));
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const tile = blob.subarray(off, off + 32); off += 32;
      for (let row = 0; row < 8; row++) {
        const p0 = tile[row * 2], p1 = tile[row * 2 + 1], p2 = tile[16 + row * 2], p3 = tile[16 + row * 2 + 1];
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          d.tiles[cy * 8 + row][cx * 8 + col] =
            ((p0 >> bit) & 1) | (((p1 >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2) | (((p3 >> bit) & 1) << 3);
        }
      }
    }
  }
  return d;
}

/** Decode a `.cov` v4 blob and render it to a PNG data URL (live on-card
 *  thumbnail, no network). Transparent OBJ pixels (letterbox) stay transparent. */
export function covToDataUrl(blob) {
  const d = decodeCov(blob);
  const W = d.wSpr * 16, H = d.hSpr * 16;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const data = img.data;
  for (let sy = 0; sy < d.hSpr; sy++) {
    for (let sx = 0; sx < d.wSpr; sx++) {
      let pi = d.blockmap[sy * d.wSpr + sx];
      if (pi < 0 || pi >= d.nPalettes) pi = 0;
      const pal = d.palettes[pi];
      for (let dy = 0; dy < 16; dy++) {
        for (let dx = 0; dx < 16; dx++) {
          const cy = 2 * sy + (dy >> 3), cx = 2 * sx + (dx >> 3);
          const v = d.tiles[cy * 8 + (dy & 7)][cx * 8 + (dx & 7)];
          const p = ((sy * 16 + dy) * W + (sx * 16 + dx)) * 4;
          if (v === 0) { data[p + 3] = 0; continue; }
          const c = pal[v];
          data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2]; data[p + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Encode a `.cov` from already-fetched image bytes, through the wasm encoder. The caller
 *  fetches the cover (it is always same-origin: either the API proxy for gamedb CDN covers,
 *  or a blob:/data: URL from "Use my image..."). */
export async function buildCovFromBytes(bytes, { wSpr, hSpr, nPalettes = 8, dither = true, fill = false, autoSize = true } = {}) {
  if (!bytes) throw new Error('no cover bytes for a .cov');
  return encodeCovWasm(bytes, { nPalettes, dither, fill, wSpr, hSpr, autoSize });
}
