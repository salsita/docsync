/**
 * What a pushed diff means to each root (MANUAL §6 Identity, §7 push steps
 * 3 to 5).
 *
 * `git diff-tree` says which paths changed and how; this module says which
 * root each one belongs to, whether the change is text or bytes, and when a
 * file that looks modified is really one object trashed and another made —
 * frontmatter added to a plain file or removed from a document. It refuses,
 * by path, what the manual refuses: a file outside every root, anything under
 * a read-only root, a touch of the index, an edit to a read-only export, a
 * copy of a document, a plain file under Notion. Pure over an injected blob
 * reader.
 */
import { assetsDirOf, documentOfAssetsDir, isAssetPath } from '../assets.js';
import { isSidecarPath } from '../comments/format.js';
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

/**
 * One path the push will not carry, and why (MANUAL §7 step 3).
 *
 * `message` is the sentence `docsync push` fails with; `reason` is the short
 * half `docsync status` prints after the path, so the preview and the refusal
 * say the same thing in the room each has (ticket 31).
 */
export interface Refusal {
  path: string;
  reason: string;
  message: string;
}

/**
 * What a pushed diff means, whole: the work per root, everything refused, and
 * the paths a push passes over.
 *
 * Refusals are collected rather than thrown, because `docsync status` previews
 * a push and a preview that stopped at the first problem would not be one.
 * `push` fails on the first refusal, which is what it always did (ticket 31).
 */
export interface PushPlan {
  /** Per-root changes, in manifest order. */
  roots: PlannedPush[];
  /** Every refused path, in the order the diff holds them. */
  refusals: Refusal[];
  /** Deleted under no root: `docsync remove`, not a trash (MANUAL §8). */
  ignored: string[];
}

/** Records one refusal. The default message is the usual `<path>: <reason>`. */
type Refuse = (path: string, reason: string, message?: string) => undefined;

/** The bytes of a path in the pushed tree. */
export type BlobReader = (path: string) => Promise<Uint8Array>;

/**
 * The bytes of a path in the *served* tree — the commit the push is a diff
 * from — or `undefined` when that tree does not hold it. Diff-based write-back
 * (MANUAL §7) is computed against this version, so every text document that
 * changed carries it as `previousText`.
 */
export type BaseReader = (path: string) => Promise<Uint8Array | undefined>;

/**
 * Sorts a diff into per-root changes, in manifest order, and names every path
 * the push must refuse instead of carrying it.
 */
export async function planChanges(
  diff: readonly DiffEntry[],
  roots: readonly Root[],
  index: DocumentIndex,
  read: BlobReader,
  readBase: BaseReader = async () => undefined,
): Promise<PushPlan> {
  /** Every asset path the push added or modified, and every one it removed. */
  const live = new Set<string>();
  const gone = new Set<string>();
  for (const entry of diff) {
    if (!isAssetPath(entry.path) && !isAssetPath(entry.previousPath ?? '')) continue;
    if (entry.status[0] === 'D') gone.add(entry.path);
    else {
      live.add(entry.path);
      if (entry.previousPath !== undefined) gone.add(entry.previousPath);
    }
  }

  /**
   * The files in one document's `<title>.assets/`, as the pushed tree holds
   * them (MANUAL §12 phase 2): the ones this push touched, and the ones the
   * last fetch left, which are still there and which the adapter may have to
   * upload for a block it is about to create. A path the pushed tree does not
   * hold — one this push deleted — is simply not in the answer.
   */
  const assetsOf = async (
    path: string,
    previousPath: string | undefined,
  ): Promise<Pick<FileChange, 'assets'>> => {
    const directory = `${assetsDirOf(path)}/`;
    const candidates = new Set<string>();
    for (const one of live) if (one.startsWith(directory)) candidates.add(one);
    // What the index knows, moved to wherever the document is now: a renamed
    // document takes its assets directory with it (MANUAL §12 phase 2).
    for (const entry of index.values()) {
      if (entry.type !== 'asset' || entry.document !== (previousPath ?? path)) continue;
      candidates.add(`${directory}${entry.path.slice(entry.path.lastIndexOf('/') + 1)}`);
    }
    const assets = new Map<string, Uint8Array>();
    for (const one of [...candidates].sort()) {
      if (gone.has(one)) continue;
      try {
        assets.set(one, await read(one));
      } catch {
        // Not in the pushed tree: the file was deleted, and the adapter is
        // told by the deletion itself.
      }
    }
    return assets.size === 0 ? {} : { assets };
  };
  const refusals: Refusal[] = [];
  const ignored: string[] = [];
  const refuse: Refuse = (path, reason, message = `${path}: ${reason}`) => {
    refusals.push({ path, reason, message });
    return undefined;
  };
  const planned = new Map<Root, FileChange[]>();
  const add = (root: Root, ...changes: FileChange[]): void => {
    const list = planned.get(root) ?? [];
    list.push(...changes);
    planned.set(root, list);
  };
  const rootOf = (path: string): Root | undefined =>
    roots.find((root) => path === root.path || path.startsWith(`${territoryOf(root.path)}/`));

  for (const entry of diff) {
    // Anything recorded while this entry is sorted means it is refused, and
    // nothing about it reaches a root.
    const before = refusals.length;
    const stopped = (): boolean => refusals.length > before;

    if (entry.path === INDEX_PATH || entry.previousPath === INDEX_PATH) {
      refuse(INDEX_PATH, 'the index is written by fetch; do not edit it');
      continue;
    }
    const kind = entry.status[0];
    const root = rootOf(entry.path);

    // A read-only root is pulled for context and never pushed to (MANUAL §4).
    // Every file under it — document, asset and sidecar alike — and every kind
    // of change, so this runs before the other refusals: a file in someone
    // else's folder is named as what it is. The path it came from first, since
    // that is the one `git checkout` restores.
    for (const path of [entry.previousPath, entry.path]) {
      if (path === undefined || stopped()) continue;
      const under = rootOf(path);
      if (under?.readOnly === true) {
        refuse(
          path,
          `under read-only root ${under.path}`,
          `${path} is under a read-only root (${under.path}); nothing under it is pushed. ` +
            `Restore it with git checkout -- ${path}`,
        );
      }
    }
    if (stopped()) continue;

    // The sidecar is read-only: comments are only pulled in this version
    // (MANUAL §6). Refused before any source is touched, changed, added or
    // removed. Outside every root it is not ours, and a deletion there is
    // `docsync remove` taking the document and its sidecar with it (MANUAL §8).
    for (const path of [entry.previousPath, entry.path]) {
      if (path === undefined || stopped()) continue;
      if (isSidecarPath(path) && rootOf(path) !== undefined) {
        refuse(
          path,
          'read-only; comments are only pulled in this version',
          `${path} is read-only; comments are only pulled in this version. ` +
            `Restore it with git checkout -- ${path}`,
        );
      }
    }
    if (stopped()) continue;

    if (kind === 'D') {
      // Deleted under no root is `docsync remove`: unsubscribe, not trash (MANUAL §8).
      if (root === undefined) ignored.push(entry.path);
      else add(root, { kind: 'deleted', path: entry.path });
      continue;
    }
    if (root === undefined) {
      refuse(entry.path, 'not under any root in the manifest');
      continue;
    }

    if (kind === 'R' && entry.previousPath !== undefined) {
      const from = rootOf(entry.previousPath);
      const previous = index.get(entry.previousPath);
      const identical = entry.status === 'R100';
      if (from === root && previous !== undefined) {
        refuseReadOnlyExport(previous, entry.path, !identical, refuse);
        if (stopped()) continue;
        const change: FileChange = {
          kind: 'renamed',
          path: entry.path,
          previousPath: entry.previousPath,
        };
        if (!identical) {
          Object.assign(
            change,
            await content(previous, entry.path, read),
            // A renamed document diffs against the file under its old path.
            await base(previous, entry.previousPath, readBase),
            isDocument(previous) ? await assetsOf(entry.path, entry.previousPath) : {},
          );
        }
        add(root, change);
        continue;
      }
      // Across roots, or from a path the index never held: the old object is
      // trashed where it was and a new one is made where the file now is.
      const remade = await added(root, entry.path, index, read, refuse);
      if (remade === undefined) continue;
      if (from !== undefined) add(from, { kind: 'deleted', path: entry.previousPath });
      add(root, remade);
      continue;
    }

    // `A`, `M`, and `T` (a mode change, which is a modification here).
    const known = index.get(entry.path);
    if (known === undefined) {
      const made = await added(root, entry.path, index, read, refuse);
      if (made !== undefined) add(root, made);
      continue;
    }
    refuseReadOnlyExport(known, entry.path, true, refuse);
    if (stopped()) continue;
    const bytes = await read(entry.path);
    const wasDocument = isDocument(known);
    const isMarkdown = entry.path.endsWith('.md');
    const hasFrontmatter =
      isMarkdown && parseDocument(Buffer.from(bytes).toString('utf8')).frontmatter !== undefined;
    if (isMarkdown && wasDocument !== hasFrontmatter) {
      // The path changed what it is (MANUAL §6): one object goes, another comes.
      const made = await added(root, entry.path, index, read, refuse, bytes);
      if (made === undefined) continue;
      add(root, { kind: 'deleted', path: entry.path }, made);
      continue;
    }
    add(root, {
      kind: 'modified',
      path: entry.path,
      ...(wasDocument ? { text: Buffer.from(bytes).toString('utf8') } : { bytes }),
      ...(await base(known, entry.path, readBase)),
      ...(wasDocument ? await assetsOf(entry.path, undefined) : {}),
    });
  }

  // A document that gained or lost a file needs the whole of its assets
  // directory, even when the document itself did not change: the adapter has
  // to point a block at the bytes (MANUAL §12 phase 2).
  for (const [root, changes] of planned) {
    for (const change of changes) {
      if (change.text === undefined || change.assets !== undefined) continue;
      Object.assign(change, await assetsOf(change.path, change.previousPath));
    }
    void root;
  }

  return {
    roots: roots.flatMap((root) => {
      const changes = planned.get(root);
      return changes === undefined ? [] : [{ root, changes }];
    }),
    refusals,
    ignored,
  };
}

function isDocument(entry: IndexEntry): boolean {
  return entry.type === 'gdoc' || entry.type === 'notion-page';
}

/** A Sheet, a Slide deck or a Drawing: content is edited at the source (MANUAL §7 step 4). */
function refuseReadOnlyExport(
  entry: IndexEntry,
  path: string,
  contentChanged: boolean,
  refuse: Refuse,
): void {
  if (entry.readOnly === true && contentChanged) {
    refuse(path, 'a read-only export; edit it at the source');
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

/**
 * The version a document's change is a diff from, when there is one to read.
 * Only a document has one: a binary is replaced whole, so a base would be bytes
 * nobody diffs (MANUAL §7).
 */
async function base(
  entry: IndexEntry,
  path: string,
  readBase: BaseReader,
): Promise<Pick<FileChange, 'previousText'>> {
  if (!isDocument(entry)) return {};
  const bytes = await readBase(path);
  return bytes === undefined ? {} : { previousText: Buffer.from(bytes).toString('utf8') };
}

/** A new file, under the frontmatter rules of MANUAL §6. */
async function added(
  root: Root,
  path: string,
  index: DocumentIndex,
  read: BlobReader,
  refuse: Refuse,
  bytes?: Uint8Array,
): Promise<FileChange | undefined> {
  const raw = bytes ?? (await read(path));
  const notion = root.src.source === 'notion';
  if (!path.endsWith('.md')) {
    // A file in `<title>.assets/` is an attachment of that document, and both
    // sources hold those (MANUAL §12 phase 2). Anything else under a Notion
    // root is a file Notion has nowhere to put.
    if (notion && !isAssetPath(path)) {
      return refuse(path, 'Notion holds no files; only .md pages go under a Notion root');
    }
    return { kind: 'added', path, bytes: raw };
  }

  const text = Buffer.from(raw).toString('utf8');
  const { frontmatter } = parseDocument(text);
  if (frontmatter === undefined) {
    if (notion) {
      return refuse(
        path,
        'a new file under a Notion root must start with frontmatter (a --- line, then another) to become a page',
      );
    }
    return { kind: 'added', path, bytes: raw };
  }
  if (frontmatter.id !== undefined) {
    const id = formatSourceRef(frontmatter.id);
    const other = [...index.values()].find((entry) => formatSourceRef(entry.src) === id);
    if (other !== undefined) {
      return refuse(
        path,
        `its id ${id} is already checked out as ${other.path}; remove the id line to create a copy`,
      );
    }
  }
  return { kind: 'added', path, text };
}
