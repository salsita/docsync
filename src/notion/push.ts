/**
 * One root's diff, applied to Notion (MANUAL §7, §8).
 *
 * `pushRoot` is the whole public surface and the mirror of `fetchRoot`: files
 * in, a report out. It decides *order* — creations before the links that point
 * at them can resolve, deletions last — and leaves every request to `write.ts`
 * and every conversion to `from-markdown.ts`. No disk, no git.
 */
import type { Link } from 'mdast';
import { visit } from 'unist-util-visit';
import type { CredentialProvider } from '../auth/index.js';
import { parseDocument } from '../frontmatter.js';
import type { DocumentIndex } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { NotionApi } from './api.js';
import { type BlockInput, mdastToBlocks, resolvePath } from './from-markdown.js';
import { notionApi } from './index.js';
import { bareId } from './to-markdown.js';
import { titleOf } from './walk.js';
import { createNotionWriter } from './write.js';

/** What git says happened to one file. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** One changed file, as the helper reads it out of the pushed commits. */
export interface FileChange {
  kind: ChangeKind;
  /** Repo-relative path, `/`-separated, as of after the change. */
  path: string;
  /** Where a renamed file came from. */
  previousPath?: string;
  /**
   * The whole file, frontmatter included. Absent for a deletion, and absent
   * for a rename whose content did not change — which is what makes such a
   * rename one API call and nothing more.
   */
  text?: string;
}

/** What a push did to one document, for the CLI to print (ticket 10). */
export interface PushedDocument {
  path: string;
  title: string;
  action: 'created' | 'updated' | 'renamed' | 'trashed';
}

export type PushReport = PushedDocument[];

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
  for (const entry of index.values()) {
    if (entry.src.source === 'notion') ids.set(entry.path, entry.src.id);
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

    if (change.text !== undefined) {
      const blocks: BlockInput[] = mdastToBlocks(document.body, { from: change.path, ids });
      await writer.replaceBody(id, blocks);
    }

    report.push({
      path: change.path,
      title: title ?? titleFromPath(change.path),
      action: change.text === undefined ? 'renamed' : 'updated',
    });
  }

  return report;
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
