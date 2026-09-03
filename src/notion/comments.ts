/**
 * A Notion page's open comment threads (MANUAL §6).
 *
 * Notion has no call that answers a page's comments: `GET /v1/comments` takes
 * one block and answers the comments on that block alone, and asking a page
 * answers only the page-level ones. So a fetch asks once per block, with a few
 * requests in flight at a time, and the adapter's own rate limiting underneath.
 * A comment does not move the page's last-edit time, which is why this happens
 * on every fetch and not only for pages that changed.
 *
 * A thread is every comment sharing a `discussion_id`. Notion reports a comment
 * on a text selection as a comment on the whole block and gives no time finer
 * than the minute, so the anchor is the block, quoted without marks.
 */
import type { Thread } from '../comments/format.js';
import { locate } from '../comments/locate.js';
import type { NotionApi, NotionBlock, NotionComment, RawObject } from './api.js';
import { bareId } from './to-markdown.js';

/** How many comment requests are in flight at once. */
const CONCURRENCY = 8;

/** Blocks that are documents of their own, whose comments are their own. */
const OPAQUE = new Set(['child_page', 'child_database']);

/**
 * Every block of a page that can carry a comment, in document order, nested
 * blocks included. A child page is left out: its comments belong to its own
 * sidecar, which the walk reaches on its own.
 */
export function commentableBlocks(blocks: readonly NotionBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (OPAQUE.has(block.type)) continue;
    out.push(block.id);
    if (block.children !== undefined) out.push(...commentableBlocks(block.children));
  }
  return out;
}

/** The plain text of a rich-text array, as Notion computed it. */
function plainOf(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((run) => String((run as { plain_text?: unknown }).plain_text ?? '')).join('');
}

/** What one block reads as: its own rich text, and a table row's cells. */
function textOf(block: NotionBlock): string {
  const body = block[block.type];
  if (typeof body !== 'object' || body === null) return '';
  const fields = body as RawObject;
  if (Array.isArray(fields.cells)) {
    return (fields.cells as unknown[]).map((cell) => plainOf(cell)).join(' ');
  }
  return plainOf(fields.rich_text);
}

/** Runs `work` over `items`, a few at a time, keeping the order of the answers. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next; at < items.length; at = next) {
      next = at + 1;
      const item = items[at];
      if (item !== undefined) out[at] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function headingOf(heading: string | undefined): { heading?: string } {
  return heading === undefined ? {} : { heading };
}

/** One comment as a sidecar entry. */
function entryOf(comment: NotionComment): { author: string; time: string; text: string } {
  const name = comment.display_name?.resolved_name ?? comment.created_by?.id ?? '';
  return {
    author: name === '' ? 'Someone' : name,
    time: comment.created_time,
    text: plainOf(comment.rich_text).trim(),
  };
}

/**
 * The open threads of one page, anchored in the Markdown `body` a fetch just
 * produced. Threads come out in the order the walk met their blocks; a page
 * comment, which belongs to no block, comes first.
 */
export async function pageThreads(
  api: Pick<NotionApi, 'comments'>,
  pageId: string,
  blocks: readonly NotionBlock[],
  body: string,
  concurrency: number = CONCURRENCY,
): Promise<Thread[]> {
  const ids = [bareId(pageId), ...commentableBlocks(blocks)];
  const found = await mapLimit(ids, concurrency, (id) => api.comments(id));

  const text = new Map<string, string>();
  const at = (block: NotionBlock): void => {
    text.set(bareId(block.id), textOf(block));
    for (const child of block.children ?? []) at(child);
  };
  for (const block of blocks) at(block);

  // One thread per discussion, in the order the blocks were asked about.
  const threads = new Map<string, Thread>();
  for (const [order, comments] of found.entries()) {
    for (const comment of comments) {
      const id = bareId(comment.discussion_id);
      const thread = threads.get(id);
      if (thread !== undefined) {
        thread.entries.push(entryOf(comment));
        continue;
      }
      const quoted = text.get(bareId(ids[order] ?? '')) ?? '';
      // The anchor is the whole block, so there is nothing to mark inside it;
      // where the block is in the body is what says which heading it is under.
      const anchor = quoted === '' ? undefined : locate(body, quoted);
      threads.set(id, {
        id,
        kind: 'comment',
        created: comment.created_time,
        // A page comment belongs to no block: it has no anchor and sorts to the
        // top, and `order` is zero for it and one per block after.
        ...(order === 0
          ? { offset: 0 }
          : anchor === undefined
            ? {}
            : { offset: order, quote: anchor.quote, ...headingOf(anchor.heading) }),
        entries: [entryOf(comment)],
      });
    }
  }

  for (const thread of threads.values()) {
    thread.entries.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }
  return [...threads.values()];
}
