/**
 * Name comparisons for entries on the card.
 *
 * FAT32 and exFAT match names case-insensitively, and Chromium's File System Access API on those cards
 * does too (checked on a real card): `getFileHandle('foo.sfc')` returns an existing `Foo.sfc`, and
 * `removeEntry('foo.sfc')` deletes it. So `Foo.sfc` and `foo.sfc` are one file, and every decision of the
 * form "is the destination the same entry as the source?" has to compare this way. Comparing with `===`
 * turned a rename that only changes the letter case into "replace the existing file", which deleted the file
 * being renamed.
 *
 * On a case-sensitive local folder (not a card) this treats two distinct files as one. That errs on the safe
 * side: an operation is skipped or refused, nothing is overwritten.
 */

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Two card paths ('/'-separated, '' for the root) that name the same folder or file. */
export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether `child` is strictly inside `parent`. Every path is inside the root (''), except the root itself. */
export function isInsidePath(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return p === '' ? c !== '' : c.startsWith(p + '/');
}

/**
 * How a planned move relates to its source.
 *  - `identical`: same folder, same name, nothing to do.
 *  - `caseOnly`: same folder, the name differs only in letter case, so the destination IS the source. It is a
 *    rename, never a conflict, and the destination must not be removed first.
 *  - `distinct`: a different file, which may or may not already exist.
 */
export type MoveRelation = 'identical' | 'caseOnly' | 'distinct';

export function moveRelation(sameFolder: boolean, srcName: string, destName: string): MoveRelation {
  if (!sameFolder) return 'distinct';
  if (srcName === destName) return 'identical';
  return sameName(srcName, destName) ? 'caseOnly' : 'distinct';
}
