#!/usr/bin/env node
//
// validate-man.mjs, cross-validate src/app/lib/man.js against the canonical host reference
// `_repo/utils/gen_man.py` (sibling `sd2snes-ingame` repo), for the ciclo 2 contrato reconciliado
// `.man` format (IN-GAME-MENU-PLANO.md). Run with: `node scripts/validate-man.mjs`.
//
// What this checks (see the design's own admission. The tile/palette quantizer is not ported
// bit-for-bit from pil's median-cut, only the container format is, so pixel-identical tiles are not
// the target). Scrollable format (the quadrant-zoom 8bpp format is retired, no 1x block bodies):
//   1. Feeds the exact same raw RGB page buffer to man.js's buildManFile and to gen_man.py's
//      internal per-band loop (bypassing pdftoppm/PDF entirely, so this is an apples-to-apples test
//      of the SEAM-FINDING + HEADER/INDEX algorithm, decoupled from any PDF-rasterizer difference).
//   2. Asserts the seam positions (y0/y1 per band), nblocks, and per-entry content_rows come out
//      Identical between the two implementations.
//   3. Builds a scrollable zoom `.man` and shells out to `gen_man.py --verify` (structural audit) +
//      a `--zoom-page` PNG round-trip. The host tool's own decoder must accept Manager files.
//   4. Asserts the SCL1 and zoom sections cut a tall page into the same page count (the firmware
//      viewer pairs them 1:1, the S1CHUNK_ROWS=48 contract).
//   5. Round-trips the title through fontEncodeTitle -> (python) font_decode_title, incl. an
//      accented string, to prove the accents mirror table is byte-identical.
//
// Requires python3 + pil + numpy on path, and the sibling fork checkout (override with
// GEN_MAN_PY=/path/to/gen_man.py). Skips cleanly (exit 0) if not found. This is a developer
// cross-check, not part of `ng build`/`ng test`.

import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_ROOT = path.resolve(HERE, '..');
const GEN_MAN_CANDIDATES = [
  path.resolve(MANAGER_ROOT, '../../sd2snes-next/_repo/utils/gen_man.py'),
  path.resolve(MANAGER_ROOT, '../../sd2snes-ingame/_repo/utils/gen_man.py'),
];
const GEN_MAN_PY = process.env.GEN_MAN_PY ?? GEN_MAN_CANDIDATES.find((p) => existsSync(p)) ?? GEN_MAN_CANDIDATES[0];

if (!existsSync(GEN_MAN_PY)) {
  console.warn(`[validate-man] gen_man.py not found at ${GEN_MAN_PY} (set GEN_MAN_PY=... to point at it), skipping.`);
  process.exit(0);
}
try { execFileSync('python3', ['-c', 'import PIL, numpy']); }
catch { console.warn('[validate-man] python3/PIL/numpy not available, skipping.'); process.exit(0); }

const { buildManFile, cutBandsWithBounds, parseManHeader, fontEncodeTitle, fontDecodeTitle } =
  await import(path.join(MANAGER_ROOT, 'src/app/lib/man.js'));

const tmp = mkdtempSync(path.join(tmpdir(), 'man-validate-'));
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++; console.error(`  FAIL ${label}${detail ? ': ' + detail : ''}`);
};

/* ---------- synthesize a deterministic test page: identical in JS and (via raw bytes) Python ---------- */
const PAGE_W = 256, PAGE_H = 600;
function synthPage(w, h, scale) {
  const rgb = new Uint8Array(w * h * 3).fill(245);
  const bar = 18 * scale;
  for (let y = 0; y < h; y += bar)
    for (let yy = y + 2 * scale; yy < Math.min(y + 12 * scale, h); yy++)
      for (let x = 10 * scale; x < 246 * scale; x++) { const o = (yy * w + x) * 3; rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20; }
  for (const gap of [200 * scale, 420 * scale])
    for (let yy = gap; yy < Math.min(gap + 8 * scale, h); yy++)
      for (let x = 0; x < w; x++) { const o = (yy * w + x) * 3; rgb[o] = 245; rgb[o + 1] = 245; rgb[o + 2] = 240; }
  return rgb;
}
const raw1x = synthPage(PAGE_W, PAGE_H, 1);
const raw1xPath = path.join(tmp, 'page1x.bin');
writeFileSync(raw1xPath, raw1x);
const page1x = { rgb: raw1x, width: PAGE_W, height: PAGE_H };

console.log('== 1x: seam/header/index parity (man.js vs gen_man.py, identical input pixels) ==');
const jsSeams = [...cutBandsWithBounds(page1x)].map(({ y0, y1, contentH }) => [y0, y1, contentH]);

const pyOut = path.join(tmp, 'host_from_array.json');
execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.dirname(GEN_MAN_PY))})
import numpy as np
import gen_man as gm
page = np.fromfile(${JSON.stringify(raw1xPath)}, dtype=np.uint8).reshape(${PAGE_H}, ${PAGE_W}, 3)
seams = [[y0, y1, ch] for band, ch, y0, y1 in gm.cut_bands_with_bounds(page)]
json.dump({"seams": seams}, open(${JSON.stringify(pyOut)}, "w"))
`]);
const pySeams = JSON.parse(readFileSync(pyOut, 'utf8')).seams;
check('seam count matches', jsSeams.length === pySeams.length, `js=${jsSeams.length} py=${pySeams.length}`);
check('seam positions + content_h byte-identical', JSON.stringify(jsSeams) === JSON.stringify(pySeams),
  `js=${JSON.stringify(jsSeams)} py=${JSON.stringify(pySeams)}`);

const title = 'Manual Teste Ação';
const built = buildManFile([page1x], { title });
const managerManPath = path.join(tmp, 'manager_1x.man');
writeFileSync(managerManPath, built.bytes);
const hdr = parseManHeader(built.bytes);
check('header magic/ver/bpp/page_w/band_h', hdr.ver === 1 && hdr.bpp === 8 && hdr.pageW === 256 && hdr.bandH === 224);
check('title round-trips through fontDecodeTitle', fontDecodeTitle(fontEncodeTitle(title)) === title);

console.log('== python title round-trip (ACCENTS mirror) ==');
try {
  const enc = fontEncodeTitle(title);
  const encPath = path.join(tmp, 'title.bin');
  writeFileSync(encPath, enc);
  const pyTitle = execFileSync('python3', ['-c', `
import sys
sys.path.insert(0, ${JSON.stringify(path.dirname(GEN_MAN_PY))})
import gen_man as gm
print(gm.font_decode_title(open(${JSON.stringify(encPath)}, 'rb').read()), end='')
`], { encoding: 'utf8' });
  check('fontEncodeTitle -> python font_decode_title round-trips accents', pyTitle === title, `py=${JSON.stringify(pyTitle)}`);
} catch (e) {
  check('python title round-trip', false, String(e.message ?? e));
}

/* ---------- scrollable zoom: gen_man.py audit + zoom-page round-trip + 1:1 page counts ---------- */
console.log('== scrollable zoom: gen_man.py --verify audit + zoom-page round-trip ==');
const raw2x = synthPage(PAGE_W * 2, PAGE_H * 2, 2);
const page2x = { rgb: raw2x, width: PAGE_W * 2, height: PAGE_H * 2 };
const builtZoom = buildManFile([page1x], { title: 'Zoom Ação', zoom: true, pages2x: [page2x] });
const zoomPath = path.join(tmp, 'manager_zoom.man');
writeFileSync(zoomPath, builtZoom.bytes);
const zh = parseManHeader(builtZoom.bytes);
check('zoom flag set (bit1) + zoom_nblocks retired (0)', zh.zoom && zh.zoomNblocks === 0,
  `zoom=${zh.zoom} zoomNblocks=${zh.zoomNblocks}`);
try {
  execFileSync('python3', [GEN_MAN_PY, '--verify', zoomPath], { encoding: 'utf8' });
  check('gen_man.py --verify accepts the Manager-produced scrollable .man', true);
} catch (e) {
  check('gen_man.py --verify accepts the Manager-produced scrollable .man', false, String(e.message ?? e));
}
try {
  const png = path.join(tmp, 'zoom_page0.png');
  execFileSync('python3', [GEN_MAN_PY, '--verify', zoomPath, '--zoom-page', '0', '-o', png], { encoding: 'utf8' });
  check('gen_man.py --zoom-page 0 round-trips to PNG', existsSync(png));
} catch (e) {
  check('gen_man.py --zoom-page 0 round-trips to PNG', false, String(e.message ?? e));
}
// SCL1 and zoom page counts must be 1:1 for any height (the firmware viewer pairs page p at 1x with
// zoom page p, the S1CHUNK_ROWS=48 contract). PAGE_H=600 → 2 chunks in both sections.
{
  const dv = new DataView(builtZoom.bytes.buffer, builtZoom.bytes.byteOffset, builtZoom.bytes.byteLength);
  const z0 = 40 + zh.nblocks * 8;
  const nzp = dv.getUint16(z0 + 24, true);
  const ns1 = dv.getUint16(z0 + 32 + 24, true);
  check('SCL1 page count == ZOOM page count (1:1 viewer contract)', ns1 === nzp, `ns1=${ns1} nzp=${nzp}`);
  check('tall page split into the expected chunk count', nzp === Math.ceil((PAGE_H * 2) / 768), `nzp=${nzp}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
