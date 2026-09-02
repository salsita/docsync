/**
 * The four things a push does to Notion (MANUAL §7, §8).
 *
 * `from-markdown.ts` answers a block tree; this module turns that tree into
 * requests the API will actually accept, which is where every Notion limit
 * lives: a hundred children per append, two levels of nesting per request,
 * two thousand characters per rich-text run, a hundred runs per block. Above
 * this module nobody has to know any of that.
 *
 * Write-back is a full replace in phase 1: every block except a child page or
 * a child database is deleted and the body regenerated. Deleting a block
 * archives it, which is why those two — documents of their own — are the only
 * things left standing.
 */
import type { NotionApi, RawObject } from './api.js';
import type { BlockInput } from './from-markdown.js';

/** Children per `blocks.children.append` request. */
const CHUNK = 100;

/** Levels of children one request may nest. Deeper levels are appended after. */
const INLINE_DEPTH = 2;

/** Characters per rich-text run. */
const RUN_LENGTH = 2000;

/** Rich-text items per block. */
const RUN_COUNT = 100;

/** Fields Notion computes for a rich-text run and refuses to be told. */
const COMPUTED = ['plain_text', 'href'] as const;

/** The write operations, over an injected API so tests need no network. */
export interface NotionWriter {
  /** Deletes everything but the child pages, then writes the body back. */
  replaceBody(pageId: string, blocks: readonly BlockInput[]): Promise<void>;
  /** Creates a page under a parent page. Answers the new page's id. */
  createPage(parentId: string, title: string, blocks: readonly BlockInput[]): Promise<string>;
  /** Changes a page's title. */
  renamePage(pageId: string, title: string): Promise<void>;
  /** Moves a page to the trash. Reversible from the Notion UI (MANUAL §8). */
  archivePage(pageId: string): Promise<void>;
}

export function createNotionWriter(api: NotionApi): NotionWriter {
  /**
   * Appends a run of blocks under one parent, in chunks, following each
   * request with the children it was too deep to carry.
   */
  async function appendAll(parentId: string, blocks: readonly BlockInput[]): Promise<void> {
    for (let at = 0; at < blocks.length; at += CHUNK) {
      const chunk = blocks.slice(at, at + CHUNK).map((block) => layout(block, INLINE_DEPTH));
      const created = await api.append(
        parentId,
        chunk.map((one) => one.payload),
      );

      for (const [index, one] of chunk.entries()) {
        const top = created[index];
        if (top === undefined) continue;
        for (const deferred of one.deferred) {
          await appendAll(await resolve(top.id, deferred.path), deferred.children);
        }
      }
    }
  }

  /** The id of the block at `path` below `id`, by position. */
  async function resolve(id: string, path: readonly number[]): Promise<string> {
    let current = id;
    for (const index of path) {
      const children = await api.children(current);
      const child = children[index];
      if (child === undefined) return current;
      current = child.id;
    }
    return current;
  }

  return {
    async replaceBody(pageId, blocks) {
      for (const block of await api.children(pageId)) {
        // Deleting a `child_page` block archives the page it stands for, and a
        // child page is a document of its own; a `child_database` is the same
        // for a database, which the dialect never carries (MANUAL §6, §7).
        if (block.type === 'child_page' || block.type === 'child_database') continue;
        await api.deleteBlock(block.id);
      }
      await appendAll(pageId, blocks);
    },

    async createPage(parentId, title, blocks) {
      // The body rides along with the create when the whole of it fits in one
      // request; otherwise the page is created empty and filled after, since a
      // create response does not name the blocks it made.
      const prepared = blocks.length <= CHUNK ? blocks.map((one) => layout(one, INLINE_DEPTH)) : [];
      const fits = blocks.length <= CHUNK && prepared.every((one) => one.deferred.length === 0);

      const page = await api.createPage(
        parentId,
        title,
        fits ? prepared.map((one) => one.payload) : undefined,
      );
      const id = String(page.id ?? '');
      if (!fits) await appendAll(id, blocks);
      return id;
    },

    async renamePage(pageId, title) {
      await api.updatePage(pageId, { title });
    },

    async archivePage(pageId) {
      await api.updatePage(pageId, { archived: true });
    },
  };
}

/** Children one request could not carry, and where under the block they go. */
interface Deferred {
  /** Indices from the appended block down to the parent they belong to. */
  path: number[];
  children: BlockInput[];
}

interface Prepared {
  payload: RawObject;
  deferred: Deferred[];
}

/**
 * One block as a request, with as much of its subtree as `budget` levels of
 * nesting allow. What does not fit comes back as `deferred`, to be appended by
 * the id of the block it belongs under once that block exists.
 */
function layout(block: BlockInput, budget: number): Prepared {
  const type = block.type;
  const body: RawObject = { ...((block[type] as RawObject | undefined) ?? {}) };

  if (Array.isArray(body.rich_text)) body.rich_text = runs(body.rich_text);
  if (Array.isArray(body.caption)) body.caption = runs(body.caption);
  if (Array.isArray(body.cells)) {
    body.cells = (body.cells as unknown[][]).map((cell) => runs(cell));
  }

  const children = block.children ?? [];
  const deferred: Deferred[] = [];
  const inline: RawObject[] = [];

  for (const [index, child] of children.entries()) {
    // A child needs a level for itself, plus whatever its own subtree must
    // carry in the same request. From the first one that does not fit, the
    // rest of the run is deferred as well, so that order is preserved.
    if (budget < 1 || required(child) > budget - 1) {
      deferred.push({ path: [], children: children.slice(index) });
      break;
    }
    const prepared = layout(child, budget - 1);
    inline.push(prepared.payload);
    for (const one of prepared.deferred) {
      deferred.push({ path: [index, ...one.path], children: one.children });
    }
  }

  if (inline.length > 0) body.children = inline;
  return { payload: { object: 'block', type, [type]: body }, deferred };
}

/**
 * Levels of nesting a block cannot be appended without. A table is the only
 * one: the API refuses a table whose rows are not in the same request.
 */
function required(block: BlockInput): number {
  return block.type === 'table' ? 1 : 0;
}

/** A rich-text array inside both Notion's limits. */
function runs(value: readonly unknown[]): RawObject[] {
  const split = value.flatMap((run) => splitRun(run as RawObject));
  if (split.length <= RUN_COUNT) return split;
  // Past a hundred runs the tail is flattened into one plain run rather than
  // dropped: the text is what matters, the annotations on it are not.
  const head = split.slice(0, RUN_COUNT - 1);
  const tail = split.slice(RUN_COUNT - 1);
  return [...head, plainRun(tail.map(textOf).join(''))];
}

/** A run split at the character limit; a mention or an equation is atomic. */
function splitRun(run: RawObject): RawObject[] {
  const stripped = strip(run);
  const text = run.text as { content?: string } | undefined;
  const content = text?.content;
  if (typeof content !== 'string' || content.length <= RUN_LENGTH) return [stripped];

  const pieces: RawObject[] = [];
  for (let at = 0; at < content.length; at += RUN_LENGTH) {
    pieces.push({ ...stripped, text: { ...text, content: content.slice(at, at + RUN_LENGTH) } });
  }
  return pieces;
}

/** What one run says, for the flattening above. */
function textOf(run: RawObject): string {
  const text = run.text as { content?: string } | undefined;
  if (typeof text?.content === 'string') return text.content;
  const equation = run.equation as { expression?: string } | undefined;
  return typeof equation?.expression === 'string' ? equation.expression : '';
}

function plainRun(content: string): RawObject {
  return { type: 'text', text: { content: content.slice(0, RUN_LENGTH), link: null } };
}

/** A run without the fields Notion computes and a request may not carry. */
function strip(run: RawObject): RawObject {
  const copy = { ...run };
  for (const field of COMPUTED) delete copy[field];
  return copy;
}
