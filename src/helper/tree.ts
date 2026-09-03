/**
 * A flat `path → blob` map into a git tree object, and back.
 *
 * The helper thinks in repo-relative paths; git stores a tree per directory.
 * This module is the only place that knows the difference. `git mktree` writes
 * one directory at a time, so a tree is built depth first, deepest directory
 * first, and every name is a single path component by the time git sees it.
 */
import type { Git, TreeEntry } from './git.js';

/** One file in a tree: the blob it points at and the mode it has. */
export interface TreeFile {
  sha: string;
  /** `100644` unless something says otherwise. */
  mode?: string;
}

/** A whole tree, flat: repo-relative `/`-separated path to blob. */
export type FileTree = ReadonlyMap<string, TreeFile>;

const DEFAULT_MODE = '100644';

interface Directory {
  files: Map<string, TreeFile>;
  directories: Map<string, Directory>;
}

const emptyDirectory = (): Directory => ({ files: new Map(), directories: new Map() });

/** Writes the tree objects for `files` and answers the sha of the root tree. */
export async function buildTree(git: Git, files: FileTree): Promise<string> {
  const root = emptyDirectory();
  for (const [path, file] of files) {
    const parts = path.split('/');
    const name = parts.pop() ?? path;
    let at = root;
    for (const part of parts) {
      let next = at.directories.get(part);
      if (next === undefined) {
        next = emptyDirectory();
        at.directories.set(part, next);
      }
      at = next;
    }
    at.files.set(name, file);
  }
  return write(git, root);
}

async function write(git: Git, directory: Directory): Promise<string> {
  const entries: TreeEntry[] = [];
  for (const [name, file] of directory.files) {
    entries.push({ mode: file.mode ?? DEFAULT_MODE, type: 'blob', sha: file.sha, name });
  }
  for (const [name, child] of directory.directories) {
    // The children first: a tree cannot name a subtree that is not written yet.
    entries.push({ mode: '040000', type: 'tree', sha: await write(git, child), name });
  }
  // `mktree` sorts for us, but a stable order keeps the input reproducible.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return git.mktree(entries);
}

/** The flat map of every blob under a tree-ish. */
export async function readTree(git: Git, treeish: string): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  for (const entry of await git.lsTree(treeish)) {
    if (entry.type !== 'blob') continue;
    files.set(entry.name, { sha: entry.sha, mode: entry.mode });
  }
  return files;
}

/** Whether two trees hold the same paths pointing at the same blobs. */
export function sameTree(a: FileTree, b: FileTree): boolean {
  if (a.size !== b.size) return false;
  for (const [path, file] of a) {
    const other = b.get(path);
    if (other === undefined || other.sha !== file.sha) return false;
  }
  return true;
}
