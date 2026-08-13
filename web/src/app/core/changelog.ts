// The changelog file → one entry per released version, for the "what's new" dialog.
//
// It ships as `public/changelog.txt` (Markdown content, .txt name, the production host 404s any
// `.md` request); the repo root keeps a `CHANGELOG.md` symlink to it for anyone looking there.
//
// The file is authored by hand and lives in `public/`, so it is served as-is (no build step) and
// stays readable on its own. The contract with it is one line shape:
//
//   ## <version>, <date>
//
// Everything until the next `## ` is that version's body, kept as raw Markdown and rendered by the
// dialog. Anything before the first `## ` (the file's own intro) is preamble and is dropped, it
// describes the file, not a release.

export interface ChangelogEntry {
  /** `1.10.0`, also the id used to match the running build. */
  version: string;
  /** `2026-07-27`, or '' when the heading carries no date. */
  date: string;
  /** Raw Markdown of the section, headings excluded. */
  body: string;
}

// The em dash is what separates version from date. A plain hyphen is accepted too, since it is the
// easy thing to type and a changelog nobody can edit by hand would defeat the point.
const HEADING = /^##\s+(\S+)\s*(?:[—–-]\s*(.*))?$/;

/** Split the changelog into entries, newest first (i.e. in file order). */
export function parseChangelog(md: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (cur) out.push({ ...cur, body: buf.join('\n').trim() });
    buf = [];
  };
  for (const line of md.split(/\r?\n/)) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      cur = { version: m[1], date: (m[2] ?? '').trim(), body: '' };
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return out;
}
