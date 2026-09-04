/**
 * One root's diff, applied to Notion (MANUAL §7, §8).
 *
 * `pushRoot` is the whole public surface and the mirror of `fetchRoot`: files
 * in, a report out. It decides *order* — creations before the links that point
 * at them can resolve, deletions last — and leaves every request to `write.ts`
 * and every conversion to `from-markdown.ts`. No disk, no git.
 */
import type { Link, Root as MdastRoot } from 'mdast';
import { visit } from 'unist-util-visit';
import { assetLinksOf, documentOfAssetsDir, isAssetPath, refuseOrphanedLinks } from '../assets.js';
import type { CredentialProvider } from '../auth/index.js';
import { type BlockCounts, type BlockOp, diffBlocks } from '../diff/blocks.js';
import { parseDocument } from '../frontmatter.js';
import type { DocumentIndex } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import { type FileChange, PushError, type PushReport } from '../push-types.js';
import type { NotionApi } from './api.js';
import { fileUploadBody, uploadAssets } from './assets.js';
import { mdastToBlocks, resolvePath } from './from-markdown.js';
import { notionApi } from './index.js';
import { planPatch } from './patch.js';
import { bareId, blocksToMarkdown } from './to-markdown.js';
import { titleOf } from './walk.js';
import { createNotionWriter, type NotionWriter } from './write.js';

export interface PushOptions {
  /** The API to use. Tests pass a fake one; a real push passes nothing. */
  api?: NotionApi;
}

/**
 * Applies one root's changes.
 *
 * `index` is the checkout as of the last fetch: it says which path is which
 * page, which is how a link to `../Leaf.md` becomes a mention and how a
 * deleted file finds the page to archive.
 */
export async function pushRoot(
  root: Root,
  changes: readonly FileChange[],
  provider: CredentialProvider,
  index: DocumentIndex = new Map(),
  options: PushOptions = {},
): Promise<PushReport> {
  return pushWith(options.api ?? (await notionApi(provider)), root, changes, index);
}

async function pushWith(
  api: NotionApi,
  root: Root,
  all: readonly FileChange[],
  index: DocumentIndex,
): Promise<PushReport> {
  let changes: readonly FileChange[] = all;
  const writer = createNotionWriter(api);
  const report: PushReport = [];
  // What this push uploaded, and what it would not, per document, so that the
  // report can say `uploaded <n> files` on the line it belongs to (§12).
  const uploaded = new Map<string, number>();
  const skippedFiles = new Map<string, { path: string; reason: string }[]>();
  const count = (path: string, result: { uploads: Map<string, string>; skipped: unknown[] }) => {
    uploaded.set(path, (uploaded.get(path) ?? 0) + result.uploads.size);
    if (result.skipped.length > 0) {
      skippedFiles.set(path, [
        ...(skippedFiles.get(path) ?? []),
        ...(result.skipped as { path: string; reason: string }[]),
      ]);
    }
  };

  // A file in `<title>.assets/` is not a document: it is an attachment of one,
  // and what a push does with it depends on the block that points at it
  // (MANUAL §12 phase 2). The two are sorted apart here so that nothing below
  // mistakes one for a page.
  const assetChanges = all.filter((change) => isAssetPath(change.path));
  const documentChanges = all.filter((change) => !isAssetPath(change.path));
  refuseOrphanedLinks(assetChanges, documentChanges, index);
  changes = documentChanges;

  // Page ids by path, for the mentions. It grows as pages are created, which
  // is exactly why creations come first.
  const ids = new Map<string, string>();
  // And the other way round, for the conversion of the live page: a mention of
  // a page in the checkout is a relative link, and the check below compares
  // text (MANUAL §6).
  const pages = new Map<string, string>();
  for (const entry of index.values()) {
    if (entry.src.source !== 'notion') continue;
    ids.set(entry.path, entry.src.id);
    pages.set(bareId(entry.src.id), entry.path);
  }

  /** The uploads each document already made, so pass two does not repeat them. */
  const uploadsFor = new Map<string, ReadonlyMap<string, string>>();
  const added = changes.filter((change) => change.kind === 'added');
  const creating = new Set(added.map((change) => change.path));

  // Pass one: create every new page, in path order so that a parent page is
  // made before the children whose path implies it.
  const revisit: FileChange[] = [];
  for (const change of [...added].sort((a, b) => a.path.localeCompare(b.path))) {
    const document = read(change);
    const parent = parentId(change.path, root, ids);
    const title = document.frontmatter?.title ?? titleFromPath(change.path);
    // A new page brings its files with it: every one it links has to be
    // uploaded before a block can point at it (MANUAL §12 phase 2).
    const result = await uploadAssets(
      api,
      assetLinksOf(document.body.children, change.path),
      change.assets ?? new Map(),
      change.path,
    );
    count(change.path, result);
    const blocks = mdastToBlocks(document.body, {
      from: change.path,
      ids,
      uploads: result.uploads,
      skippedAssets: new Set(result.skipped.map((one) => one.path)),
    });
    uploadsFor.set(change.path, result.uploads);

    const id = bareId(await writer.createPage(parent, title, blocks));
    ids.set(change.path, id);
    // Anything it links to that this push has not created yet came out as a
    // plain link, so the body has to be written again once the id exists.
    if (linksTo(change, creating).some((target) => !ids.has(target))) revisit.push(change);
    report.push({ path: change.path, title, action: 'created' });
  }

  // Pass two: the bodies whose links have only now become resolvable.
  for (const change of revisit) {
    const document = read(change);
    const id = ids.get(change.path);
    if (id === undefined) continue;
    await writer.replaceBody(
      id,
      mdastToBlocks(document.body, {
        from: change.path,
        ids,
        uploads: uploadsFor.get(change.path) ?? new Map(),
      }),
    );
  }

  for (const change of changes) {
    if (change.kind === 'added') continue;
    const id = idFor(change, ids);
    if (id === undefined) {
      // A file with no id was never at the source (MANUAL §8).
      continue;
    }

    if (change.kind === 'deleted') {
      await writer.archivePage(id);
      report.push({ path: change.path, title: titleFromPath(change.path), action: 'trashed' });
      continue;
    }

    const document = read(change);
    const renamed = change.kind === 'renamed';
    // A rename with no content carries no frontmatter to read the title from,
    // so the new filename is the title — which is where it came from.
    const title = document.frontmatter?.title ?? (renamed ? titleFromPath(change.path) : undefined);

    // A rename is told by the change itself; a title edited in the frontmatter
    // of a file that only changed is told by the page (MANUAL §6).
    const wanted =
      title === undefined
        ? undefined
        : renamed || title !== titleOf(await api.page(id))
          ? title
          : undefined;
    if (wanted !== undefined) await writer.renamePage(id, wanted);

    const patched =
      change.text === undefined
        ? undefined
        : await patchPage(api, writer, id, change, document.body, {
            ids,
            pages,
            assets: assetLinks(index, change.previousPath ?? change.path),
          });
    const blocks = patched?.counts;
    if (patched !== undefined) {
      count(change.path, patched);
      uploadsFor.set(change.path, patched.uploads);
    }

    report.push({
      path: change.path,
      title: title ?? titleFromPath(change.path),
      action: change.text === undefined ? 'renamed' : 'updated',
      ...(blocks === undefined ? {} : { blocks }),
    });
  }

  // Bytes that changed under a block nothing else rewrote: the same block, the
  // same id, the same comments, a new file (MANUAL §7, §12 phase 2).
  for (const change of assetChanges) {
    if (change.kind === 'deleted' || change.bytes === undefined) continue;
    const entry = index.get(change.previousPath ?? change.path);
    if (entry?.type !== 'asset') continue;
    const document = entry.document ?? documentOfAssetsDir(change.path) ?? '';
    if (uploadsFor.get(document)?.has(change.path) === true) continue;

    const block = await api.block(entry.src.id);
    const result = await uploadAssets(
      api,
      [change.path],
      new Map([[change.path, change.bytes]]),
      document,
    );
    count(document, result);
    const upload = result.uploads.get(change.path);
    if (upload === undefined) continue;
    const name = change.path.slice(change.path.lastIndexOf('/') + 1);
    await api.updateBlock(entry.src.id, fileUploadBody(block, upload, name));
    if (!report.some((one) => one.path === document)) {
      report.push({ path: document, title: titleFromPath(document), action: 'updated' });
    }
  }

  // The counts go on the line of the document they belong to (MANUAL §12).
  return report.map((one) => ({
    ...one,
    ...((uploaded.get(one.path) ?? 0) === 0 ? {} : { uploaded: uploaded.get(one.path) }),
    ...(skippedFiles.has(one.path) ? { skippedFiles: skippedFiles.get(one.path) } : {}),
  }));
}

/**
 * One modified page, patched (MANUAL §7).
 *
 * The live page is read and converted, and has to say exactly what the version
 * this push started from says. Push step 1 has already made that true for the
 * whole checkout; checking it here makes it local, and makes the alignment
 * between the base blocks and the live ones — the *n*th is the *n*th — a fact
 * rather than an assumption. What the diff then says is the only thing written.
 */
async function patchPage(
  api: NotionApi,
  writer: NotionWriter,
  id: string,
  change: FileChange,
  body: MdastRoot,
  maps: {
    ids: ReadonlyMap<string, string>;
    pages: ReadonlyMap<string, string>;
    assets: ReadonlyMap<string, string>;
  },
): Promise<{
  counts: BlockCounts;
  uploads: Map<string, string>;
  skipped: { path: string; reason: string }[];
}> {
  if (change.previousText === undefined) {
    throw new PushError(
      'there is no base version of this file to patch the page from; fetch, merge and push again',
      change.path,
    );
  }

  const live = await api.blockTree(id);
  const base = parseDocument(change.previousText).body;
  const from = change.path;
  // The live page has to be read the way the file was written, files and all,
  // or a page with an attachment would look changed to the check below
  // (MANUAL §12 phase 2).
  const assets = maps.assets;
  // Both sides go through the one pipeline before they are compared, so that a
  // spelling the dialect accepts either way — the escaped callout marker
  // (MANUAL §6) — is not mistaken for someone else's edit.
  const liveBody = parseMarkdown(blocksToMarkdown(live, { pages: maps.pages, from, assets }));
  if (stringifyMarkdown(liveBody) !== stringifyMarkdown(base)) {
    throw new PushError(
      'the source changed: the Notion page is not the version this push started from; fetch, merge and push again',
      from,
    );
  }

  const ops = diffBlocks(base, body);
  // Only the blocks this push writes need a file upload behind them: a block
  // it keeps already points at the file Notion has (MANUAL §12 phase 2).
  const needed = new Set<string>();
  for (const path of createdLinks(ops, from)) needed.add(path);
  const result = await uploadAssets(api, needed, change.assets ?? new Map(), from);

  const plan = planPatch(id, live, ops, {
    from,
    ids: maps.ids,
    path: from,
    uploads: result.uploads,
    skippedAssets: new Set(result.skipped.map((one) => one.path)),
  });
  await writer.patchBody(plan.operations);
  return { counts: plan.counts, uploads: result.uploads, skipped: result.skipped };
}

/** Where a document's attachments live, by the block id that points at them. */
function assetLinks(index: DocumentIndex, documentPath: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const entry of index.values()) {
    if (entry.type === 'asset' && entry.document === documentPath) {
      // `to-markdown.ts` looks a block up by its undashed id, and an index
      // written by hand may well hold the dashed one Notion answers with.
      links.set(bareId(entry.src.id), entry.path);
    }
  }
  return links;
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

/** The file as frontmatter and body. A change with no text has an empty body. */
function read(change: FileChange) {
  return parseDocument(change.text ?? '');
}

/** The page a change is about: its frontmatter id, or what the index knows. */
function idFor(change: FileChange, ids: ReadonlyMap<string, string>): string | undefined {
  const frontmatter = read(change).frontmatter;
  if (frontmatter?.id?.source === 'notion') return frontmatter.id.id;
  return ids.get(change.previousPath ?? change.path) ?? ids.get(change.path);
}

/**
 * The page a new file belongs under. A page with children owns the sibling
 * directory of the same stem (MANUAL §6), so the parent of `A/B/C.md` is the
 * page at `A/B.md`; a file the root's own directory holds belongs to the root.
 */
function parentId(path: string, root: Root, ids: ReadonlyMap<string, string>): string {
  const directory = path.slice(0, path.lastIndexOf('/'));
  return ids.get(`${directory}.md`) ?? bareId(root.src.id);
}

/** A filename without its extension, which is a title when nothing else is. */
function titleFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}

/** The paths in `creating` that this file links to. */
function linksTo(change: FileChange, creating: ReadonlySet<string>): string[] {
  const targets: string[] = [];
  visit(read(change).body, 'link', (node: Link) => {
    if (!node.url.endsWith('.md') || /^[a-z][a-z0-9+.-]*:/i.test(node.url)) return;
    const target = resolvePath(change.path, node.url);
    if (creating.has(target)) targets.push(target);
  });
  return targets;
}

export type { ChangeKind, FileChange, PushedDocument, PushReport } from '../push-types.js';
