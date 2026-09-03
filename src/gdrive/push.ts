/**
 * One root's diff, applied to Drive (MANUAL §7, §8).
 *
 * The mirror of `fetchRoot`, and the same shape as the Notion `pushRoot` so
 * that ticket 09 treats both alike: files in, a report out, no disk and no git.
 * What is Drive's own is the shape of the tree — a root is a folder, a path is
 * a place in it — so this module resolves the folder a new file belongs in,
 * creating the ones the path implies and saying so, and turns a path change
 * into a move.
 *
 * Creations come first, so that a file created under a folder created in the
 * same push finds its parent. Everything else follows in the order git listed
 * it, and a deletion is a trashing, never a delete (MANUAL §8).
 */
import type { CredentialProvider } from '../auth/index.js';
import { parseDocument } from '../frontmatter.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { type FileChange, PushError, type PushReport } from '../push-types.js';
import { DEFAULT_UPLOAD_MIME, FOLDER_MIME, type GDriveApi } from './api.js';
import { gdriveApi } from './index.js';
import { createGDriveWriter } from './write.js';

export interface PushOptions {
  /** The API to use. Tests pass a fake one; a real push passes nothing. */
  api?: GDriveApi;
}

/** What a new binary is uploaded as, by extension. Everything else is bytes. */
const UPLOAD_MIMES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
};

/**
 * Applies one root's changes.
 *
 * `index` is the checkout as of the last fetch: it says which path is which
 * file, which is how a deleted file finds the id to trash and how a push
 * refuses to write over an export it only ever rendered.
 */
export async function pushRoot(
  root: Root,
  changes: readonly FileChange[],
  provider: CredentialProvider,
  index: DocumentIndex = new Map(),
  options: PushOptions = {},
): Promise<PushReport> {
  return pushWith(options.api ?? (await gdriveApi(provider)), root, changes, index);
}

async function pushWith(
  api: GDriveApi,
  root: Root,
  changes: readonly FileChange[],
  index: DocumentIndex,
): Promise<PushReport> {
  const writer = createGDriveWriter(api);
  const report: PushReport = [];

  // What the last fetch left behind, for this root's source only.
  const known = new Map<string, IndexEntry>();
  for (const entry of index.values()) {
    if (entry.src.source === 'gdocs') known.set(entry.path, entry);
  }

  // A Sheet, Slides or Drawing is a rendering of something the dialect cannot
  // carry back, so a change to one is refused by name (MANUAL §7).
  for (const change of changes) {
    const entry = known.get(change.previousPath ?? change.path);
    if (entry?.readOnly === true) {
      throw new PushError('Read-only export; edit it at the source', change.path);
    }
  }

  /** The root's own directory: where a path's first component sits. */
  const base = root.path.endsWith('/') ? root.path : `${root.path}/`;
  const folders = new Map<string, string>([[base, root.src.id]]);

  /**
   * The folder a path lives in, made if it is not there yet. A folder root's
   * own children go straight in the root folder; a deeper path needs every
   * folder above it to exist, and a push that has to make one says so.
   */
  async function folderFor(path: string): Promise<string> {
    let parent = root.src.id;
    let at = base;
    for (const name of path.slice(base.length, path.lastIndexOf('/') + 1).split('/')) {
      if (name === '') continue;
      at = `${at}${name}/`;
      const cached = folders.get(at);
      if (cached !== undefined) {
        parent = cached;
        continue;
      }
      const listing = await api.listFolder(parent);
      const found = listing.find((file) => file.mimeType === FOLDER_MIME && file.name === name);
      if (found !== undefined) parent = found.id;
      else {
        parent = await writer.createFolder(parent, name);
        report.push({ path: at, title: name, action: 'created' });
      }
      folders.set(at, parent);
    }
    return parent;
  }

  // Pass one: everything new, in path order so that a folder is made before
  // the files under it need it.
  const added = changes.filter((change) => change.kind === 'added');
  const created = new Map<string, string>();
  for (const change of [...added].sort((a, b) => a.path.localeCompare(b.path))) {
    const parent = await folderFor(change.path);
    const name = nameOf(change.path);

    if (isDocument(change)) {
      const document = parseDocument(change.text ?? '');
      const title = document.frontmatter?.title ?? stem(name);
      const made = await writer.createDoc(parent, title, document.body);
      created.set(change.path, made.id);
      report.push({ path: change.path, title, action: 'created' });
      continue;
    }
    const id = await writer.createFile(
      parent,
      name,
      change.bytes ?? new Uint8Array(),
      mimeOf(name),
    );
    created.set(change.path, id);
    report.push({ path: change.path, title: name, action: 'created' });
  }

  for (const change of changes) {
    if (change.kind === 'added') continue;
    const previous = known.get(change.previousPath ?? change.path);
    const document = parseDocument(change.text ?? '');
    const fromFrontmatter =
      document.frontmatter?.id?.source === 'gdocs' ? document.frontmatter.id.id : undefined;
    const id = fromFrontmatter ?? previous?.src.id ?? created.get(change.path);
    // A file with no id was never at the source (MANUAL §8).
    if (id === undefined) continue;

    if (change.kind === 'deleted') {
      await writer.trash(id);
      report.push({ path: change.path, title: nameOf(change.path), action: 'trashed' });
      continue;
    }

    const name = nameOf(change.path);
    const wanted = isDocument(change) ? (document.frontmatter?.title ?? stem(name)) : name;
    let renamed = false;

    if (change.kind === 'renamed' && change.previousPath !== undefined) {
      const from = await folderFor(change.previousPath);
      const to = await folderFor(change.path);
      if (from !== to) {
        await writer.move(id, to, from);
        renamed = true;
      }
    }

    // A rename is told by the change itself, which is what keeps a rename with
    // no body change to one API call; a title edited in the frontmatter of a
    // file that only changed has to be asked about at the source.
    if (await shouldRename(api, id, change, wanted, document.frontmatter?.title)) {
      await writer.rename(id, wanted);
      renamed = true;
    }

    if (isDocument(change) && change.text !== undefined) {
      await writer.replaceBody(id, document.body);
    } else if (change.bytes !== undefined) {
      await writer.uploadRevision(id, change.bytes, mimeOf(name));
    } else {
      report.push({ path: change.path, title: wanted, action: renamed ? 'renamed' : 'updated' });
      continue;
    }
    report.push({ path: change.path, title: wanted, action: 'updated' });
  }

  return report;
}

/**
 * Whether the file's name at the source is not the name it should have.
 *
 * A rename says so by itself: the path changed, and the old path is the old
 * name. Anything else has to be asked, and only when the frontmatter carries a
 * title at all — which is what keeps a plain body edit to the writes it needs.
 */
async function shouldRename(
  api: GDriveApi,
  id: string,
  change: FileChange,
  wanted: string,
  title: string | undefined,
): Promise<boolean> {
  if (change.kind === 'renamed' && change.previousPath !== undefined) {
    const before = nameOf(change.previousPath);
    return (isDocument(change) ? stem(before) : before) !== wanted;
  }
  if (title === undefined) return false;
  return (await api.getFile(id)).name !== wanted;
}

/** A Markdown document is a Google Doc; everything else in a root is bytes. */
function isDocument(change: FileChange): boolean {
  return change.path.endsWith('.md');
}

/** The last component of a path, which is the file's name in Drive. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** A filename without its `.md`, which is a title when nothing else is. */
function stem(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (
    (dot === -1 ? undefined : UPLOAD_MIMES[name.slice(dot).toLowerCase()]) ?? DEFAULT_UPLOAD_MIME
  );
}
