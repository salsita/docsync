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
import type { CredentialProvider } from '../auth/index.js';
import { type BlockCounts, diffBlocks } from '../diff/blocks.js';
import { parseDocument } from '../frontmatter.js';
import type { DocumentIndex } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import { type FileChange, PushError, type PushReport } from '../push-types.js';
import type { NotionApi } from './api.js';
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
  changes: readonly FileChange[],
  index: DocumentIndex,
): Promise<PushReport> {
  const writer = createNotionWriter(api);
  const report: PushReport = [];

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

  const added = changes.filter((change) => change.kind === 'added');
  const creating = new Set(added.map((change) => change.path));

  // Pass one: create every new page, in path order so that a parent page is
  // made before the children whose path implies it.
  const revisit: FileChange[] = [];
  for (const change of [...added].sort((a, b) => a.path.localeCompare(b.path))) {
    const document = read(change);
    const parent = parentId(change.path, root, ids);
    const title = document.frontmatter?.title ?? titleFromPath(change.path);
    const blocks = mdastToBlocks(document.body, { from: change.path, ids });

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
    await writer.replaceBody(id, mdastToBlocks(document.body, { from: change.path, ids }));
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

    const blocks =
      change.text === undefined
        ? undefined
        : await patchPage(api, writer, id, change, document.body, { ids, pages });

    report.push({
      path: change.path,
      title: title ?? titleFromPath(change.path),
      action: change.text === undefined ? 'renamed' : 'updated',
      ...(blocks === undefined ? {} : { blocks }),
    });
  }

  return report;
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
  maps: { ids: ReadonlyMap<string, string>; pages: ReadonlyMap<string, string> },
): Promise<BlockCounts> {
  if (change.previousText === undefined) {
    throw new PushError(
      'there is no base version of this file to patch the page from; fetch, merge and push again',
      change.path,
    );
  }

  const live = await api.blockTree(id);
  const base = parseDocument(change.previousText).body;
  const from = change.path;
  // Both sides go through the one pipeline before they are compared, so that a
  // spelling the dialect accepts either way — the escaped callout marker
  // (MANUAL §6) — is not mistaken for someone else's edit.
  const liveBody = parseMarkdown(blocksToMarkdown(live, { pages: maps.pages, from }));
  if (stringifyMarkdown(liveBody) !== stringifyMarkdown(base)) {
    throw new PushError(
      'the source changed: the Notion page is not the version this push started from; fetch, merge and push again',
      from,
    );
  }

  const plan = planPatch(id, live, diffBlocks(base, body), {
    from,
    ids: maps.ids,
    path: from,
  });
  await writer.patchBody(plan.operations);
  return plan.counts;
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
