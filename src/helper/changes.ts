/**
 * What a pushed diff means to each root (MANUAL §6 Identity, §7 push steps
 * 3 to 5).
 *
 * `git diff-tree` says which paths changed and how; this module says which
 * root each one belongs to, whether the change is text or bytes, and when a
 * file that looks modified is really one object trashed and another made —
 * frontmatter added to a plain file or removed from a document. It refuses,
 * by path, what the manual refuses: a file outside every root, a touch of the
 * index, an edit to a read-only export, a copy of a document, a plain file
 * under Notion. Pure over an injected blob reader.
 */
import { parseDocument } from '../frontmatter.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { territoryOf } from '../manifest/validate.js';
import type { FileChange } from '../source.js';
import { formatSourceRef } from '../source-ref.js';
import type { DiffEntry } from './git.js';
import { INDEX_PATH } from './index-file.js';

/** One root's share of a push. Roots with nothing to do are not listed. */
export interface PlannedPush {
  root: Root;
  changes: FileChange[];
}

/** The bytes of a path in the pushed tree. */
export type BlobReader = (path: string) => Promise<Uint8Array>;

/**
 * Sorts a diff into per-root changes, in manifest order. Throws with a
 * message naming the path on anything the push must refuse.
 */
export async function planChanges(
  diff: readonly DiffEntry[],
  roots: readonly Root[],
  index: DocumentIndex,
  read: BlobReader,
): Promise<PlannedPush[]> {
  const planned = new Map<Root, FileChange[]>();
  const add = (root: Root, ...changes: FileChange[]): void => {
    const list = planned.get(root) ?? [];
    list.push(...changes);
    planned.set(root, list);
  };
  const rootOf = (path: string): Root | undefined =>
    roots.find((root) => path === root.path || path.startsWith(`${territoryOf(root.path)}/`));

  for (const entry of diff) {
    if (entry.path === INDEX_PATH || entry.previousPath === INDEX_PATH) {
      throw new Error(`${INDEX_PATH}: the index is written by fetch; do not edit it`);
    }
    const kind = entry.status[0];
    const root = rootOf(entry.path);

    if (kind === 'D') {
      // Deleted under no root is `docsync remove`: unsubscribe, not trash (MANUAL §8).
      if (root !== undefined) add(root, { kind: 'deleted', path: entry.path });
      continue;
    }
    if (root === undefined) {
      throw new Error(`${entry.path}: not under any root in the manifest`);
    }

    if (kind === 'R' && entry.previousPath !== undefined) {
      const from = rootOf(entry.previousPath);
      const previous = index.get(entry.previousPath);
      const identical = entry.status === 'R100';
      if (from === root && previous !== undefined) {
        refuseIfReadOnly(previous, entry.path, !identical);
        const change: FileChange = {
          kind: 'renamed',
          path: entry.path,
          previousPath: entry.previousPath,
        };
        if (!identical) Object.assign(change, await content(previous, entry.path, read));
        add(root, change);
        continue;
      }
      // Across roots, or from a path the index never held: the old object is
      // trashed where it was and a new one is made where the file now is.
      if (from !== undefined) add(from, { kind: 'deleted', path: entry.previousPath });
      add(root, await added(root, entry.path, index, read));
      continue;
    }

    // `A`, `M`, and `T` (a mode change, which is a modification here).
    const known = index.get(entry.path);
    if (known === undefined) {
      add(root, await added(root, entry.path, index, read));
      continue;
    }
    refuseIfReadOnly(known, entry.path, true);
    const bytes = await read(entry.path);
    const wasDocument = isDocument(known);
    const isMarkdown = entry.path.endsWith('.md');
    const hasFrontmatter =
      isMarkdown && parseDocument(Buffer.from(bytes).toString('utf8')).frontmatter !== undefined;
    if (isMarkdown && wasDocument !== hasFrontmatter) {
      // The path changed what it is (MANUAL §6): one object goes, another comes.
      add(
        root,
        { kind: 'deleted', path: entry.path },
        await added(root, entry.path, index, read, bytes),
      );
      continue;
    }
    add(root, {
      kind: 'modified',
      path: entry.path,
      ...(wasDocument ? { text: Buffer.from(bytes).toString('utf8') } : { bytes }),
    });
  }

  return roots.flatMap((root) => {
    const changes = planned.get(root);
    return changes === undefined ? [] : [{ root, changes }];
  });
}

function isDocument(entry: IndexEntry): boolean {
  return entry.type === 'gdoc' || entry.type === 'notion-page';
}

function refuseIfReadOnly(entry: IndexEntry, path: string, contentChanged: boolean): void {
  if (entry.readOnly === true && contentChanged) {
    throw new Error(`${path}: a read-only export; edit it at the source`);
  }
}

/** A known path's new content, typed the way the index says. */
async function content(
  entry: IndexEntry,
  path: string,
  read: BlobReader,
): Promise<Pick<FileChange, 'text' | 'bytes'>> {
  const bytes = await read(path);
  return isDocument(entry) ? { text: Buffer.from(bytes).toString('utf8') } : { bytes };
}

/** A new file, under the frontmatter rules of MANUAL §6. */
async function added(
  root: Root,
  path: string,
  index: DocumentIndex,
  read: BlobReader,
  bytes?: Uint8Array,
): Promise<FileChange> {
  const raw = bytes ?? (await read(path));
  const notion = root.src.source === 'notion';
  if (!path.endsWith('.md')) {
    if (notion)
      throw new Error(`${path}: Notion holds no files; only .md pages go under a Notion root`);
    return { kind: 'added', path, bytes: raw };
  }

  const text = Buffer.from(raw).toString('utf8');
  const { frontmatter } = parseDocument(text);
  if (frontmatter === undefined) {
    if (notion) {
      throw new Error(
        `${path}: a new file under a Notion root must start with frontmatter (a --- line, then another) to become a page`,
      );
    }
    return { kind: 'added', path, bytes: raw };
  }
  if (frontmatter.id !== undefined) {
    const id = formatSourceRef(frontmatter.id);
    const other = [...index.values()].find((entry) => formatSourceRef(entry.src) === id);
    if (other !== undefined) {
      throw new Error(
        `${path}: its id ${id} is already checked out as ${other.path}; remove the id line to create a copy`,
      );
    }
  }
  return { kind: 'added', path, text };
}
