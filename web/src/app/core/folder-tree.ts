import type { Entry, FolderNode } from './models';

/** Build a folder tree from the entries' folder paths, plus an optional set of known directory paths
 *  (so EMPTY/newly-created folders also appear) and the folders of any theme (`.thm`) files. */
export function buildFolderTree(
  entries: Entry[],
  folders?: Iterable<string>,
  themeFolders?: Iterable<string>,
): FolderNode {
  const root: FolderNode = { name: 'SD Card', path: '', children: {}, childList: [], direct: 0, total: 0, themeDirect: 0, themeTotal: 0 };

  function ensure(path: string): FolderNode {
    if (path === '') return root;
    let node = root;
    let acc = '';
    for (const p of path.split('/')) {
      acc = acc ? acc + '/' + p : p;
      if (!node.children[p]) {
        node.children[p] = { name: p, path: acc, children: {}, childList: [], direct: 0, total: 0, themeDirect: 0, themeTotal: 0 };
      }
      node = node.children[p];
    }
    return node;
  }

  for (const g of entries) ensure(g.folder || '').direct++;
  for (const p of folders ?? []) ensure(p); // empty folders → direct:0 nodes
  for (const tf of themeFolders ?? []) ensure(tf || '').themeDirect++;

  (function totals(n: FolderNode): void {
    n.childList = Object.values(n.children).sort((a, b) => a.name.localeCompare(b.name));
    n.childList.forEach(totals);
    n.total = n.direct + n.childList.reduce((s, c) => s + c.total, 0);
    n.themeTotal = n.themeDirect + n.childList.reduce((s, c) => s + c.themeTotal, 0);
  })(root);

  return root;
}

export function findNode(root: FolderNode, path: string): FolderNode | null {
  if (path === '') return root;
  let n: FolderNode | undefined = root;
  for (const p of path.split('/')) {
    n = n?.children[p];
    if (!n) return null;
  }
  return n ?? null;
}
