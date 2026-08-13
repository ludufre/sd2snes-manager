// Render an sd2snes+ `.thm` menu theme to a preview data URL, entirely client-side. Faithful port of
// ../sd2snes-landing/scripts/render_preview.py (itself a port of the Theme Creator's drawPreview()), so a
// gallery theme renders identically to its /gallery/previews PNG, and any .thm (custom/edited, off-gallery)
// gets a real preview too. A .thm only carries the slots it overrides; missing slots fall back to the fork
// defaults. The 512x448 menu-text look comes from fixed alpha masks (public/theme-preview) tinted by the
// theme's palette. That text is not in the .thm (same as the gallery).

import { FORK_DEFAULTS_B64 } from './thm-fork-defaults.js';

const W = 512, H = 448;         // preview canvas (256x224 SNES field at 2x)
const IMG_H = 56;               // logo native height (drawn 2x)

// _GFXPTR_ slots used by the renderer
const SLOT = { LOGO_PAL: 1, HDMA_BAR: 3, HDMA_PAL: 4, PALETTE: 7, LOGO_TILES: 8 };
const FORK_KEY = { 1: 'logo_pal', 3: 'hdma_bar_color_src', 4: 'hdma_pal_src', 7: 'palette', 8: 'logo_tiles' };

// 14 colour groups x 3 shades -> these CGRAM indices in the 256-colour palette (slot 7)
const MENU_INDICES = [
  0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f,
  0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x19, 0x1a, 0x1b, 0x1d, 0x1e, 0x1f,
  0x21, 0x22, 0x23, 0x31, 0x32, 0x33, 0x41, 0x42, 0x43, 0x51, 0x52, 0x53,
  0x61, 0x62, 0x63, 0x71, 0x72, 0x73,
];

// the 12 text layers: mask file + which menu-palette colour tints it
const MASK_FILES = [
  'text_folder_1.png', 'text_folder_2.png', 'text_folder_3.png',
  'text_file_1.png', 'text_file_2.png', 'text_file_3.png',
  'text_menu_1.png', 'text_menu_2.png', 'text_menu_3.png',
  'text_unfocused_1.png', 'text_unfocused_2.png', 'text_unfocused_3.png',
];
const TEXT_PIDX = [3, 4, 5, 0, 1, 2, 9, 10, 11, 18, 19, 20];

/* ---- byte / colour helpers (BGR555 -> RGB, truncating like render_preview.py) ---- */
function w555(buf, idx) { return buf[2 * idx] | (buf[2 * idx + 1] << 8); }
function rgb5(word) {
  return [(word & 31) << 3, ((word >> 5) & 31) << 3, ((word >> 10) & 31) << 3];
}
function css(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }

/* ---- fork defaults (base64 -> bytes, decoded lazily) ---- */
const _fork = {};
function forkDefault(key) {
  if (!_fork[key]) {
    const bin = atob(FORK_DEFAULTS_B64[key]);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    _fork[key] = u;
  }
  return _fork[key];
}

/* ---- FXTHEME1 container ---- */
function parseThm(bytes) {
  if (bytes.length < 16 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]) !== 'FXTHEME1') {
    throw new Error('not a .thm (bad magic)');
  }
  const n = bytes[9];
  const reg = {};
  let off = 16, poff = 16 + n * 4;
  for (let r = 0; r < n; r++) {
    const slot = bytes[off];
    const len = bytes[off + 2] | (bytes[off + 3] << 8);
    reg[slot] = bytes.subarray(poff, poff + len);
    poff += len; off += 4;
  }
  return reg;
}
function withDefaults(reg) {
  for (const slot of Object.keys(FORK_KEY)) if (!reg[slot]) reg[slot] = forkDefault(FORK_KEY[slot]);
  return reg;
}

/* ---- gradient / selection ---- */
function parseBands(buf) {
  const bands = [];
  let p = 0;
  while (p + 3 <= buf.length) {
    const c = buf[p];
    if (c === 0) break;                                   // 0-terminator
    bands.push({ size: c & 0x7f, color: rgb5((buf[p + 1] | (buf[p + 2] << 8)) & 0x7fff) });
    p += 3;
  }
  return bands;
}
function parseSelection(buf) {
  const sel = [];
  for (let i = 0; i < 2; i++) {
    sel.push([(buf[4 * i] & 0x1f) << 3, (buf[4 * i + 1] & 0x1f) << 3, (buf[4 * i + 2] & 0x1f) << 3]);
  }
  return sel;
}

/* ---- logo: 8bpp planar SNES tiles + 32-colour logo palette -> ImageData (native, 128 or 256 wide) ---- */
function decodeLogo(logoPal, tiles, lw) {
  const pal = [];
  for (let k = 0; k < 32; k++) pal.push(rgb5(w555(logoPal, k)));
  const data = new Uint8ClampedArray(lw * IMG_H * 4);
  const rowStride = (lw / 8) * 64;
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < lw; x++) {
      const base = rowStride * (y >> 3) + 0x40 * (x >> 3) + 2 * (y & 7);
      const bit = 7 - (x & 7);
      let v = 0;
      v |= (tiles[base + 0x00] >> bit) & 1;
      v |= ((tiles[base + 0x01] >> bit) & 1) << 1;
      v |= ((tiles[base + 0x10] >> bit) & 1) << 2;
      v |= ((tiles[base + 0x11] >> bit) & 1) << 3;
      v |= ((tiles[base + 0x20] >> bit) & 1) << 4;
      v |= ((tiles[base + 0x21] >> bit) & 1) << 5;
      v |= ((tiles[base + 0x30] >> bit) & 1) << 6;
      v |= ((tiles[base + 0x31] >> bit) & 1) << 7;
      if (v < 64) continue;                               // transparent -> shows gradient
      const c = pal[v - 64];
      const di = 4 * (y * lw + x);
      data[di] = c[0]; data[di + 1] = c[1]; data[di + 2] = c[2]; data[di + 3] = 255;
    }
  }
  return new ImageData(data, lw, IMG_H);
}

/* ---- text masks (same for every theme), loaded once, cached. Same-origin (public/) so the canvas
 *      stays untainted and toDataURL works. Relative URL respects the app's <base href>. ---- */
let _masksP = null;
function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('theme mask failed: ' + url));
    im.src = url;
  });
}
function loadMasks() {
  if (!_masksP) _masksP = Promise.all(MASK_FILES.map((f) => loadImg('theme-preview/' + f)));
  return _masksP;
}

/** Render a `.thm` (Uint8Array or ArrayBuffer) to a `data:image/png` preview URL. Rejects on a bad file. */
export async function renderThmToDataUrl(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const reg = withDefaults(parseThm(bytes));
  const palette = reg[SLOT.PALETTE];
  const menuPal = MENU_INDICES.map((i) => rgb5(w555(palette, i)));

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // 1) background gradient, fill with the last band's colour, then stack bands (2x scanlines each)
  const bands = parseBands(reg[SLOT.HDMA_PAL] || new Uint8Array());
  if (bands.length) {
    ctx.fillStyle = css(bands[bands.length - 1].color);
    ctx.fillRect(0, 0, W, H);
    let y = 0;
    for (const b of bands) {
      const hh = 2 * Math.max(b.size, 1);
      ctx.fillStyle = css(b.color);
      ctx.fillRect(0, y, W, hh);
      y += hh;
      if (y >= H) break;
    }
  }

  // 2) logo, decode native, draw 2x (nearest) top-left; transparent shows the gradient
  if (reg[SLOT.LOGO_PAL] && reg[SLOT.LOGO_TILES]) {
    const tiles = reg[SLOT.LOGO_TILES];
    const cols = Math.max(1, (tiles.length / 64 / (IMG_H / 8)) | 0);   // 16 (128px) or 32 (256px)
    const lw = cols * 8;
    const tmp = document.createElement('canvas');
    tmp.width = lw; tmp.height = IMG_H;
    tmp.getContext('2d').putImageData(decodeLogo(reg[SLOT.LOGO_PAL], tiles, lw), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, lw, IMG_H, 0, 0, lw * 2, IMG_H * 2);
  }

  // 3) menu text, tint each fixed alpha mask by its palette colour, composite over
  const masks = await loadMasks();
  const scratch = document.createElement('canvas');
  scratch.width = W; scratch.height = H;
  const sctx = scratch.getContext('2d');
  for (let i = 0; i < masks.length; i++) {
    const c = menuPal[TEXT_PIDX[i]];
    sctx.globalCompositeOperation = 'source-over';
    sctx.fillStyle = css(c);
    sctx.fillRect(0, 0, W, H);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(masks[i], 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scratch, 0, 0);
  }

  // 4) selection bars, additive
  const sel = parseSelection(reg[SLOT.HDMA_BAR] || new Uint8Array(8));
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = css(sel[0]);
  ctx.fillRect(6, 130, 500, 16);
  ctx.fillRect(6, 386, 500, 16);
  ctx.fillStyle = css(sel[1]);
  ctx.fillRect(282, 306, 28, 16);
  ctx.globalCompositeOperation = 'source-over';

  return canvas.toDataURL('image/png');
}
