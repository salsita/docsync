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
import type { Root as MdastRoot } from 'mdast';
import { assetLinksOf, documentOfAssetsDir, isAssetPath, refuseOrphanedLinks } from '../assets.js';
import type { CredentialProvider } from '../auth/index.js';
import { type BlockOp, diffBlocks } from '../diff/blocks.js';
import { parseDocument } from '../frontmatter.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import { type FileChange, PushError, type PushReport } from '../push-types.js';
import type { Progress, ProgressOptions } from '../source.js';
import {
  commentUpdateFailed,
  DEFAULT_UPLOAD_MIME,
  FOLDER_MIME,
  type GDriveApi,
  PREVIEW_HINT,
} from './api.js';
import { objectRangeOf, type StagedImage, stageImages, withSharedImages } from './assets.js';
import { gdriveApi } from './index.js';
import { type PatchPlan, planPatch } from './patch.js';
import { readLive } from './ranges.js';
import { type BodyResult, createGDriveWriter, type GDriveWriter } from './write.js';

export interface PushOptions extends ProgressOptions {
  /** The API to use. Tests pass a fake one; a real push passes nothing. */
  api?: GDriveApi;
}

/** A progress hook that is not there. */
function noop(): void {}

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
  return pushWith(
    options.api ?? (await gdriveApi(provider)),
    root,
    changes,
    index,
    options.progress ?? noop,
  );
}

async function pushWith(
  api: GDriveApi,
  root: Root,
  all: readonly FileChange[],
  index: DocumentIndex,
  progress: Progress,
): Promise<PushReport> {
  const writer = createGDriveWriter(api);
  const report: PushReport = [];
  const uploaded = new Map<string, number>();
  const skippedFiles = new Map<string, { path: string; reason: string }[]>();

  // A file in `<title>.assets/` is an attachment of a document, not a document
  // (MANUAL §12 phase 2). It is never uploaded to Drive as a file of its own:
  // Docs copies the bytes into the document, and the Drive copy is temporary.
  const assetChanges = all.filter((change) => isAssetPath(change.path));
  const changes = all.filter((change) => !isAssetPath(change.path));
  refuseOrphanedLinks(assetChanges, changes, index);

  // What the last fetch left behind, for this root's source only.
  const known = new Map<string, IndexEntry>();
  for (const entry of index.values()) {
    if (entry.src.source === 'gdocs') known.set(entry.path, entry);
  }

  // A Sheet, Slides or Drawing is a rendering of something the dialect cannot
  // carry back, so a change to its content is refused by name (MANUAL §7).
  // Renaming or trashing one touches the file, not the rendering, and goes
  // through (MANUAL §8).
  for (const change of changes) {
    const entry = known.get(change.previousPath ?? change.path);
    const content = change.text !== undefined || change.bytes !== undefined;
    if (entry?.readOnly === true && content) {
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
  // One line per document, before its requests go out (MANUAL §7). Creations
  // come first here, so they are numbered first.
  const total = changes.length;
  let done = 0;
  for (const change of [...added].sort((a, b) => a.path.localeCompare(b.path))) {
    progress(`${++done}/${total} ${change.path}`);
    const parent = await folderFor(change.path);
    const name = nameOf(change.path);

    if (isDocument(change, undefined)) {
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
    progress(`${++done}/${total} ${change.path}`);
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
    const isDoc = isDocument(change, previous);
    const wanted = isDoc ? (document.frontmatter?.title ?? stem(name)) : name;
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
    if (await shouldRename(api, id, change, wanted, document.frontmatter?.title, isDoc)) {
      await writer.rename(id, wanted);
      renamed = true;
    }

    if (isDoc && change.text !== undefined) {
      // Under a suggest root the same requests go out in suggesting mode: the
      // body is left as it is and the client reviews each one (MANUAL §7).
      const suggest = root.suggest === true;
      const patched = await patchDocument(
        api,
        writer,
        id,
        change,
        document.body,
        known,
        await folderFor(change.path),
        progress,
        suggest,
      );
      const plan = patched.plan;
      if (patched.uploaded > 0) uploaded.set(change.path, patched.uploaded);
      if (patched.skipped.length > 0) skippedFiles.set(change.path, patched.skipped);
      report.push({
        path: change.path,
        title: wanted,
        action: suggest ? 'suggested' : 'updated',
        ...(suggest ? { suggested: patched.suggested } : {}),
        blocks: plan.counts,
        ...(plan.suggestions.length === 0 ? {} : { suggestions: plan.suggestions }),
        ...(patched.uploaded === 0 ? {} : { uploaded: patched.uploaded }),
        ...(patched.skipped.length === 0 ? {} : { skippedFiles: patched.skipped }),
      });
      continue;
    }
    if (change.bytes !== undefined) {
      await writer.uploadRevision(id, change.bytes, mimeOf(name));
    } else {
      report.push({ path: change.path, title: wanted, action: renamed ? 'renamed' : 'updated' });
      continue;
    }
    report.push({ path: change.path, title: wanted, action: 'updated' });
  }

  // Bytes that changed under an image nothing else rewrote: the object is
  // deleted and a new one inserted in its place (MANUAL §7, §12 phase 2).
  for (const change of assetChanges) {
    if (change.kind === 'deleted' || change.bytes === undefined) continue;
    const entry = known.get(change.previousPath ?? change.path);
    if (entry?.type !== 'asset') continue;
    const documentPath = entry.document ?? documentOfAssetsDir(change.path) ?? '';
    if (uploaded.has(documentPath)) continue;
    const document = known.get(documentPath);
    if (document === undefined) continue;

    const live = await api.getDocument(document.src.id, 'inline');
    const at = objectRangeOf(live, entry.src.id);
    if (at === undefined) continue;

    const staged = await stageImages(api, [change.path], new Map([[change.path, change.bytes]]), {
      documentPath,
      parentId: await folderFor(documentPath),
    });
    for (const one of staged.skipped) {
      skippedFiles.set(documentPath, [...(skippedFiles.get(documentPath) ?? []), one]);
    }
    if (staged.images.length === 0) continue;
    for (const one of staged.images) progress(`upload ${one.path}`);

    const outcome = await withSharedImages(api, staged.images, () =>
      api.batchUpdate(document.src.id, [
        { deleteContentRange: { range: { startIndex: at.start, endIndex: at.end } } },
        {
          insertInlineImage: {
            location: { index: at.start },
            uri: staged.images[0]?.uri ?? '',
          },
        },
      ]),
    );
    refuseIfLeftBehind(outcome, documentPath);
    uploaded.set(documentPath, (uploaded.get(documentPath) ?? 0) + 1);
    if (!report.some((one) => one.path === documentPath)) {
      report.push({ path: documentPath, title: nameOf(documentPath), action: 'updated' });
    }
  }

  return report.map((one) => ({
    ...one,
    ...((uploaded.get(one.path) ?? 0) === 0 ? {} : { uploaded: uploaded.get(one.path) }),
    ...(skippedFiles.has(one.path) ? { skippedFiles: skippedFiles.get(one.path) } : {}),
  }));
}

/**
 * What a share-insert-unshare-trash that could not clean up after itself says.
 *
 * The insert's own failure comes first, with what was left behind appended to
 * it: a push that leaves a file shared on Drive has to say so, in the one
 * message somebody will read (the owner's condition on this ticket).
 */
function refuseIfLeftBehind(
  outcome: { leftBehind: string[]; error?: unknown },
  path: string,
): void {
  const left =
    outcome.leftBehind.length === 0
      ? ''
      : ` Left behind, and yours to remove: ${outcome.leftBehind.join('; ')}.`;
  if (outcome.error !== undefined) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    throw new PushError(`${message}${left}`, path);
  }
  if (left !== '') throw new PushError(`the images were inserted, but${left}`, path);
}

/**
 * One modified document, patched (MANUAL §7).
 *
 * The live document is read with its suggestions inline and converted, and the
 * result has to say exactly what the version this push started from says. Push
 * step 1 has already made that true for the whole checkout; checking it here
 * makes it local, and makes the alignment between the base blocks and the live
 * ranges — the *n*th is the *n*th — a fact rather than an assumption. What the
 * diff then says is the only thing written.
 */
async function patchDocument(
  api: GDriveApi,
  writer: GDriveWriter,
  id: string,
  change: FileChange,
  body: MdastRoot,
  known: ReadonlyMap<string, IndexEntry>,
  parentId: string,
  progress: Progress,
  suggest = false,
): Promise<{
  plan: PatchPlan;
  uploaded: number;
  suggested: number;
  skipped: { path: string; reason: string }[];
}> {
  if (change.previousText === undefined) {
    throw new PushError(
      'there is no base version of this file to patch the document from; fetch, merge and push again',
      change.path,
    );
  }

  // The live body has to be read the way the file was written, images and
  // all, or the base check below would call every document with an image
  // changed (MANUAL §12 phase 2).
  const links = new Map<string, string>();
  for (const entry of known.values()) {
    if (entry.type === 'asset' && entry.document === change.path) {
      links.set(entry.src.id, entry.path);
    }
  }
  const live = readLive(await api.getDocument(id, 'inline'), {
    assets: links,
    from: change.path,
  });
  const base = parseDocument(change.previousText).body;
  // Both sides go through the one pipeline before they are compared, so that a
  // spelling the dialect accepts either way is not read as someone else's edit.
  if (stringifyMarkdown(parseMarkdown(live.markdown)) !== stringifyMarkdown(base)) {
    throw new PushError(
      'the source changed: the Google Doc is not the version this push started from; fetch, merge and push again',
      change.path,
    );
  }

  const ops = diffBlocks(base, body);
  // Only the blocks this push writes need an image behind them: a block it
  // keeps already points at the object Docs holds (MANUAL §12 phase 2).
  const staged = await stageImages(
    api,
    createdLinks(ops, change.path),
    change.assets ?? new Map(),
    {
      documentPath: change.path,
      parentId,
    },
  );
  const images = new Map(staged.images.map((one): [string, string] => [one.path, one.uri]));
  for (const one of staged.images) progress(`upload ${one.path}`);

  const plan = planPatch(live, ops, { path: change.path, images });
  if (staged.images.length === 0) {
    const written = await write(
      () => writer.patchBody(id, plan, { suggest }),
      change.path,
      suggest,
    );
    return { plan, uploaded: 0, suggested: written.suggested ?? 0, skipped: staged.skipped };
  }

  // The share exists for exactly one batch, and the copies go with it.
  const outcome = await withSharedImages(api, staged.images, () =>
    write(() => writer.patchBody(id, plan, { suggest }), change.path, suggest),
  );
  refuseIfLeftBehind(outcome, change.path);
  return {
    plan,
    uploaded: staged.images.length,
    suggested: outcome.result?.suggested ?? 0,
    skipped: staged.skipped,
  };
}

/**
 * One body write, with what suggesting mode adds to a failure (MANUAL §7).
 *
 * The preview feature is not on until the Cloud project is enrolled, and what
 * the API answers then is a refusal like any other, so the hint is appended to
 * it rather than replacing it. `commentUpdateState` is the other half: a
 * suggestion is a comment, and the API reports its own failure in the response
 * of an otherwise successful batch.
 */
async function write(
  send: () => Promise<BodyResult>,
  path: string,
  suggest: boolean,
): Promise<BodyResult> {
  let result: BodyResult;
  try {
    result = await send();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only a refusal that is about the write mode, or a plain 403, is the
    // enrolment: a 400 about an index is the patch's own fault.
    const enrolment = /Google API 403|write_?[Mm]ode|write_?[Cc]ontrol|SUGGEST/.test(message);
    if (!suggest || !enrolment) throw error;
    throw new PushError(`${message}. ${PREVIEW_HINT}`, path);
  }
  if (commentUpdateFailed(result.commentUpdateState)) {
    const state = result.commentUpdateState;
    throw new PushError(
      `the suggestions were not written: ${state?.message ?? state?.state ?? 'unknown state'}`,
      path,
    );
  }
  return result;
}

/** The assets linked by the blocks a set of ops creates or rewrites. */
function createdLinks(ops: readonly BlockOp[], from: string): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly BlockOp[]): void => {
    for (const op of list) {
      if (op.op === 'insert' || op.op === 'move' || op.op === 'update') {
        for (const path of assetLinksOf(op.next.source, from)) out.add(path);
      }
      if (op.op === 'keep' || op.op === 'update') walk(op.children);
    }
  };
  walk(ops);
  return out;
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
  isDoc: boolean,
): Promise<boolean> {
  if (change.kind === 'renamed' && change.previousPath !== undefined) {
    const before = nameOf(change.previousPath);
    return (isDoc ? stem(before) : before) !== wanted;
  }
  if (title === undefined) return false;
  return (await api.getFile(id)).name !== wanted;
}

/**
 * Whether a change is about a Google Doc. A file the index knows is what the
 * index says — a Markdown file stored in Drive is bytes, not a Doc. A new file
 * is a Doc when the helper handed it over as text, which it does for a file
 * that starts with frontmatter; one without is bytes (MANUAL §6).
 */
function isDocument(change: FileChange, known: IndexEntry | undefined): boolean {
  if (known !== undefined) return known.type === 'gdoc';
  return change.text !== undefined;
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
