// Minimal, dependency-free PDF writer: one jpeg image per page (DCTDecode). Just enough to turn a
// decoded `.man` (or any ordered page-image list) into a shareable/printable PDF entirely in the
// browser (CSP-safe, no library). Not a general PDF toolkit: images only, DeviceRGB, baseline jpeg
// (which is exactly what canvas.toBlob('image/jpeg') produces).
//
// Layout: 1 = Catalog, 2 = Pages tree, then per page a Contents stream + an Image XObject + a Page.
// MediaBox = the image's pixel size (1 pt == 1 px), and the image fills the page. The xref table's
// entry lines are the spec-mandated fixed 20 bytes each.

function ascii(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
}

/** pages: [{ jpeg: Uint8Array, width, height }] -> Uint8Array (application/pdf). */
export function imagesToPdf(pages) {
  if (!pages || !pages.length) throw new Error('imagesToPdf: no pages');

  const chunks = [];
  let len = 0;
  const push = (u8) => { chunks.push(u8); len += u8.length; };
  const offsets = []; // offsets[objNum] = byte offset of that object

  // Object numbers: 1 Catalog, 2 Pages, then (content, image, page) per source page.
  let next = 3;
  const meta = pages.map((pg) => ({ ...pg, contentNum: next++, imageNum: next++, pageNum: next++ }));
  const nObjs = next; // valid object numbers are 1..nObjs-1

  const writeObj = (num, headStr, stream) => {
    offsets[num] = len;
    push(ascii(`${num} 0 obj\n`));
    push(ascii(headStr));
    if (stream != null) { push(ascii('\nstream\n')); push(stream); push(ascii('\nendstream')); }
    push(ascii('\nendobj\n'));
  };

  push(ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')); // binary comment marks the file as non-ASCII
  writeObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  writeObj(2, `<< /Type /Pages /Count ${meta.length} /Kids [${meta.map((m) => `${m.pageNum} 0 R`).join(' ')}] >>`);
  for (const m of meta) {
    const content = ascii(`q\n${m.width} 0 0 ${m.height} 0 0 cm\n/Im0 Do\nQ\n`);
    writeObj(m.contentNum, `<< /Length ${content.length} >>`, content);
    writeObj(
      m.imageNum,
      `<< /Type /XObject /Subtype /Image /Width ${m.width} /Height ${m.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${m.jpeg.length} >>`,
      m.jpeg,
    );
    writeObj(
      m.pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${m.width} ${m.height}] ` +
        `/Resources << /XObject << /Im0 ${m.imageNum} 0 R >> >> /Contents ${m.contentNum} 0 R >>`,
    );
  }

  const xrefStart = len;
  push(ascii('xref\n'));
  push(ascii(`0 ${nObjs}\n`));
  push(ascii('0000000000 65535 f \n')); // free head, 20 bytes
  for (let i = 1; i < nObjs; i++) push(ascii(String(offsets[i]).padStart(10, '0') + ' 00000 n \n')); // 20 bytes each
  push(ascii(`trailer\n<< /Size ${nObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`));

  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
