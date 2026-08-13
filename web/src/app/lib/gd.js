// DirectColor `.gd`, reader only (back-compat).
//
// The Manager retired `.gd` generation: the ficha cover/snapshot/preview are now built by the JS
// bandpal/ffmpeg encoder (`.gcv`/`.gss`/`.fmv`), and covers (`.cov`) by the covgen WASM. The only
// `.gd` code left here decodes a `.gd` that's already on the card (older builds wrote one) so the
// snapshot tile / scan can still read it. `fetchBytes` is a shared helper used by library-store;
// `loadImage` has no caller left since cov.js stopped resampling in the browser.
//
// .gd layout (LE): "GD",ver=1,flags=0,w_tiles=32,h_tiles=16,num_tiles(u16),resv(4),
//   tilemap[32*16] u16 (tile & 0x3FF), then num_tiles * 64-byte 8bpp SNES planar tiles.

// Snapshot/cover regions inside the 256x128 band (must match the firmware's GI_* boxes). Used by the
// decoders to carve the cover + snapshot out of a legacy `.gd`.
export const COVER_BOX = { x: 8, y: 0, w: 136, h: 128 };
export const SHOT_BOX = { x: 152, y: 24, w: 96, h: 72 };

/** 8-bit DirectColor byte BBGGGRRR (3-3-2) → [r,g,b] 0..255. */
export function dcToRgb(v) {
  const R = v & 0x07;
  const G = (v >> 3) & 0x07;
  const B = (v >> 6) & 0x03;
  return [Math.floor((R * 255) / 7), Math.floor((G * 255) / 7), Math.floor((B * 255) / 3)];
}

/** Load an image URL as an HTMLImageElement (CORS-enabled so the canvas isn't tainted). Shared with
 *  cov.js (decode raw bytes → <img> for the cover thumbnail). */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load/CORS failed: ' + url));
    img.src = url;
  });
}

/** Fetch image-file bytes, retrying transient failures with exponential backoff (CDN blips). Default
 *  5 attempts over ~6s. Each attempt is bounded by `timeoutMs` via an AbortController so a stalled
 *  connection can't hang a batch. Throws after all fail. (Shared util, library-store uses it for the
 *  curated-screenshot fetch.) */
export async function fetchBytes(url, attempts = 5, timeoutMs = 15000) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.min(4000, 400 * 2 ** (attempt - 1))));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // `no-referrer`: the CDN sits behind Cloudflare hotlink protection, which 403s an image request
      // whose Referer is a foreign origin (jpg/png/gif only, that's why .s2pkg/.man.zst sail through).
      // Sending no Referer at all is always allowed, so covers/screenshots load from any origin: the
      // dev server on localhost, a staging host, or the app served from its own domain.
      const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer' });
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
      lastErr = `HTTP ${r.status}`;
      console.warn(`[gd] fetch ${lastErr} (attempt ${attempt + 1}/${attempts}) ${url}`);
    } catch (err) {
      lastErr = ctl.signal.aborted ? `timeout after ${timeoutMs}ms` : (err?.message ?? String(err));
      console.warn(`[gd] fetch retry ${attempt + 1}/${attempts}:`, lastErr);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetch failed after ${attempts} attempts (${lastErr}): ${url}`);
}

/* ---------- decoder (read what an older build wrote to the card) ---------- */

/** Decode a `.gd` Uint8Array → { rgb (Uint8 W*H*3), width, height }. */
export function decodeGd(bytes) {
  if (bytes[0] !== 0x47 || bytes[1] !== 0x44) throw new Error('not a .gd file');
  const wT = bytes[4], hT = bytes[5];
  const nT = bytes[6] | (bytes[7] << 8);
  const W = wT * 8, H = hT * 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tmOff = 12;
  const tOff = 12 + wT * hT * 2;
  const dc = new Uint8Array(W * H);
  for (let ty = 0; ty < hT; ty++) {
    for (let tx = 0; tx < wT; tx++) {
      let tIdx = dv.getUint16(tmOff + (ty * wT + tx) * 2, true) & 0x3ff;
      if (tIdx >= nT) tIdx = 0; // guard
      const to = tOff + tIdx * 64;
      for (let pp = 0; pp < 4; pp++) {
        for (let row = 0; row < 8; row++) {
          const lo = bytes[to + (pp * 8 + row) * 2];
          const hi = bytes[to + (pp * 8 + row) * 2 + 1];
          for (let col = 0; col < 8; col++) {
            const bL = (lo >> (7 - col)) & 1;
            const bH = (hi >> (7 - col)) & 1;
            dc[(ty * 8 + row) * W + (tx * 8 + col)] |= (bL << (pp * 2)) | (bH << (pp * 2 + 1));
          }
        }
      }
    }
  }
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < dc.length; i++) {
    const [r, g, b] = dcToRgb(dc[i]);
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  return { rgb, width: W, height: H };
}

/** A box region of an RGB plane → a PNG data URL (for <img>). */
function rgbRegionDataUrl(rgb, fullW, box) {
  const canvas = document.createElement('canvas');
  canvas.width = box.w;
  canvas.height = box.h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(box.w, box.h);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const sp = ((box.y + y) * fullW + (box.x + x)) * 3;
      const dp = (y * box.w + x) * 4;
      img.data[dp] = rgb[sp]; img.data[dp + 1] = rgb[sp + 1]; img.data[dp + 2] = rgb[sp + 2]; img.data[dp + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** True if a box region is effectively empty, i.e. (near-)uniformly a single colour.
 *  A cover-only `.gd` leaves the snapshot box as a solid dark fill (not necessarily pure
 *  black, often a dark DirectColor value), so a brightness threshold isn't enough. We
 *  bucket colours at 4 bits/channel and treat the region as blank when one bucket covers
 *  ≥96% of the pixels (a real screenshot has many colours). */
function regionIsBlank(rgb, fullW, box) {
  const counts = new Map();
  const total = box.w * box.h;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const sp = ((box.y + y) * fullW + (box.x + x)) * 3;
      const key = ((rgb[sp] >> 4) << 8) | ((rgb[sp + 1] >> 4) << 4) | (rgb[sp + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let top = 0;
  for (const c of counts.values()) if (c > top) top = c;
  return top / total >= 0.96;
}

/** True if a card `.gd` holds a real (non-blank) snapshot in its SHOT_BOX. Cheap, decodes the plane
 *  and color-buckets the shot region only (no canvas/dataURL), so it's safe to run during the probe. */
export function gdHasSnapshot(bytes) {
  try {
    const { rgb, width } = decodeGd(bytes);
    return !regionIsBlank(rgb, width, SHOT_BOX);
  } catch {
    return false;
  }
}

/** Decode a card `.gd` → { coverUrl, snapshotUrl } data URLs (the COVER_BOX + SHOT_BOX regions).
 *  Blank (near-uniform) regions return null so callers can show a real "missing" state. */
export function decodeGdRegions(bytes) {
  const { rgb, width } = decodeGd(bytes);
  return {
    coverUrl: regionIsBlank(rgb, width, COVER_BOX) ? null : rgbRegionDataUrl(rgb, width, COVER_BOX),
    snapshotUrl: regionIsBlank(rgb, width, SHOT_BOX) ? null : rgbRegionDataUrl(rgb, width, SHOT_BOX),
  };
}
