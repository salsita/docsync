/**
 * One root's diff, applied to Drive (MANUAL §7, §8).
 *
 * The mirror of `fetchRoot`, and the same shape as the Notion `pushRoot` so
 * that #9 treats both alike: files in, a report out, no disk and no git.
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
import { type SourceRef, splitGDocsRef } from '../source-ref.js';
import {
  commentUpdateFailed,
  DEFAULT_UPLOAD_MIME,
  type DocsDocument,
  FOLDER_MIME,
  type GDriveApi,
  PREVIEW_HINT,
} from './api.js';
import { objectRangeOf, stageImages, withSharedImages } from './assets.js';
import { gdriveApi } from './index.js';
import { type PatchPlan, planPatch } from './patch.js';
import { readLive } from './ranges.js';
import { type DocTab, flattenTabs } from './tabs.js';
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
  const everything = all.filter((change) => !isAssetPath(change.path));
  refuseOrphanedLinks(assetChanges, everything, index);

  // What the last fetch left behind, for this root's source only.
  const known = new Map<string, IndexEntry>();
  for (const entry of index.values()) {
    if (entry.src.source === 'gdocs') known.set(entry.path, entry);
  }

  /**
   * The directories that are a Doc (MANUAL §6, #37), by the Doc's id.
   *
   * The index says so — a tabbed Doc has an entry for its directory — and so
   * does this push, when after its own renames a file directly in a directory
   * resolves to a Doc: that is `git mv X.md X/A.md`, the transition from one
   * tab to many made in the checkout.
   */
  const tabDirs = new Map<string, string>();
  for (const entry of known.values()) {
    if (entry.type === 'gdoc' && entry.path.endsWith('/')) tabDirs.set(entry.path, entry.src.id);
  }
  for (const change of everything) {
    const ref = refOf(change, known);
    if (ref === undefined) continue;
    const { docId, tabId } = splitGDocsRef(ref);
    if (tabId !== undefined) {
      tabDirs.set(directoryOf(change.path), docId);
      continue;
    }
    // `git mv X.md X/A.md`: a Doc that was one file, moved into a directory
    // nothing else is in. A move into a folder that holds other documents is
    // what it has always been — a move between Drive folders (MANUAL §8).
    if (
      change.kind !== 'renamed' ||
      change.previousPath === undefined ||
      known.get(change.previousPath)?.type !== 'gdoc' ||
      directoryOf(change.previousPath) === directoryOf(change.path)
    ) {
      continue;
    }
    const directory = directoryOf(change.path);
    const shared = [...known.values()].some(
      (entry) => entry.path.startsWith(directory) && splitGDocsRef(entry.src).docId !== docId,
    );
    if (!shared) tabDirs.set(directory, docId);
  }

  /** The Doc's directory a path is inside, the longest one when tabs nest. */
  const tabDirOf = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    let longest: string | undefined;
    for (const directory of tabDirs.keys()) {
      if (!path.startsWith(directory)) continue;
      if (longest === undefined || directory.length > longest.length) longest = directory;
    }
    return longest;
  };

  /** The Doc a path belongs to as a tab file, or as the directory itself. */
  const tabDocOf = (path: string | undefined): string | undefined => {
    const directory = tabDirOf(path);
    return directory === undefined ? undefined : tabDirs.get(directory);
  };

  // A tab file and the directory it sits in are the Doc, not a file of the
  // Drive folder: they go through their own pass below, which never creates a
  // folder and never renames the Drive file for a tab.
  const tabChanges = everything.filter(
    (change) =>
      change.path.endsWith('/') ||
      (change.previousPath ?? '').endsWith('/') ||
      tabDocOf(change.path) !== undefined ||
      tabDocOf(change.previousPath) !== undefined,
  );
  const changes = everything.filter((change) => !tabChanges.includes(change));

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

  // One line per document, before its requests go out (MANUAL §7).
  const total = everything.length;
  let done = 0;

  /**
   * Pass zero: the tabs of a Doc with several of them, and the directory that
   * *is* that Doc (MANUAL §6, §7, #37).
   *
   * Nothing here touches the Drive folder tree: a tab is inside the Doc, so a
   * new tab file is `addDocumentTab` and not a new Doc, a retitle is
   * `updateDocumentTabProperties` and not a Drive rename, and the directory
   * itself is the Doc — renamed, moved or trashed as the Doc.
   */
  for (const change of tabChanges) {
    progress(`${++done}/${total} ${change.path}`);
    const previous = known.get(change.previousPath ?? change.path);
    const docId =
      tabDocOf(change.path) ??
      tabDocOf(change.previousPath) ??
      (previous === undefined ? undefined : splitGDocsRef(previous.src).docId);
    // A directory nothing resolves to was never at the source (MANUAL §8).
    if (docId === undefined) continue;

    if (change.path.endsWith('/') || (change.previousPath ?? '').endsWith('/')) {
      await pushDirectory(change, docId);
      continue;
    }

    const document = parseDocument(change.text ?? '');
    const ref = refOf(change, known);
    const wanted = document.frontmatter?.title ?? stem(nameOf(change.path));

    if (ref === undefined) {
      // A new `.md` with frontmatter and no id inside a tabbed Doc's directory
      // is a new tab; the id arrives with the post-push fetch (#37).
      if (change.text === undefined) {
        throw new PushError(
          'a Google Doc holds tabs, not files; only a .md file with frontmatter is a tab of it',
          change.path,
        );
      }
      const made = await writer.addTab(docId, wanted, parentTabOf(change.path));
      await writer.writeTab(docId, made, document.body);
      report.push({ path: change.path, title: wanted, action: 'created' });
      continue;
    }

    const tabId = splitGDocsRef(ref).tabId;
    const live = await api.getDocument(docId, 'inline');
    const tab = tabId === undefined ? flattenTabs(live)[0] : tabOfId(live, tabId);
    if (tab === undefined) {
      throw new PushError(
        `the Google Doc has no tab ${tabId ?? ''} any more; fetch, merge and push again`,
        change.path,
      );
    }

    // A changed `title:`, or a renamed file, retitles the tab. The filename
    // follows on the next fetch, as a Doc's does (MANUAL §6).
    let renamed = false;
    if (tab.id !== undefined && tab.title !== wanted) {
      await writer.renameTab(docId, tab.id, wanted);
      renamed = true;
    }
    if (change.text === undefined) {
      report.push({ path: change.path, title: wanted, action: renamed ? 'renamed' : 'updated' });
      continue;
    }

    const suggest = root.suggest === true;
    const patched = await patchDocument(
      api,
      writer,
      docId,
      change,
      document.body,
      known,
      // A tab's images are staged beside the Doc, which lives in the folder the
      // Doc's directory sits in — never in a folder named after the directory.
      await folderFor(trimSlash(tabDirOf(change.path) ?? directoryOf(change.path))),
      progress,
      suggest,
      { document: live, id: tab.id },
    );
    if (patched.uploaded > 0) uploaded.set(change.path, patched.uploaded);
    if (patched.skipped.length > 0) skippedFiles.set(change.path, patched.skipped);
    report.push({
      path: change.path,
      title: wanted,
      action: suggest ? 'suggested' : 'updated',
      ...(suggest ? { suggested: patched.suggested } : {}),
      blocks: patched.plan.counts,
      ...(patched.plan.suggestions.length === 0 ? {} : { suggestions: patched.plan.suggestions }),
      ...(patched.uploaded === 0 ? {} : { uploaded: patched.uploaded }),
      ...(patched.skipped.length === 0 ? {} : { skippedFiles: patched.skipped }),
    });
  }

  /**
   * A tabbed Doc's directory: it is the Doc (#37). Renaming it retitles
   * the Doc, moving it moves the Doc between Drive folders, and deleting the
   * whole of it — every tab file gone — trashes the Doc (MANUAL §8).
   */
  async function pushDirectory(change: FileChange, docId: string): Promise<void> {
    const title = stem(nameOf(trimSlash(change.path)));
    if (change.kind === 'deleted') {
      await writer.trash(docId);
      report.push({ path: change.path, title, action: 'trashed' });
      return;
    }
    if (change.kind !== 'renamed' || change.previousPath === undefined) return;
    const from = await folderFor(trimSlash(change.previousPath));
    const to = await folderFor(trimSlash(change.path));
    if (from !== to) await writer.move(docId, to, from);
    if (stem(nameOf(trimSlash(change.previousPath))) !== title) await writer.rename(docId, title);
    report.push({ path: change.path, title, action: 'renamed' });
  }

  /** The tab whose directory a new tab file sits in, for `parentTabId`. */
  function parentTabOf(path: string): string | undefined {
    const directory = directoryOf(path);
    if (tabDirs.has(directory)) return undefined;
    const parent = known.get(`${trimSlash(directory)}.md`);
    return parent === undefined ? undefined : splitGDocsRef(parent.src).tabId;
  }

  // Pass one: everything new, in path order so that a folder is made before
  // the files under it need it.
  const added = changes.filter((change) => change.kind === 'added');
  const created = new Map<string, string>();
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

    // The object lives in one tab, and so do the indices that address it
    // (#37): the Doc is read, and the tab the document file names is the
    // one the two requests below are sent to.
    const { docId, tabId } = splitGDocsRef(document.src);
    const live = await api.getDocument(docId, 'inline');
    const tab = tabId === undefined ? flattenTabs(live)[0] : tabOfId(live, tabId);
    const at = objectRangeOf(tab?.doc ?? live, entry.src.id);
    if (at === undefined) continue;

    const staged = await stageImages(api, [change.path], new Map([[change.path, change.bytes]]), {
      documentPath,
      parentId: await folderFor(trimSlash(tabDirOf(documentPath) ?? directoryOf(documentPath))),
    });
    for (const one of staged.skipped) {
      skippedFiles.set(documentPath, [...(skippedFiles.get(documentPath) ?? []), one]);
    }
    if (staged.images.length === 0) continue;
    for (const one of staged.images) progress(`upload ${one.path}`);

    const inTab = tab?.id === undefined ? {} : { tabId: tab.id };
    const outcome = await withSharedImages(api, staged.images, () =>
      api.batchUpdate(docId, [
        {
          deleteContentRange: {
            range: { startIndex: at.start, endIndex: at.end, ...inTab },
          },
        },
        {
          insertInlineImage: {
            location: { index: at.start, ...inTab },
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
 * message somebody will read (the owner's condition on #14).
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
  // The tab this patch is addressed to, when the caller has already read the
  // document to find it (#37). Absent for a Doc that is one file, whose
  // one tab is read here.
  tab?: { document: DocsDocument; id: string | undefined },
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
  // The document as one tab, which is what the dialect describes and what
  // every request addresses (MANUAL §6, #37). A Doc of one tab still has
  // a tab id, and the push names it: a request without one lands in the first
  // tab, which is only the right tab by accident.
  const document = tab?.document ?? (await api.getDocument(id, 'inline'));
  const tabs = flattenTabs(document);
  const chosen = tab === undefined ? tabs[0] : tabs.find((one) => one.id === tab.id);
  const tabId = chosen?.id;
  const live = readLive(chosen?.doc ?? document, { assets: links, from: change.path });
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

  const plan = planPatch(live, ops, {
    path: change.path,
    images,
    suggest,
    authors: authorsOf(document),
  });
  if (staged.images.length === 0) {
    const written = await write(
      () => writer.patchBody(id, plan, { suggest, ...(tabId === undefined ? {} : { tabId }) }),
      change.path,
      suggest,
    );
    return { plan, uploaded: 0, suggested: written.suggested ?? 0, skipped: staged.skipped };
  }

  // The share exists for exactly one batch, and the copies go with it.
  const outcome = await withSharedImages(api, staged.images, () =>
    write(
      () => writer.patchBody(id, plan, { suggest, ...(tabId === undefined ? {} : { tabId }) }),
      change.path,
      suggest,
    ),
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
 * Who made each pending suggestion, for a refusal that has to name them
 * (MANUAL §7).
 *
 * Only a read that asked for the discussions answers this — the Developer
 * Preview's `commentsViewMode`, which a fetch asks for and a push does not — so
 * on an ordinary push the map is empty and the refusal says `someone`.
 */
function authorsOf(doc: DocsDocument): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const one of doc.suggestions ?? []) {
    const name = one.headPost?.author?.displayName ?? '';
    if (one.suggestionId !== undefined && name !== '') out.set(one.suggestionId, name);
  }
  return out;
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

/**
 * What a change is about, as a source ref: the frontmatter's id, or what the
 * index says the path is. For a tab file that is `gdocs:<docId>#<tabId>`.
 */
function refOf(change: FileChange, known: ReadonlyMap<string, IndexEntry>): SourceRef | undefined {
  const frontmatter =
    change.text === undefined ? undefined : parseDocument(change.text).frontmatter?.id;
  if (frontmatter?.source === 'gdocs') return frontmatter;
  const entry = known.get(change.previousPath ?? change.path);
  return entry?.src.source === 'gdocs' ? entry.src : undefined;
}

/** One tab of a document by its id, or undefined when the Doc has no such tab. */
function tabOfId(document: DocsDocument, tabId: string): DocTab | undefined {
  return flattenTabs(document).find((tab) => tab.id === tabId);
}

/** The directory a path sits in, trailing slash and all. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}

/** A directory path without its trailing slash, so it names a thing. */
function trimSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
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
