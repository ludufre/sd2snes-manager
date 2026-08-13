/** Trigger a browser download of in-memory data (used as the fallback when not
 *  writing directly to the card, e.g. demo mode). */
export function downloadBlob(name: string, data: Uint8Array | string, mime = 'application/octet-stream'): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
