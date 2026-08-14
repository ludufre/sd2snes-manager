/** Read the checksum stored in the most plausible SNES internal header. */
export async function snesHeaderChecksum(file: File): Promise<string | null> {
  const copier = file.size % 0x400 === 0x200 ? 0x200 : 0;
  const headers = [0x7fc0, 0xffc0, 0x40ffc0]
    .map((offset) => offset + copier)
    .filter((offset) => offset + 0x20 <= file.size);
  if (!headers.length) return null;

  const candidates = await Promise.all(headers.map(async (offset) => {
    const bytes = new Uint8Array(await file.slice(offset, offset + 0x20).arrayBuffer());
    const complement = bytes[0x1c] | (bytes[0x1d] << 8);
    const checksum = bytes[0x1e] | (bytes[0x1f] << 8);
    const mapMode = bytes[0x15] & 0x2f;
    const expectedMap = offset - copier === 0x7fc0 ? 0x20 : offset - copier === 0xffc0 ? 0x21 : 0x25;
    const printableTitle = [...bytes.subarray(0, 21)].filter((b) => b === 0 || (b >= 0x20 && b <= 0x7e)).length;
    const score = ((checksum ^ complement) === 0xffff ? 100 : 0)
      + (mapMode === expectedMap || mapMode === expectedMap + 0x10 ? 20 : 0)
      + printableTitle;
    return { checksum, score };
  }));
  const best = candidates.sort((a, b) => b.score - a.score)[0];
  return best.checksum.toString(16).toUpperCase().padStart(4, '0');
}
