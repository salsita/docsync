/**
 * Root ref to page tree (MANUAL §4, §6).
 *
 * The Notion API has no "list the child pages" call, so the tree is the
 * `child_page` blocks of each page's block list. Along the way this module
 * decides every file's path — names from `src/manifest/`, so that collisions,
 * hostile titles and stable renaming are decided in exactly one place — and
 * drops what the root's ignore list excludes.
 *
 * It fetches; it does not convert. The blocks it collected ride along on each
 * page so that `index.ts` can hand them to `to-markdown.ts` without a second
 * pass over the API.
 */
import { assignNames, fileNameFor, isIgnored } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type { SourceRef } from '../source-ref.js';
import type { NotionApi, NotionBlock, RawObject } from './api.js';
import { bareId } from './to-markdown.js';

/** One page that will become one file. */
export interface WalkedPage {
  /** 32 hex digits, no dashes. */
  id: string;
  ref: SourceRef;
  title: string;
  /** Repo-relative path of this page's Markdown file. */
  path: string;
  /** ISO 8601, as Notion reports it. */
  lastEditedTime: string;
  /** The id of whoever edited it last, when Notion says. */
  lastEditedBy?: string;
  /** The page's own blocks, child pages included, as recorded. */
  blocks: NotionBlock[];
  children: WalkedPage[];
}

/** Something under the root that is deliberately not checked out. */
export interface SkippedObject {
  id: string;
  title: string;
  /** The path it would have taken, so a report can name it. */
  path: string;
  /** `database`: no dialect for it. `ignored`: the root's ignore list. */
  reason: 'database' | 'ignored';
}

export interface WalkResult {
  root: WalkedPage;
  /** Every page, root first, in document order. */
  pages: WalkedPage[];
  skipped: SkippedObject[];
}

/**
 * Walks one root. `previous` maps a page id to the repo-relative path it had
 * at the last fetch, which is what keeps a name (`Notes (2).md`) attached to
 * the same page even when a sibling appears or disappears.
 */
export async function walkRoot(
  api: NotionApi,
  root: Root,
  previous: ReadonlyMap<string, string> = new Map(),
): Promise<WalkResult> {
  const pages: WalkedPage[] = [];
  const skipped: SkippedObject[] = [];

  const directoryRoot = root.path.endsWith('/');
  const rootId = bareId(root.src.id);
  const rootPage = await api.page(rootId);
  const path = directoryRoot ? `${root.path}${fileNameFor(titleOf(rootPage), '.md')}` : root.path;

  // Ignore patterns are relative to the root object (MANUAL §4), which on disk
  // is the directory holding the root page's children: a child of the root is
  // `Blocks.md` and its own child is `Blocks/Nested.md`, whatever the root
  // itself is called.
  const base = `${path.slice(0, -'.md'.length)}/`;

  /**
   * Names one page's children, then walks each of them that survives.
   * `ancestors` is the chain between the root and this page, both excluded,
   * which is what lets a source-ref ignore entry exclude a whole subtree. The
   * root itself is never ignored (MANUAL §4), so it is never in the chain.
   */
  async function visit(
    id: string,
    title: string,
    path: string,
    ancestors: readonly SourceRef[],
  ): Promise<WalkedPage> {
    const [page, blocks] = await Promise.all([api.page(id), api.blockTree(id)]);
    const node: WalkedPage = {
      id,
      ref: { source: 'notion', id },
      title,
      path,
      lastEditedTime: String(page.last_edited_time ?? ''),
      lastEditedBy: idOf(page.last_edited_by),
      blocks,
      children: [],
    };
    pages.push(node);

    // A page with children owns the sibling directory of the same stem.
    const directory = `${path.slice(0, -'.md'.length)}/`;
    const childBlocks = blocks.filter((block) => block.type === 'child_page');
    const names = assignNames(
      childBlocks.map((block) => ({
        id: bareId(block.id),
        title: childTitle(block),
        ext: '.md',
      })),
      namesIn(previous, directory),
    );

    for (const block of blocks) {
      const childId = bareId(block.id);
      if (block.type === 'child_database') {
        skipped.push({
          id: childId,
          title: childTitle(block),
          path: `${directory}${fileNameFor(childTitle(block), '')}`,
          reason: 'database',
        });
        continue;
      }
      if (block.type !== 'child_page') continue;

      const childPath = `${directory}${names.get(childId) ?? fileNameFor(childTitle(block), '.md')}`;
      const ref: SourceRef = { source: 'notion', id: childId };
      if (isIgnored(root, childPath.slice(base.length), ref, ancestors)) {
        skipped.push({
          id: childId,
          title: childTitle(block),
          path: childPath,
          reason: 'ignored',
        });
        continue;
      }
      node.children.push(
        await visit(childId, childTitle(block), childPath, [
          ...ancestors,
          ...(id === rootId ? [] : [node.ref]),
        ]),
      );
    }

    return node;
  }

  const rootNode = await visit(rootId, titleOf(rootPage), path, []);
  return { root: rootNode, pages, skipped };
}

/** The previous names of the files in one directory, by page id. */
function namesIn(
  previous: ReadonlyMap<string, string>,
  directory: string,
): Map<string, string> | undefined {
  const names = new Map<string, string>();
  for (const [id, path] of previous) {
    const cut = path.lastIndexOf('/') + 1;
    if (path.slice(0, cut) === directory) names.set(id, path.slice(cut));
  }
  return names.size === 0 ? undefined : names;
}

/** The title of a page object, wherever Notion happened to put it. */
export function titleOf(page: RawObject): string {
  const direct = plainText(page.title);
  if (direct !== undefined) return direct;
  const properties = page.properties;
  if (typeof properties === 'object' && properties !== null) {
    for (const property of Object.values(properties as Record<string, unknown>)) {
      if (typeof property !== 'object' || property === null) continue;
      const typed = property as { type?: string; title?: unknown };
      if (typed.type === 'title') return plainText(typed.title) ?? '';
    }
  }
  return '';
}

/** The title Notion puts on a `child_page` or `child_database` block. */
function childTitle(block: NotionBlock): string {
  const body = block[block.type];
  if (typeof body !== 'object' || body === null) return '';
  const title = (body as RawObject).title;
  return typeof title === 'string' ? title : '';
}

/** The plain text of a rich-text array, or undefined if it is not one. */
function plainText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((part) => String((part as { plain_text?: string }).plain_text ?? '')).join('');
}

/** The id inside a `{ object: 'user', id }` reference. */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as RawObject).id;
  return typeof id === 'string' ? id : undefined;
}
