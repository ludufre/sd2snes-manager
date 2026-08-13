import type { Entry } from './models';

/** Human size: KB under 1 MiB, else MB (one decimal only when not whole). */
export function fmtSize(b: number): string {
  if (b >= 1048576) return (b / 1048576).toFixed(b % 1048576 ? 1 : 0) + ' MB';
  return Math.round(b / 1024) + ' KB';
}

/** Human ETA: "45s" / "2m 05s". Lives here because three different views of the same bulk state
 *  (the bar, the progress modal, the auto-fill analyze phase) print it, and three copies of a
 *  formatter is how the bar and the modal end up disagreeing about the very number they share. */
export function fmtEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, '0')}s`;
}

/** Human write throughput: "820 KB/s" / "2.1 MB/s". */
export function fmtRate(bps: number): string {
  if (bps >= 1024 * 1024) return (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
  return Math.max(1, Math.round(bps / 1024)) + ' KB/s';
}

/** Short title for toasts: first segment before " - ", capped at 26 chars. */
export function shortTitle(e: Entry): string {
  return e.title.split(' - ')[0].slice(0, 26);
}

/** The display title painted on the mock cover art (strip parens + region). */
export function coverTitle(e: Entry): string {
  return e.title.split(' - ')[0].replace(/\(.*\)/, '').trim();
}

/** Extract the No-Intro region string from a ROM filename, e.g. "(USA)" → "USA". */
export function regionFromName(name: string): string | null {
  const m = name.match(
    /\(([^)]*(USA|Europe|Japan|World|Asia|Korea|Brazil|Australia|Spain|France|Germany|Italy)[^)]*)\)/i,
  );
  return m ? m[1] : null;
}

/** Strip the last extension from a ROM filename (the firmware's strrchr('.')).
 *  Re-exported from sd-layout, which owns it: this rule is mirrored in firmware C, and two copies
 *  of a mirrored rule is exactly how the two sides drift apart. */
export { romStem as stemOf } from './sd-layout';
