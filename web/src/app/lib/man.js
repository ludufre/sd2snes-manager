// .man Manual/Guide asset encoder, Manager-side port of `_repo/utils/gen_man.py` (the "spec
// executável"). Byte-contract mirror of the gamedb backend `man.ts` (they must stay byte-identical:
// man.spec.ts asserts it). Reuses lib/bandpal.js's snap5 / median-cut / BGR555 + the 4bpp planar tile
// codec (encodeTiles4/decodeTiles4).
//
// PDF vs plain page images:
//   - PDF is the primary input, rendered with pdf.js (`pdfjs-dist`, self-hosted, scripts/setup-pdfjs.sh),
//     mirroring gen_man.py's pdftoppm pipeline.
//   - PNG/JPG page images (one file per page, caller-ordered) are also accepted via createImageBitmap.
//   Both adapters converge on the same pure encode core (buildManFile), which only ever sees
//   already-rasterized {rgb, width, height} pages and knows nothing about PDF/canvas/DOM.
//
// Scrollable format (what the current firmware reads; the legacy quadrant-zoom 8bpp format was retired.
// Its 1x block bodies are no longer emitted). 40B header (ver fixed at 1):
//   +0 4 "manl" · +4 ver=1 · +5 bpp=8 · +6 npages · +7 flags(bit1=0x02 scrollable; bit0 legacy, unset)
//   +8 page_w=256 LE · +10 band_h=224 LE · +12 nblocks LE · +14 zoom_nblocks=0 (retired) · +16 title[24]
// index (8B/entry @ +40): offset:u32(=0, bodies retired) page:u8 block:u8 content_rows:u8 rsvd:u8(=0)
// Then, if zoom: zoom sub-header (32B, 2x@512) + SCL1 sub-header (32B, 1x@256) + zoom page dir + zoom
// block map + scl1 page dir, padded to 512B, then the zoom/scl1 page bodies (palette 256B sector-padded
// + attrs sector-padded + 4bpp tiles). See MAN-SCROLLABLE layout in man.ts.

import { snap5, medianCut, rgbToBGR555, bgr555ToRgb, encodeTiles4, decodeTiles4, readPal } from './bandpal.js';

export const PAGE_W = 256;
export const BAND_H = 224;
export const TILES_W = PAGE_W / 8;               // 32
export const TILES_H = BAND_H / 8;               // 28
export const HEADER_SIZE = 40;
export const TITLE_OFS = 16;
export const TITLE_CAP = 24;                     // header title[] field size (incl. nul)
export const INDEX_ENTRY = 8;
export const SECTOR = 512;
export const SEAM_WINDOW = 16;
export const DARK_THRESH = 128;
export const FLAG_ZOOM = 0x01;                   // legacy quadrant zoom, retired, never set
export const FLAG_ZOOM2 = 0x02;                  // scrollable 4bpp zoom section present
export const MAX_GUIDES = 8;                     // 1 principal (.man) + 7 numbered (.02..08.man)

// --- scrollable zoom section (2x, 512px wide) ---
export const ZTILES_W = 64;
export const ZTILE_BYTES = 32;                   // 4bpp
export const ZROW_BYTES = ZTILES_W * ZTILE_BYTES; // 2048 = 4 sectors
export const ZATTR_STRIDE = ZTILES_W;            // 64
export const ZPAL_COUNT = 8;
export const ZPAL_SIZE = 16;
export const ZPAL_BYTES = ZPAL_COUNT * ZPAL_SIZE * 2; // 256
export const ZPAL_STRIDE = SECTOR;               // palette padded to one sector
export const ZMAX_ROWS = 96;
export const ZCHUNK_PX = ZMAX_ROWS * 8;          // 768
export const ZHDR_BYTES = 32;
export const ZDIR_ENTRY = 20;
export const ZMAP_ENTRY = 4;
// --- scale-1 SCL1 section (1x, 256px wide) ---
export const S1TILES_W = PAGE_W / 8;             // 32
export const S1ROW_BYTES = S1TILES_W * ZTILE_BYTES; // 1024 = 2 sectors
export const S1ATTR_STRIDE = S1TILES_W;          // 32
export const S1MAX_ROWS = 64;
// SCL1 chunk height: 48 rows = 384 1x px = half a zoom chunk (768 2x px). The firmware viewer maps
// 1x page p <-> zoom page p (Y2 = 2*Y1) with no cross-count fallback, so both sections must cut into
// the same number of chunks for any page height: ceil(H1/384) === ceil(2*H1/768). Cutting SCL1 at the
// S1MAX_ROWS capacity (64 rows = 512px) instead breaks the pairing for tall pages (H1 in (384,512]:
// 1 SCL1 chunk vs 2 zoom chunks -> the a toggle on the 2nd zoom page has no 1x page to return to).
export const S1CHUNK_ROWS = 48;
export const ZLLOYD_ITERS = 6;                   // fixed iteration count -> deterministic output
// --- spread split + pre-quantize sharpen ---
// A page wider than SPREAD_AR * height is a 2-page spread scan laid flat; fit-width would give each
// printed page only half the pixel budget (illegible text after 4bpp quantization). Threshold 1.6:
// catches real spreads (2 landscape pages ~2.8, 2 squarish pages ~1.8) while a single landscape A4
// (1.414) stays whole. Two portrait pages side by side also land at ~1.414. That false negative is
// what the explicit spread:'on' override is for. Splitting is recursive: a piece still at/over the
// threshold is halved again (cover wraps scan at ~4.8:1 and fold-outs at ~3.3:1. One halving leaves
// them at 2.4/1.65, still a sliver on screen), capped at SPREAD_MAX_SPLITS halvings.
export const SPREAD_AR = 1.6;
export const SPREAD_MAX_SPLITS = 2; // 4 pieces covers aspect < 6.4

/** Number of halvings (0..SPREAD_MAX_SPLITS) so every emitted piece is < SPREAD_AR. */
export function spreadSplitFactor(width, height) {
  let k = 0;
  let ar = height > 0 ? width / height : 0;
  while (k < SPREAD_MAX_SPLITS && ar >= SPREAD_AR) {
    ar /= 2;
    k++;
  }
  return k;
}
// Unsharp amount applied before quantization (the 4bpp median-cut flattens the rasterizer's grayscale
// Aa on small text; a mild sharpen keeps glyph edges through it). Blur kernel: separable [1,2,1]/4.
export const UNSHARP_AMOUNT = 0.8;

if (HEADER_SIZE !== TITLE_OFS + TITLE_CAP) throw new Error('man.js: header layout drifted');

/* ---------- title font-encode (mirror of build_const.py ACCENTS, HAND-SYNCED mirror; keep it
 * identical to `_repo/snes/utils/build_const.py` and to man.ts). ---------- */
export const ACCENTS = {
  'á': 130, 'à': 131, 'â': 132, 'ã': 133, 'é': 134, 'ê': 135,
  'í': 136, 'ó': 137, 'ô': 138, 'õ': 139, 'ú': 140, 'ç': 141,
  'Á': 142, 'À': 143, 'Â': 144, 'Ã': 145, 'É': 146, 'Ê': 147,
  'Í': 148, 'Ó': 149, 'Ô': 150, 'Õ': 151, 'Ú': 152, 'Ç': 153,
  'ñ': 154, 'Ñ': 155, 'ü': 156, 'Ü': 157, '¿': 158, '¡': 159,
  'è': 224, 'ù': 225, 'î': 226, 'ï': 227, 'ë': 228, 'û': 229,
  'ì': 230, 'ò': 231, 'È': 232, 'Ì': 233, 'Ò': 234, 'Ù': 235,
};
const DECODE_TITLE = Object.fromEntries(Object.entries(ACCENTS).map(([k, v]) => [v, k]));

/** UTF-8 string -> TITLE_CAP bytes (font codes, nul-padded). Mirrors gen_man.py's font_encode_title. */
export function fontEncodeTitle(text) {
  const out = new Uint8Array(TITLE_CAP); // zero-filled -> nul pad by construction
  let n = 0, truncated = false;
  for (const ch of String(text ?? '')) {
    if (n >= TITLE_CAP - 1) { truncated = true; break; }
    const code = ACCENTS[ch];
    if (code !== undefined) { out[n++] = code; continue; }
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp < 0x7f) { out[n++] = cp; continue; }
    throw new Error(`title: character ${JSON.stringify(ch)} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) has no font mapping (see ACCENTS)`);
  }
  if (truncated) console.warn(`[man] title truncated to ${TITLE_CAP - 1} glyphs:`, text);
  return out;
}

/** Inverse of fontEncodeTitle (best-effort; header display / guide list). */
export function fontDecodeTitle(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += DECODE_TITLE[b] ?? (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '?');
  }
  return s;
}

/** Slug ids reserved in title[0] for an official document's type (mirror of the gamedb MANUAL_TYPE_SLUG_ID
 *  / man.ts). 1..5 sit below the font's printable range so a reader tells a slug from a free-text title
 *  (>= 0x20) or an empty one (0). */
export const MAN_SLUG_MIN = 1;
export const MAN_SLUG_MAX = 5;
/** 24-byte title field carrying a type slug: [slugId, 0, 0, ...]. */
export function slugTitleBytes(slugId) {
  const out = new Uint8Array(TITLE_CAP);
  out[0] = slugId & 0xff;
  return out;
}
/** slug id (1..5) → document type key, or null (mirror of the gamedb MANUAL_TYPE_ORDER). */
export const MANUAL_SLUG_TYPES = ['manual', 'guide', 'map', 'insert', 'other'];
export function manualTypeOfSlug(slug) {
  return MANUAL_SLUG_TYPES[slug - 1] ?? null;
}

/** Default title derivation from a source filename (PDF or first page image), Title-Case of the stem
 *  with a trailing 2-digit multi-guide suffix stripped (mirrors gen_man.py's derive_title). */
export function deriveTitle(filename) {
  let stem = String(filename ?? '').replace(/\.[^./\\]+$/, '');
  const slash = Math.max(stem.lastIndexOf('/'), stem.lastIndexOf('\\'));
  if (slash >= 0) stem = stem.slice(slash + 1);
  const m = stem.match(/^(.*)\.(\d{2})$/);
  if (m) stem = m[1];
  return stem.split(/[_\-]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' '); // Python str.capitalize(): rest lowercased
}

/* ---------- multi-guide naming: <stem>.man (guide 0) + <stem>.NN.man (NN 02..08) ---------- */

/** Guide file name for slot `nn` (0 = principal `<stem>.man`, 2..8 = `<stem>.0N.man`). */
export function guideFileName(stem, nn) {
  if (nn === 0) return `${stem}.man`;
  if (nn < 2 || nn > MAX_GUIDES) throw new Error(`guide slot out of range: ${nn}`);
  return `${stem}.0${nn}.man`;
}
/** The MAX_GUIDES candidate slot numbers in probe order: 0, 2, 3, .., 8. */
export const GUIDE_SLOTS = [0, 2, 3, 4, 5, 6, 7, 8];
/** Slot 0 is reserved for the official GameDB manual (written by auto-fill). */
export const USER_GUIDE_SLOTS = GUIDE_SLOTS.filter((nn) => nn !== 0);
/** How many user-added guides fit once slot 0 is reserved for the official manual (MAX_GUIDES - 1). */
export const MAX_USER_GUIDES = USER_GUIDE_SLOTS.length;

/* ---------- pure encode core (no dom) ---------- */

/** Parse a `.man` header (first HEADER_SIZE bytes). Cheap: callers can read just the first 40 bytes
 *  of a (possibly huge) file to enumerate/list guides. Throws on bad magic. */
export function parseManHeader(bytes) {
  if (bytes.length < HEADER_SIZE) throw new Error('truncated .man header');
  if (bytes[0] !== 0x4d || bytes[1] !== 0x41 || bytes[2] !== 0x4e || bytes[3] !== 0x4c) {
    throw new Error('bad magic (not a .man)');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[7];
  return {
    ver: bytes[4], bpp: bytes[5], npages: bytes[6], flags,
    zoom: !!(flags & FLAG_ZOOM2),
    pageW: dv.getUint16(8, true), bandH: dv.getUint16(10, true),
    nblocks: dv.getUint16(12, true), zoomNblocks: dv.getUint16(14, true),
    slug: bytes[TITLE_OFS] >= MAN_SLUG_MIN && bytes[TITLE_OFS] <= MAN_SLUG_MAX ? bytes[TITLE_OFS] : null,
    title: fontDecodeTitle(bytes.subarray(TITLE_OFS, TITLE_OFS + TITLE_CAP)),
  };
}

/** Decode a scrollable `.man` back to viewable pages (for the in-app viewer / PDF export, not
 *  firmware-facing). Renders the SCL1 (1x) section: reads each page's palette (128 = 8x16), attrs
 *  (palette<<2 per tile) and 4bpp tiles, groups chunks by pdf_page, and stacks them into one RGB
 *  image per PDF page. Returns `{ header, pages:[{rgb,width,height}] }`. */
export function decodeManFile(bytes) {
  const header = parseManHeader(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages = [];
  if (!header.zoom) return { header, pages }; // no scrollable section -> nothing to render
  const z0 = HEADER_SIZE + header.nblocks * INDEX_ENTRY;
  const s1 = z0 + ZHDR_BYTES; // SCL1 sub-header sits right after zoom
  if (!(bytes[s1] === 0x53 && bytes[s1 + 1] === 0x43 && bytes[s1 + 2] === 0x4c && bytes[s1 + 3] === 0x31)) {
    return { header, pages }; // not SCL1 (stale/foreign) -> degrade to empty
  }
  const s1pagedir = dv.getUint32(s1 + 20, true);
  const ns1 = dv.getUint16(s1 + 24, true);
  const byPage = new Map();
  for (let i = 0; i < ns1; i++) {
    const o = s1pagedir + i * ZDIR_ENTRY;
    const e = {
      tileOfs: dv.getUint32(o, true), attrOfs: dv.getUint32(o + 4, true), palOfs: dv.getUint32(o + 8, true),
      nrows: dv.getUint16(o + 12, true), pixH: dv.getUint16(o + 14, true), pdfPage: bytes[o + 18],
    };
    if (!byPage.has(e.pdfPage)) byPage.set(e.pdfPage, []);
    byPage.get(e.pdfPage).push(e);
  }
  for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
    const chunks = byPage.get(p);
    const totalH = chunks.reduce((s, c) => s + c.pixH, 0);
    if (totalH === 0) continue;
    const rgb = new Uint8Array(PAGE_W * totalH * 3);
    let y = 0;
    for (const c of chunks) {
      const pal = readPal(bytes, c.palOfs, 128);                        // 8 palettes x 16 BGR555
      const plane = decodeTiles4(bytes, c.tileOfs, S1TILES_W, c.nrows); // 4bpp indices 0..15
      for (let ry = 0; ry < c.pixH; ry++) {
        const tr = ry >> 3;
        for (let x = 0; x < PAGE_W; x++) {
          const grp = bytes[c.attrOfs + tr * S1ATTR_STRIDE + (x >> 3)] >> 2;
          const col = pal[grp * ZPAL_SIZE + plane[ry * PAGE_W + x]] || [0, 0, 0];
          const o = ((y + ry) * PAGE_W + x) * 3;
          rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
        }
      }
      y += c.pixH;
    }
    pages.push({ rgb, width: PAGE_W, height: totalH });
  }
  return { header, pages };
}

/** Per-pixel luma (r+g+b)/3, one byte/pixel, mirrors gen_man.py's `page.sum(axis=2)//3`. */
function computeGray(rgb, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = ((rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3) | 0;
  return g;
}

/** Smart-seam: cleanest (fewest dark px) row in [target-SEAM_WINDOW, target], ties broken by
 *  nearest-to-target, ties-of-ties by first (ascending y), mirrors find_smart_seam exactly. */
function findSmartSeam(gray, w, y0) {
  const target = y0 + BAND_H;
  const lo = Math.max(y0 + 1, target - SEAM_WINDOW);
  let best = target, bestCnt = Infinity, bestDist = Infinity;
  for (let y = lo; y <= target; y++) {
    let cnt = 0;
    const rowOff = y * w;
    for (let x = 0; x < w; x++) if (gray[rowOff + x] < DARK_THRESH) cnt++;
    const dist = Math.abs(y - target);
    if (cnt < bestCnt || (cnt === bestCnt && dist < bestDist)) { bestCnt = cnt; bestDist = dist; best = y; }
  }
  return best;
}

/** Yield {contentH, y0, y1} top-to-bottom for one page ({rgb,width,height}, width===PAGE_W). (y0,y1)
 *  are the row bounds consumed; the zoom cutter doubles them (seam-lock). Mirrors cut_bands_with_bounds
 *  (1x block bodies are retired, so only the bounds (not the pixels) are needed for the index). */
export function* cutBandsWithBounds(page) {
  const { rgb, width: w, height: h } = page;
  const gray = computeGray(rgb, w, h);
  let y0 = 0;
  while (y0 < h) {
    if (h - y0 <= BAND_H) { yield { contentH: h - y0, y0, y1: h }; return; }
    const seam = findSmartSeam(gray, w, y0);
    yield { contentH: seam - y0, y0, y1: seam };
    y0 = seam;
  }
}

/** Crop rows [r0,r1) of a page into a fresh tightly-packed RGB page. */
function cropRows(page, r0, r1) {
  const { rgb, width } = page;
  const height = r1 - r0;
  const out = new Uint8Array(height * width * 3);
  out.set(rgb.subarray(r0 * width * 3, r1 * width * 3), 0);
  return { rgb: out, width, height };
}

/** True when a rasterized page's aspect says "2-page spread scan" (see SPREAD_AR). */
export function isSpreadAspect(width, height) {
  return height > 0 && width / height >= SPREAD_AR;
}

/** Split a spread page into [left, right] halves (columns [0,w/2) / [w/2,w)). Pure RGB crop, the
 *  adapters always produce exact even target widths (512 -> 2x256, 1024 -> 2x512), so an odd width
 *  here means a broken caller, not data. */
export function splitSpreadPage(page) {
  const { rgb, width: w, height: h } = page;
  if (w % 2) throw new Error(`splitSpreadPage: odd width ${w}`);
  const hw = w / 2;
  const L = new Uint8Array(hw * h * 3);
  const R = new Uint8Array(hw * h * 3);
  for (let y = 0; y < h; y++) {
    const src = y * w * 3;
    L.set(rgb.subarray(src, src + hw * 3), y * hw * 3);
    R.set(rgb.subarray(src + hw * 3, src + w * 3), y * hw * 3);
  }
  return [
    { rgb: L, width: hw, height: h },
    { rgb: R, width: hw, height: h },
  ];
}

/** Mild unsharp mask (separable [1,2,1]/4 blur, amount UNSHARP_AMOUNT) over a tightly-packed RGB
 *  page. Float64 + Math.round only -> deterministic across Node and browsers (byte-parity contract).
 *  Feeds only the quantizer inputs in buildManFile. The seam finder keeps reading the original page
 *  so the head region (header/index/dirs) is identical with sharpen on or off (and stays structurally
 *  comparable with gen_man.py, whose pil UnsharpMask uses a different kernel). */
function unsharpPage(page) {
  const { rgb, width: w, height: h } = page;
  const n3 = w * h * 3;
  const tmp = new Float64Array(n3);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < w - 1 ? x + 1 : w - 1;
      for (let c = 0; c < 3; c++) {
        tmp[(row + x) * 3 + c] =
          (rgb[(row + xm) * 3 + c] + 2 * rgb[(row + x) * 3 + c] + rgb[(row + xp) * 3 + c]) / 4;
      }
    }
  }
  const out = new Uint8Array(n3);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * w + x) * 3 + c;
        const blur = (tmp[(ym * w + x) * 3 + c] + 2 * tmp[i] + tmp[(yp * w + x) * 3 + c]) / 4;
        const v = Math.round(rgb[i] + UNSHARP_AMOUNT * (rgb[i] - blur));
        out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return { rgb: out, width: w, height: h };
}

/* ---------- scrollable 4bpp quantizer (8 palettes of 16), port of gen_man.py quantize_zoom_page.
 * man.ts and man.js share this exact code + bandpal, so the two are BYTE-EXACT for identical RGB. ---------- */

function nearest(r, g, b, pal) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = r - pal[i][0], dg = g - pal[i][1], db = b - pal[i][2], d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/** Round an RGB triple onto the BGR555 grid and back (what the PPU shows). Mirrors gen_man._snap555. */
function snap555rgb(r, g, b) {
  return bgr555ToRgb(rgbToBGR555(r, g, b));
}

/** Deterministic weighted median cut, port of gen_man.py `_weighted_median_cut`. */
function weightedMedianCut(pts, w, k) {
  const live = [];
  for (let i = 0; i < w.length; i++) if (w[i] > 0) live.push(i);
  if (!live.length) return Array.from({ length: k }, () => [0, 0, 0]);
  let boxes = [live];
  while (boxes.length < k) {
    let bestI = -1, bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      let ws = 0;
      for (const idx of b) {
        ws += w[idx];
        for (let c = 0; c < 3; c++) { const v = pts[idx][c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
      }
      const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
      const score = ws * ext;
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    if (bestI < 0) break;
    const b = boxes[bestI];
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const idx of b) for (let c = 0; c < 3; c++) { const v = pts[idx][c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
    let ch = 0;
    { const e = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; if (e[1] > e[ch]) ch = 1; if (e[2] > e[ch]) ch = 2; }
    const order = b.slice().sort((p, q) => (pts[p][ch] - pts[q][ch]) || (p - q));
    let total = 0;
    for (const idx of order) total += w[idx];
    let cum = 0, split = order.length;
    const half = total / 2;
    for (let i = 0; i < order.length; i++) { cum += w[order[i]]; if (cum >= half) { split = i + 1; break; } }
    split = Math.max(1, Math.min(split, order.length - 1));
    boxes.splice(bestI, 1); // pop + append the two children to the end (mirror gen_man.py's box order)
    boxes.push(order.slice(0, split), order.slice(split));
  }
  const reps = [];
  for (const b of boxes) {
    let ws = 0; const acc = [0, 0, 0];
    for (const idx of b) { ws += w[idx]; for (let c = 0; c < 3; c++) acc[c] += pts[idx][c] * w[idx]; }
    const d = Math.max(ws, 1e-9);
    reps.push([acc[0] / d, acc[1] / d, acc[2] / d]);
  }
  while (reps.length < k) reps.push(reps.length ? reps[reps.length - 1] : [0, 0, 0]);
  return reps.slice(0, k);
}

/** Quantize one scrollable page (rgb W*H*3) to 8 palettes of 16 (4bpp). tilesW = 64 (zoom) or 32
 *  (SCL1). Master median-cut to 128, luma-run seed, ZLLOYD_ITERS of tile re-assignment + palette
 *  refit (dead palettes revived on the worst-served tile). Entry 0 of every palette = page bg. */
function quantizeScrollPage(rgb, W, H, tilesW) {
  const MAXROWS = tilesW === ZTILES_W ? ZMAX_ROWS : S1MAX_ROWS;
  const pixH = H;
  const nrows = Math.max(1, Math.min(Math.ceil(H / 8), MAXROWS));
  const Hpad = nrows * 8;

  // 1. master palette (128) via median-cut over snapped pixels
  const N = W * H;
  const sr = new Uint8Array(N), sg = new Uint8Array(N), sb = new Uint8Array(N);
  const pix = new Array(N);
  for (let i = 0; i < N; i++) {
    const r = snap5(rgb[i * 3]), g = snap5(rgb[i * 3 + 1]), b = snap5(rgb[i * 3 + 2]);
    sr[i] = r; sg[i] = g; sb[i] = b; pix[i] = [r, g, b];
  }
  const mRgb = medianCut(pix, ZPAL_COUNT * ZPAL_SIZE); // 128 reps (snap5'd)
  const mIdx = new Uint8Array(Hpad * W);
  const cache = new Map();
  for (let i = 0; i < N; i++) {
    const key = (sr[i] << 16) | (sg[i] << 8) | sb[i];
    let k = cache.get(key);
    if (k === undefined) { k = nearest(sr[i], sg[i], sb[i], mRgb); cache.set(key, k); }
    mIdx[i] = k;
  }
  const cnt0 = new Float64Array(128);
  for (let i = 0; i < N; i++) cnt0[mIdx[i]]++;
  let bgM = 0;
  { let best = -1; for (let m = 0; m < 128; m++) if (cnt0[m] > best) { best = cnt0[m]; bgM = m; } }
  const bgRgb = mRgb[bgM];
  for (let i = N; i < Hpad * W; i++) mIdx[i] = bgM;

  // 2. tiles row-major (tr, tc); histograms [T][128]
  const T = nrows * tilesW;
  const hist = new Float64Array(T * 128);
  const flat = new Uint8Array(T * 64);
  for (let tr = 0; tr < nrows; tr++) {
    for (let tc = 0; tc < tilesW; tc++) {
      const t = tr * tilesW + tc, hb = t * 128, fb = t * 64;
      for (let py = 0; py < 8; py++) {
        const rowBase = (tr * 8 + py) * W + tc * 8;
        for (let px = 0; px < 8; px++) {
          const m = mIdx[rowBase + px];
          flat[fb + py * 8 + px] = m;
          hist[hb + m] += 1;
        }
      }
    }
  }
  const counts = new Float64Array(128);
  for (let t = 0; t < T; t++) { const hb = t * 128; for (let m = 0; m < 128; m++) counts[m] += hist[hb + m]; }

  // 3. seed 8 palettes: luma-sorted, pixel-count-weighted runs
  const luma = mRgb.map((c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114);
  const bgr = mRgb.map((c) => rgbToBGR555(c[0], c[1], c[2]));
  const order = Array.from({ length: 128 }, (_, i) => i).sort((a, b) => (luma[a] - luma[b]) || (bgr[a] - bgr[b]) || (a - b));
  const cum = new Float64Array(128);
  { let c = 0; for (let i = 0; i < 128; i++) { c += counts[order[i]]; cum[i] = c; } }
  const total = Math.max(cum[127], 1.0);
  const ssLeft = (target) => {
    let lo = 0, hi = 128;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const pal = Array.from({ length: ZPAL_COUNT }, () => Array.from({ length: ZPAL_SIZE }, () => [0, 0, 0]));
  const snapPal = (g) => { for (let c = 0; c < ZPAL_SIZE; c++) pal[g][c] = snap555rgb(pal[g][c][0], pal[g][c][1], pal[g][c][2]); };
  for (let g = 0; g < ZPAL_COUNT; g++) {
    const lo = ssLeft(total * g / ZPAL_COUNT);
    const hi = ssLeft(total * (g + 1) / ZPAL_COUNT) + 1;
    const run = order.slice(lo, Math.min(hi, 128));
    pal[g][0] = [bgRgb[0], bgRgb[1], bgRgb[2]];
    if (run.length) {
      const pts = run.map((m) => mRgb[m]);
      const w = run.map((m) => (m === bgM ? 0 : counts[m]));
      const reps = weightedMedianCut(pts, w, ZPAL_SIZE - 1);
      for (let c = 0; c < ZPAL_SIZE - 1; c++) pal[g][c + 1] = reps[c];
    } else {
      for (let c = 1; c < ZPAL_SIZE; c++) pal[g][c] = [bgRgb[0], bgRgb[1], bgRgb[2]];
    }
    snapPal(g);
  }

  const dist2 = (a, b) => { const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return dr * dr + dg * dg + db * db; };
  const computeCost = () => {
    const cost = new Float64Array(128 * ZPAL_COUNT);
    for (let m = 0; m < 128; m++) for (let g = 0; g < ZPAL_COUNT; g++) {
      let mind = Infinity;
      for (let c = 0; c < ZPAL_SIZE; c++) { const dd = dist2(mRgb[m], pal[g][c]); if (dd < mind) mind = dd; }
      cost[m * ZPAL_COUNT + g] = mind;
    }
    return cost;
  };
  const assignTiles = (cost) => {
    const grp = new Int32Array(T);
    const served = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      const hb = t * 128;
      let bestG = 0, bestC = Infinity;
      for (let g = 0; g < ZPAL_COUNT; g++) {
        let tc = 0;
        for (let m = 0; m < 128; m++) { const h = hist[hb + m]; if (h) tc += h * cost[m * ZPAL_COUNT + g]; }
        if (tc < bestC) { bestC = tc; bestG = g; }
      }
      grp[t] = bestG; served[t] = bestC;
    }
    return { grp, served };
  };

  // 4. Lloyd
  let grp = new Int32Array(T);
  for (let it = 0; it < ZLLOYD_ITERS; it++) {
    const cost = computeCost();
    const a = assignTiles(cost);
    grp = a.grp;
    const served = a.served;
    const alive = new Array(ZPAL_COUNT).fill(false);
    for (let t = 0; t < T; t++) alive[grp[t]] = true;
    for (let g = 0; g < ZPAL_COUNT; g++) {
      if (alive[g]) continue;
      let tt = 0, bestv = -Infinity;
      for (let t = 0; t < T; t++) if (served[t] > bestv) { bestv = served[t]; tt = t; }
      if (served[tt] <= 0) break;
      grp[tt] = g; served[tt] = 0;
    }
    for (let g = 0; g < ZPAL_COUNT; g++) {
      const w = new Float64Array(128);
      let any = false;
      for (let t = 0; t < T; t++) if (grp[t] === g) { any = true; const hb = t * 128; for (let m = 0; m < 128; m++) w[m] += hist[hb + m]; }
      if (!any) continue;
      w[bgM] = 0;
      pal[g][0] = [bgRgb[0], bgRgb[1], bgRgb[2]];
      const reps = weightedMedianCut(mRgb, Array.from(w), ZPAL_SIZE - 1);
      for (let c = 0; c < ZPAL_SIZE - 1; c++) pal[g][c + 1] = reps[c];
      snapPal(g);
    }
  }

  // 5. emit through a per-(palette,master) lut
  { const cost = computeCost(); grp = assignTiles(cost).grp; }
  const lut = new Uint8Array(ZPAL_COUNT * 128);
  for (let g = 0; g < ZPAL_COUNT; g++) for (let m = 0; m < 128; m++) {
    let bc = 0, bd = Infinity;
    for (let c = 0; c < ZPAL_SIZE; c++) { const dd = dist2(mRgb[m], pal[g][c]); if (dd < bd) { bd = dd; bc = c; } }
    lut[g * 128 + m] = bc;
  }
  const idx4 = new Uint8Array(T * 64);
  for (let t = 0; t < T; t++) { const g = grp[t], fb = t * 64; for (let p = 0; p < 64; p++) idx4[fb + p] = lut[g * 128 + flat[fb + p]]; }
  const attr = new Uint8Array(T);
  for (let t = 0; t < T; t++) attr[t] = (grp[t] << 2) & 0xff;
  const pal555 = new Uint16Array(128);
  for (let g = 0; g < ZPAL_COUNT; g++) for (let c = 0; c < ZPAL_SIZE; c++) {
    const v = pal[g][c];
    pal555[g * ZPAL_SIZE + c] = rgbToBGR555(Math.round(v[0]), Math.round(v[1]), Math.round(v[2]));
  }
  return { idx4, attr, pal555, nrows, pixH };
}

function emitScrollPage(q, tilesW) {
  const palB = new Uint8Array(ZPAL_BYTES);
  for (let i = 0; i < 128; i++) { palB[i * 2] = q.pal555[i] & 0xff; palB[i * 2 + 1] = (q.pal555[i] >> 8) & 0xff; }
  return { palB, attrB: q.attr, tileB: encodeTiles4(q.idx4, q.nrows * tilesW) };
}

const secpad = (n) => Math.ceil(n / SECTOR) * SECTOR;

/**
 * Pure encode -> scrollable `.man`. pages (width===PAGE_W) [+ pages2x if zoom, same length,
 * width===2*PAGE_W, height===2x the matching 1x page, enforce via enforceExact2x]. Mirrors
 * gen_man.py's encode() / the gamedb man.ts (they must be byte-identical).
 */
export function buildManFile(pages, opts = {}) {
  const { title = '', slug = null, zoom = false, pages2x = null, sharpen = true } = opts;
  if (!pages || !pages.length) throw new Error('no pages to encode');
  if (pages.length > 255) throw new Error('too many pages (npages is a u8)');
  if (zoom && (!pages2x || pages2x.length !== pages.length)) {
    throw new Error('zoom requires pages2x with the same page count as pages');
  }

  const index = [];   // {page,block,contentRows}
  const zpages = [];  // {palB,attrB,tileB,nrows,pixH,firstBlock,pdfPage,nblk}
  const zmap = [];    // {zp,zy}
  const s1pages = []; // {palB,attrB,tileB,nrows,pixH,pdfPage}

  pages.forEach((page, pi) => {
    if (page.width !== PAGE_W) throw new Error(`page ${pi}: width ${page.width} !== PAGE_W`);
    const page2x = zoom ? pages2x[pi] : null;
    if (zoom && page2x.width !== PAGE_W * 2) throw new Error(`page2x ${pi}: width ${page2x.width} !== 2*PAGE_W`);
    // seam-lock precondition (run enforceExact2x first). A mismatch would mis-chunk the file.
    if (zoom && page2x.height !== page.height * 2) throw new Error(`page2x ${pi}: height ${page2x.height} !== 2*${page.height} (run enforceExact2x first)`);
    const bands = [...cutBandsWithBounds(page)]; // seams on the original page (sharpen-independent)
    const gb0 = index.length;
    bands.forEach((bd, bi) => index.push({ page: pi, block: bi, contentRows: Math.ceil(bd.contentH / 8) }));
    if (!zoom) return;
    const sq1 = sharpen ? unsharpPage(page) : page; // quantizer inputs only
    const sq2 = sharpen ? unsharpPage(page2x) : page2x;

    // Zoom (2x): whole 2x page, split into <=ZCHUNK_PX-tall chunks
    const H2 = page2x.height;
    const nchunks = Math.max(1, Math.ceil(H2 / ZCHUNK_PX));
    const zp0 = zpages.length;
    for (let j = 0; j < nchunks; j++) {
      const y0c = j * ZCHUNK_PX, y1c = Math.min((j + 1) * ZCHUNK_PX, H2);
      const chunk = cropRows(sq2, y0c, y1c);
      const q = quantizeScrollPage(chunk.rgb, chunk.width, chunk.height, ZTILES_W);
      zpages.push({ ...emitScrollPage(q, ZTILES_W), nrows: q.nrows, pixH: q.pixH, firstBlock: null, pdfPage: pi, nblk: null });
    }
    bands.forEach((bd, bi) => {
      const y2 = 2 * bd.y0, j = Math.min(Math.floor(y2 / ZCHUNK_PX), nchunks - 1);
      zmap.push({ zp: zp0 + j, zy: y2 - j * ZCHUNK_PX });
      const pg = zpages[zp0 + j];
      if (pg.firstBlock === null) pg.firstBlock = gb0 + bi;
    });
    for (let j = 0; j < nchunks; j++) if (zpages[zp0 + j].firstBlock === null) zpages[zp0 + j].firstBlock = gb0;
    for (let j = 0; j < nchunks; j++) {
      let n = 0;
      const start = zmap.length - bands.length;
      for (let bi = 0; bi < bands.length; bi++) if (zmap[start + bi].zp === zp0 + j) n++;
      zpages[zp0 + j].nblk = Math.max(1, n);
    }
    // SCL1 (1x): same page at 256px, split into S1CHUNK_ROWS-tall chunks, half a zoom chunk, so
    // the SCL1 and zoom sections always cut into the same page count (the viewer pairs them 1:1).
    const H1 = page.height;
    const c1 = Math.max(1, Math.ceil(H1 / (S1CHUNK_ROWS * 8)));
    for (let j = 0; j < c1; j++) {
      const y0c = j * S1CHUNK_ROWS * 8, y1c = Math.min((j + 1) * S1CHUNK_ROWS * 8, H1);
      const chunk = cropRows(sq1, y0c, y1c);
      const q = quantizeScrollPage(chunk.rgb, chunk.width, chunk.height, S1TILES_W);
      s1pages.push({ ...emitScrollPage(q, S1TILES_W), nrows: q.nrows, pixH: q.pixH, pdfPage: pi });
    }
  });

  const nblocks = index.length;
  if (nblocks > 0xffff) throw new Error('too many blocks (nblocks is a u16)');
  const nzp = zpages.length, ns1 = s1pages.length;
  const z0 = HEADER_SIZE + nblocks * INDEX_ENTRY;
  const headLen = z0 + (zoom ? 2 * ZHDR_BYTES + (nzp + ns1) * ZDIR_ENTRY + nblocks * ZMAP_ENTRY : 0);
  const bodyStart = Math.ceil(headLen / SECTOR) * SECTOR;

  // body offsets
  let off = bodyStart;
  const zdir = [], s1dir = [];
  let nzrows = 0;
  for (const pg of zpages) {
    const palOfs = off; off += ZPAL_STRIDE;
    const attrOfs = off; off += secpad(pg.attrB.length);
    const tileOfs = off; off += pg.tileB.length;
    zdir.push({ tileOfs, attrOfs, palOfs, nrows: pg.nrows, pixH: pg.pixH, firstBlock: pg.firstBlock ?? 0, pdfPage: pg.pdfPage, nblk: pg.nblk ?? 1 });
    nzrows += pg.nrows;
  }
  let s1rows = 0;
  for (const pg of s1pages) {
    const palOfs = off; off += ZPAL_STRIDE;
    const attrOfs = off; off += secpad(pg.attrB.length);
    const tileOfs = off; off += pg.tileB.length;
    s1dir.push({ tileOfs, attrOfs, palOfs, nrows: pg.nrows, pixH: pg.pixH, pdfPage: pg.pdfPage });
    s1rows += pg.nrows;
  }

  const totalBytes = off;
  const bytes = new Uint8Array(totalBytes);
  const dv = new DataView(bytes.buffer);

  // header
  bytes[0] = 0x4d; bytes[1] = 0x41; bytes[2] = 0x4e; bytes[3] = 0x4c; // "manl"
  bytes[4] = 1;                 // ver, fixed, never bump pre-release
  bytes[5] = 8;                 // bpp (legacy magic gate)
  bytes[6] = pages.length;      // npages
  bytes[7] = zoom ? FLAG_ZOOM2 : 0;
  dv.setUint16(8, PAGE_W, true);
  dv.setUint16(10, BAND_H, true);
  dv.setUint16(12, nblocks, true);
  dv.setUint16(14, 0, true);    // zoom_nblocks retired
  bytes.set(slug != null ? slugTitleBytes(slug) : fontEncodeTitle(title), TITLE_OFS);

  // 1x index (bodies retired: offset=0, rsvd=0)
  index.forEach((e, i) => {
    const o = HEADER_SIZE + i * INDEX_ENTRY;
    dv.setUint32(o, 0, true);
    bytes[o + 4] = e.page;
    bytes[o + 5] = e.block;
    bytes[o + 6] = e.contentRows;
    bytes[o + 7] = 0;
  });

  if (zoom) {
    const zmaxZ = zpages.reduce((m, p) => Math.max(m, p.nrows), 0);
    const zmaxS = s1pages.reduce((m, p) => Math.max(m, p.nrows), 0);
    const zpagedir = z0 + 2 * ZHDR_BYTES;
    const zblockmap = zpagedir + nzp * ZDIR_ENTRY;
    const s1pagedir = zblockmap + nblocks * ZMAP_ENTRY;
    const writeSub = (base, magic, tilesW, attrStride, rowBytes, nz, zmax, pagedirOfs, npg, blockmapOfs) => {
      for (let i = 0; i < 4; i++) bytes[base + i] = magic.charCodeAt(i);
      bytes[base + 4] = 4; // zbpp
      bytes[base + 5] = ZPAL_COUNT;
      bytes[base + 6] = tilesW;
      bytes[base + 7] = attrStride;
      dv.setUint16(base + 8, rowBytes, true);
      dv.setUint16(base + 10, ZPAL_BYTES, true);
      dv.setUint32(base + 12, nz, true);
      dv.setUint16(base + 16, zmax, true);
      dv.setUint16(base + 18, 0, true);
      dv.setUint32(base + 20, pagedirOfs, true);
      dv.setUint16(base + 24, npg, true);
      dv.setUint16(base + 26, 0, true);
      dv.setUint32(base + 28, blockmapOfs, true);
    };
    writeSub(z0, 'ZOOM', ZTILES_W, ZATTR_STRIDE, ZROW_BYTES, nzrows, zmaxZ, zpagedir, nzp, zblockmap);
    writeSub(z0 + ZHDR_BYTES, 'SCL1', S1TILES_W, S1ATTR_STRIDE, S1ROW_BYTES, s1rows, zmaxS, s1pagedir, ns1, 0);
    zdir.forEach((e, i) => {
      const o = zpagedir + i * ZDIR_ENTRY;
      dv.setUint32(o, e.tileOfs, true);
      dv.setUint32(o + 4, e.attrOfs, true);
      dv.setUint32(o + 8, e.palOfs, true);
      dv.setUint16(o + 12, e.nrows, true);
      dv.setUint16(o + 14, e.pixH, true);
      dv.setUint16(o + 16, e.firstBlock, true);
      bytes[o + 18] = e.pdfPage & 0xff;
      bytes[o + 19] = e.nblk & 0xff;
    });
    zmap.forEach((e, i) => {
      const o = zblockmap + i * ZMAP_ENTRY;
      dv.setUint16(o, e.zp, true);
      dv.setUint16(o + 2, e.zy, true);
    });
    s1dir.forEach((e, i) => {
      const o = s1pagedir + i * ZDIR_ENTRY;
      dv.setUint32(o, e.tileOfs, true);
      dv.setUint32(o + 4, e.attrOfs, true);
      dv.setUint32(o + 8, e.palOfs, true);
      dv.setUint16(o + 12, e.nrows, true);
      dv.setUint16(o + 14, e.pixH, true);
      dv.setUint16(o + 16, 0, true);
      bytes[o + 18] = e.pdfPage & 0xff;
      bytes[o + 19] = 1;
    });
  }

  // bodies
  const writeBody = (pg, dir) => { bytes.set(pg.palB, dir.palOfs); bytes.set(pg.attrB, dir.attrOfs); bytes.set(pg.tileB, dir.tileOfs); };
  zpages.forEach((pg, i) => writeBody(pg, zdir[i]));
  s1pages.forEach((pg, i) => writeBody(pg, s1dir[i]));

  return { bytes, npages: pages.length, nblocks, zoomNblocks: 0, totalBytes };
}

/* ---------- browser rendering adapters (dom-only; not used by the Node cross-validation test) ---------- */

let _pdfjsReady = null;
/** Lazily import pdfjs-dist + point it at the self-hosted worker (scripts/setup-pdfjs.sh stages it
 *  into public/pdfjs/, same pattern as @ffmpeg/ffmpeg's self-hosted core, no CDN, CSP-safe).
 *  NOTE: the worker is staged with a `.js` extension (its content is an es module, loaded via
 *  `new Worker(url, {type:'module'})`). We deliberately avoid `.mjs`: the prod server has no MIME
 *  mapping for `.mjs` and serves it as `application/octet-stream`, which, with `X-Content-Type-Options:
 *  nosniff`. Makes the browser refuse the module ("Failed to fetch dynamically imported module").
 *  `.js` is already served as `text/javascript` (the app bundle proves it), so this Just Works
 *  without touching the web server. */
function ensurePdfjs() {
  if (_pdfjsReady) return _pdfjsReady;
  _pdfjsReady = import('pdfjs-dist').then((pdfjsLib) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.js', document.baseURI).href;
    return pdfjsLib;
  });
  return _pdfjsReady;
}

/** Render an ImageData-shaped canvas region into a tightly-packed RGB {rgb,width,height} page
 *  (drops alpha; PDF/scan sources are treated as opaque over a white page background). */
function ctxToRgbPage(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let p = 0; p < w * h; p++) { rgb[p * 3] = d[p * 4]; rgb[p * 3 + 1] = d[p * 4 + 1]; rgb[p * 3 + 2] = d[p * 4 + 2]; }
  return { rgb, width: w, height: h };
}

/** Render every page of a PDF (File/Blob/Uint8Array) fit-to-width `widthPx`, one {rgb,width,height}
 *  per page. Mirrors gen_man.py's `pdftoppm -scale-to-x <widthPx> -scale-to-y -1`. */
export async function renderPdfPages(fileOrBytes, widthPx = PAGE_W) {
  const pdfjsLib = await ensurePdfjs();
  const data = fileOrBytes instanceof Uint8Array ? fileOrBytes : new Uint8Array(await fileOrBytes.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  if (doc.numPages > 255) throw new Error('PDF has >255 pages (npages is a u8)');
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: widthPx / base.width });
    const vw = Math.max(1, Math.round(viewport.width)), vh = Math.max(1, Math.round(viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, vw, vh); // PDF transparency -> white page bg
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (vw === widthPx) { pages.push(ctxToRgbPage(ctx, vw, vh)); continue; }
    const fh = Math.max(1, Math.round(vh * widthPx / vw));
    const scaled = document.createElement('canvas');
    scaled.width = widthPx; scaled.height = fh;
    const sctx = scaled.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, widthPx, fh);
    pages.push(ctxToRgbPage(sctx, widthPx, fh));
  }
  return pages;
}

/** Decode+fit-width a list of page image files (PNG/JPG, one per page, CALLER-ORDERED) into
 *  {rgb,width,height} pages. */
export async function renderImagePages(files, widthPx = PAGE_W) {
  if (files.length > 255) throw new Error('too many page images (npages is a u8)');
  const pages = [];
  for (const file of files) {
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
    let img;
    try { img = await createImageBitmap(new Blob([bytes])); }
    catch (e) { throw new Error('page image decode failed: ' + (e?.message ?? e)); }
    const h = Math.max(1, Math.round((img.height * widthPx) / img.width));
    let scaled = null;
    try { scaled = await createImageBitmap(img, { resizeWidth: widthPx, resizeHeight: h, resizeQuality: 'high' }); }
    catch { /* fall back to a plain canvas scale below */ }
    const canvas = document.createElement('canvas');
    canvas.width = widthPx; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, widthPx, h);
    if (scaled) { ctx.drawImage(scaled, 0, 0); scaled.close?.(); }
    else { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, widthPx, h); }
    img.close?.();
    pages.push(ctxToRgbPage(ctx, widthPx, h));
  }
  return pages;
}

/** Seam-lock enforcement: force each 2x page to be exactly double the matching 1x page's shape. */
function enforceExact2x(pages1x, pages2x) {
  return pages1x.map((p1, i) => {
    const p2 = pages2x[i];
    const targetW = p1.width * 2, targetH = p1.height * 2;
    if (p2.width === targetW && p2.height === targetH) return p2;
    const src = document.createElement('canvas');
    src.width = p2.width; src.height = p2.height;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(p2.width, p2.height);
    for (let i2 = 0; i2 < p2.width * p2.height; i2++) {
      img.data[i2 * 4] = p2.rgb[i2 * 3]; img.data[i2 * 4 + 1] = p2.rgb[i2 * 3 + 1];
      img.data[i2 * 4 + 2] = p2.rgb[i2 * 3 + 2]; img.data[i2 * 4 + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const dst = document.createElement('canvas');
    dst.width = targetW; dst.height = targetH;
    const dctx = dst.getContext('2d', { willReadFrequently: true });
    dctx.imageSmoothingEnabled = true; dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(src, 0, 0, targetW, targetH);
    return ctxToRgbPage(dctx, targetW, targetH);
  });
}

/** document type key → slug id (1..5), or 0 when unknown (mirror of the gamedb MANUAL_TYPE_SLUG_ID). */
export function slugIdOfType(type) {
  const i = MANUAL_SLUG_TYPES.indexOf(type);
  return i >= 0 ? i + 1 : 0;
}

/** Per-page halving factors for the whole document (mirror of the gamedb man-raster.ts). */
function spreadFactorsFor(pages, spread) {
  let ks = pages.map((p) => (spread === 'off' ? 0 : spreadSplitFactor(p.width, p.height)));
  if (spread === 'on') ks = ks.map((k) => Math.max(1, k));
  return ks;
}

/** Slice a page rendered at 256<<k / 512<<k into its 2^k equal columns (repeated halving keeps the
 *  widths even all the way down: 1024 -> 512 -> 256). */
function sliceSpread(page, k) {
  let out = [page];
  for (let j = 0; j < k; j++) out = out.flatMap((pg) => splitSpreadPage(pg));
  return out;
}

/** The distinct source widths the render passes must produce for these factors. */
function spreadWidthsFor(ks, zoom) {
  const widths = new Set();
  for (const k of ks) {
    if (k > 0) widths.add(PAGE_W << k); // k=0 reuses the base 256 render
    if (zoom) widths.add((PAGE_W * 2) << k);
  }
  return [...widths].sort((a, b) => a - b);
}

/** Assemble the final (pages, pages2x) out of the per-width renders (mirror of the gamedb
 *  man-raster.ts assembly). A split page contributes its pieces left-to-right. Each piece is
 *  (a column of) one printed page, so the emitted sequence follows the book's own pagination. */
function assembleSpreadPages(p256, renders, ks, zoom) {
  const pages = [];
  const pages2x = zoom ? [] : null;
  for (let i = 0; i < p256.length; i++) {
    const k = ks[i];
    if (k === 0) {
      pages.push(p256[i]);
      if (zoom) pages2x.push(renders.get(PAGE_W * 2)[i]);
    } else {
      pages.push(...sliceSpread(renders.get(PAGE_W << k)[i], k));
      if (zoom) pages2x.push(...sliceSpread(renders.get((PAGE_W * 2) << k)[i], k));
    }
  }
  if (pages.length > 255) {
    throw new Error(`spread split produces ${pages.length} pages (npages is a u8, max 255) — use spread:'off' or trim the PDF`);
  }
  return { pages, pages2x: zoom ? enforceExact2x(pages, pages2x) : null };
}

/** End-to-end: PDF file -> `.man` bytes (renders + encodes). Pass `slug` (1..5) to bake the document
 *  Type into the header exactly like the gamedb; `title` is the legacy free-text fallback. `spread`
 *  ('auto'|'on'|'off', default 'auto') splits spread scans into one emitted page per piece,
 *  Recursively (cover wraps / fold-outs are halved until below SPREAD_AR, max SPREAD_MAX_SPLITS). */
export async function buildManFromPdf(pdfFile, { slug, title, zoom = false, spread = 'auto' } = {}) {
  const p256 = await renderPdfPages(pdfFile, PAGE_W);
  const ks = spreadFactorsFor(p256, spread);
  const renders = new Map();
  for (const w of spreadWidthsFor(ks, zoom)) renders.set(w, await renderPdfPages(pdfFile, w));
  const { pages, pages2x } = assembleSpreadPages(p256, renders, ks, zoom);
  return buildManFile(pages, { slug, title: title ?? deriveTitle(pdfFile?.name ?? ''), zoom, pages2x });
}

/** End-to-end: ordered page image files -> `.man` bytes. `slug`/`title`/`spread` as in buildManFromPdf. */
export async function buildManFromImages(files, { slug, title, zoom = false, spread = 'auto' } = {}) {
  const p256 = await renderImagePages(files, PAGE_W);
  const ks = spreadFactorsFor(p256, spread);
  const renders = new Map();
  for (const w of spreadWidthsFor(ks, zoom)) renders.set(w, await renderImagePages(files, w));
  const { pages, pages2x } = assembleSpreadPages(p256, renders, ks, zoom);
  return buildManFile(pages, { slug, title: title ?? deriveTitle(files?.[0]?.name ?? ''), zoom, pages2x });
}
