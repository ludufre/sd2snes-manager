/**
 * CardWriter on a card that behaves like FAT32 under Chromium's File System Access API, as measured on a
 * real card (Chrome 152, macOS):
 *  - names match case-insensitively (`getFileHandle('foo.sfc')` returns `Foo.sfc`), and a handle's
 *    `isSameEntry` compares the path it was obtained with, case and all;
 *  - deleting or moving a file takes its `._` AppleDouble companion along;
 *  - a recursive `removeEntry` walks a snapshot of the folder and fails with NotFoundError on a companion
 *    that the deletion of its file already removed, leaving the folder half deleted.
 */
import { describe, expect, it } from 'vitest';
import { CardWriter } from './card-writer.service';

interface Node {
  name: string;
  kind: 'file' | 'directory';
  data: string;
  children: Map<string, Node>; // keyed by lowercased name
  parent: Node | null;
}

const notFound = (what: string): DOMException => new DOMException(`${what} not found`, 'NotFoundError');

function node(name: string, kind: Node['kind'], parent: Node | null, data = ''): Node {
  const n: Node = { name, kind, data, children: new Map(), parent };
  parent?.children.set(name.toLowerCase(), n);
  return n;
}

function detach(n: Node): void {
  const parent = n.parent!;
  parent.children.delete(n.name.toLowerCase());
  if (n.kind === 'file') parent.children.delete(('._' + n.name).toLowerCase()); // the companion goes with it
  n.parent = null;
}

class FatFile {
  readonly kind = 'file';
  constructor(readonly name: string, private readonly path: string, private readonly n: Node, private readonly nativeMove: boolean) {}
  get move(): ((dir: FatDir, name: string) => Promise<void>) | undefined {
    if (!this.nativeMove) return undefined;
    return async (dir: FatDir, name: string) => {
      if (!this.n.parent) throw notFound(this.name);
      const companion = this.n.parent.children.get(('._' + this.n.name).toLowerCase());
      const existing = dir.node.children.get(name.toLowerCase());
      if (existing && existing !== this.n) detach(existing);
      this.n.parent.children.delete(this.n.name.toLowerCase());
      if (companion) this.n.parent.children.delete(companion.name.toLowerCase());
      this.n.name = name;
      this.n.parent = dir.node;
      dir.node.children.set(name.toLowerCase(), this.n);
      if (companion) {
        companion.name = '._' + name;
        companion.parent = dir.node;
        dir.node.children.set(companion.name.toLowerCase(), companion);
      }
    };
  }
  async getFile() {
    if (!this.n.parent) throw notFound(this.name);
    const data = this.n.data;
    return { size: data.length, text: async () => data };
  }
  async createWritable() {
    let buf = '';
    return {
      write: async (d: string | { text(): Promise<string> }) => { buf += typeof d === 'string' ? d : await d.text(); },
      close: async () => { this.n.data = buf; },
    };
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof FatFile && other.path === this.path;
  }
}

class FatDir {
  readonly kind = 'directory';
  constructor(readonly name: string, readonly path: string, readonly node: Node, private readonly nativeMove: boolean) {}
  private child(name: string): Node | undefined {
    return this.node.children.get(name.toLowerCase());
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FatFile> {
    let n = this.child(name);
    if (!n) {
      if (!opts?.create) throw notFound(name);
      n = node(name, 'file', this.node);
    }
    if (n.kind !== 'file') throw new DOMException(name, 'TypeMismatchError');
    return new FatFile(name, `${this.path}/${name}`, n, this.nativeMove);
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FatDir> {
    let n = this.child(name);
    if (!n) {
      if (!opts?.create) throw notFound(name);
      n = node(name, 'directory', this.node);
    }
    if (n.kind !== 'directory') throw new DOMException(name, 'TypeMismatchError');
    return new FatDir(name, `${this.path}/${name}`, n, this.nativeMove);
  }
  async *entries(): AsyncGenerator<[string, FatFile | FatDir]> {
    for (const n of [...this.node.children.values()]) {
      yield [n.name, n.kind === 'file'
        ? new FatFile(n.name, `${this.path}/${n.name}`, n, this.nativeMove)
        : new FatDir(n.name, `${this.path}/${n.name}`, n, this.nativeMove)];
    }
  }
  async removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void> {
    const n = this.child(name);
    if (!n) throw notFound(name);
    if (n.kind === 'directory') {
      if (n.children.size && !opts?.recursive) throw new DOMException(name, 'InvalidModificationError');
      // Chromium's walk: a snapshot of every descendant, deleted in order, failing on the first one gone.
      const snapshot: Node[] = [];
      const collect = (d: Node): void => { for (const c of d.children.values()) { if (c.kind === 'directory') collect(c); snapshot.push(c); } };
      collect(n);
      for (const c of snapshot) {
        if (!c.parent || !c.parent.children.has(c.name.toLowerCase())) throw notFound(c.name);
        detach(c);
      }
    }
    detach(n);
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return other instanceof FatDir && other.path === this.path;
  }
}

function card(nativeMove: boolean): { root: FatDir; tree: Node } {
  const tree = node('', 'directory', null);
  return { root: new FatDir('', '', tree, nativeMove), tree };
}

const names = (n: Node): string[] => [...n.children.values()].map((c) => c.name).sort();
const asDir = (d: FatDir): FileSystemDirectoryHandle => d as unknown as FileSystemDirectoryHandle;
const asFile = (f: FatFile): FileSystemFileHandle => f as unknown as FileSystemFileHandle;

describe('CardWriter on a case-insensitive card with AppleDouble companions', () => {
  it('a case-only rename without a native move fails instead of deleting the file', async () => {
    const { root, tree } = card(false);
    node('Foo.sfc', 'file', tree, 'rom-bytes');
    const fh = await root.getFileHandle('Foo.sfc');
    const cw = new CardWriter();
    await expect(cw.moveFile(asDir(root), asFile(fh), asDir(root), 'foo.sfc')).rejects.toMatchObject({ name: 'InvalidModificationError' });
    expect(names(tree)).toEqual(['Foo.sfc']);
    expect(tree.children.get('foo.sfc')!.data).toBe('rom-bytes');
  });

  it('a case-only rename with a native move renames the file', async () => {
    const { root, tree } = card(true);
    node('Foo.sfc', 'file', tree, 'rom-bytes');
    node('._Foo.sfc', 'file', tree);
    const fh = await root.getFileHandle('Foo.sfc');
    await new CardWriter().moveFile(asDir(root), asFile(fh), asDir(root), 'foo.sfc');
    expect(names(tree)).toEqual(['._foo.sfc', 'foo.sfc']);
    expect(tree.children.get('foo.sfc')!.data).toBe('rom-bytes');
  });

  it('a move to another folder without a native move still copies and deletes', async () => {
    const { root, tree } = card(false);
    node('Foo.sfc', 'file', tree, 'rom-bytes');
    const dest = await root.getDirectoryHandle('Dest', { create: true });
    const fh = await root.getFileHandle('Foo.sfc');
    await new CardWriter().moveFile(asDir(root), asFile(fh), asDir(dest), 'foo.sfc');
    expect(names(tree)).toEqual(['Dest']);
    expect(dest.node.children.get('foo.sfc')!.data).toBe('rom-bytes');
  });

  it('removeFolder finishes the folder Chromium leaves half deleted', async () => {
    const { root, tree } = card(true);
    // Each file listed before its companion, so deleting the file removes the companion ahead of the walk.
    const games = node('Games', 'directory', tree);
    node('a.sfc', 'file', games, 'a');
    node('._a.sfc', 'file', games);
    const sub = node('Sub', 'directory', games);
    node('b.sfc', 'file', sub, 'b');
    node('._b.sfc', 'file', sub);
    node('Keep.sfc', 'file', tree, 'keep');
    // The fake reproduces the browser failure first...
    await expect(root.removeEntry('Games', { recursive: true })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(names(tree)).toContain('Games');
    // ...and CardWriter completes the deletion anyway.
    await new CardWriter().removeFolder(asDir(root), 'Games');
    expect(names(tree)).toEqual(['Keep.sfc']);
  });

  it('moveFolderRecursive moves every file and leaves the companions to follow their files', async () => {
    const { root, tree } = card(true);
    const src = node('Old', 'directory', tree);
    node('._a.sfc', 'file', src);
    node('a.sfc', 'file', src, 'a');
    const sub = node('Sub', 'directory', src);
    node('._b.sfc', 'file', sub);
    node('b.sfc', 'file', sub, 'b');
    const cw = new CardWriter();
    const srcDir = await root.getDirectoryHandle('Old');
    await cw.moveFolderRecursive(asDir(srcDir), asDir(root), 'New');
    await cw.removeFolder(asDir(root), 'Old');
    expect(names(tree)).toEqual(['New']);
    const moved = tree.children.get('new')!;
    expect(names(moved)).toEqual(['._a.sfc', 'Sub', 'a.sfc']);
    expect(names(moved.children.get('sub')!)).toEqual(['._b.sfc', 'b.sfc']);
  });

  it('moveFolderRecursive refuses to move a folder onto itself', async () => {
    const { root, tree } = card(true);
    const games = node('Games', 'directory', tree);
    node('a.sfc', 'file', games, 'a');
    const srcDir = await root.getDirectoryHandle('Games');
    await expect(new CardWriter().moveFolderRecursive(asDir(srcDir), asDir(root), 'Games')).rejects.toMatchObject({ name: 'InvalidModificationError' });
    expect(names(games)).toEqual(['a.sfc']);
  });
});
