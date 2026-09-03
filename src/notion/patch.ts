/**
 * The block diff, turned into the calls that patch a live Notion page (§7).
 *
 * Pure: live blocks and ops in, a list of operations out, so that what a push
 * would do to a page is a thing a test can look at. `write.ts` performs them,
 * in the order this module puts them in: **updates** first, then **inserts**
 * from the bottom of the document up, then **deletes**. Deletes last is what
 * lets an insertion be positioned after a block that is on its way out, and
 * therefore lets a block that moved be a delete and an insert without either
 * of them having to know about the other.
 *
 * The alignment is positional: the *n*th block of the base version is the *n*th
 * block Notion holds, once the blocks the dialect does not write are taken out
 * — a child page, a child database, an empty paragraph — and once a paragraph's
 * or a heading's own children are laid out beside it, which is how
 * `to-markdown.ts` writes them. `push.ts` has already required the live page to
 * convert to the base text, so this alignment is a consequence, not a hope; a
 * page that does not line up all the same is refused rather than guessed at.
 */
import type { Root } from 'mdast';
import type { BlockCounts, BlockOp, DiffBlock } from '../diff/blocks.js';
import { PushError } from '../push-types.js';
import type { NotionBlock, RawObject } from './api.js';
import { type BlockInput, type FromMarkdownOptions, mdastToBlocks } from './from-markdown.js';
import { mergeRichText } from './rich-text-merge.js';
import type { RichText } from './to-markdown.js';

/** One call a patch makes. */
export type PatchOperation =
  | { kind: 'update'; id: string; body: RawObject }
  | { kind: 'insert'; parentId: string; after?: string; blocks: BlockInput[] }
  | { kind: 'delete'; id: string };

export interface PatchPlan {
  operations: PatchOperation[];
  counts: BlockCounts;
}

export interface PatchOptions extends FromMarkdownOptions {
  /** The file the ops came from, for the message of a refusal. */
  path?: string;
}

/** Block types that are documents of their own and never in a body (§6). */
const OWN_FILE = new Set(['child_page', 'child_database']);

/** Blocks whose children `to-markdown.ts` writes beside them, not under them. */
const FLATTENED = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3']);

/** One live block, with the id an insertion beside it must name. */
interface Aligned {
  block: NotionBlock;
  /**
   * The id of the block's own ancestor that is a direct child of the level's
   * parent — itself, unless it came from a flattened paragraph's children. An
   * append can only be positioned after a direct child.
   */
  anchorId: string;
}

/** What a push must do to `live` to make it say what the ops say. */
export function planPatch(
  pageId: string,
  live: readonly NotionBlock[],
  ops: readonly BlockOp[],
  options: PatchOptions = {},
): PatchPlan {
  const updates: PatchOperation[] = [];
  const inserts: PatchOperation[] = [];
  const deletes: PatchOperation[] = [];
  const counts: BlockCounts = { kept: 0, updated: 0, inserted: 0, deleted: 0 };

  /** One level of the tree: the ops over the live blocks under `parentId`. */
  function level(parentId: string, blocks: readonly Aligned[], levelOps: readonly BlockOp[]): void {
    let anchor: string | undefined;
    let pending: BlockInput[] = [];
    let pendingAnchor: string | undefined;

    /**
     * The live block a base block stands for: the *n*th of this level, by the
     * position the base block had. Position and not a running cursor, because a
     * move is reported where the block landed, not where it was.
     */
    const take = (base: DiffBlock): Aligned => {
      const found = blocks[base.index];
      if (found === undefined) {
        throw new PushError(
          'the source changed: Notion has fewer blocks than the version this push started from',
          options.path,
        );
      }
      return found;
    };
    const open = (): void => {
      if (pending.length === 0) pendingAnchor = anchor;
    };
    const flush = (): void => {
      if (pending.length === 0) return;
      inserts.push({
        kind: 'insert',
        parentId,
        ...(pendingAnchor === undefined ? {} : { after: pendingAnchor }),
        blocks: pending,
      });
      pending = [];
    };

    for (const op of levelOps) {
      if (op.op === 'insert') {
        open();
        pending.push(...payload(op.next, options));
        counts.inserted += 1;
        continue;
      }

      if (op.op === 'delete' || op.op === 'move') {
        const found = take(op.base);
        if (op.op === 'move') refuseIfPlaceholder(op.base, 'move', options);
        deletes.push({ kind: 'delete', id: found.block.id });
        counts.deleted += 1;
        if (op.op === 'move') {
          // The copy goes where the block now belongs; the original is still
          // there when the append runs, so it can be the anchor itself.
          if (pending.length === 0) pendingAnchor = anchor ?? found.anchorId;
          pending.push(...payload(op.next, options));
          counts.inserted += 1;
        } else {
          // A deleted block is deleted last, so it is a good anchor.
          anchor = found.anchorId;
        }
        continue;
      }

      const found = take(op.base);
      if (pending.length > 0 && pendingAnchor === undefined) {
        // Nothing to append after: Notion appends at the end of a container
        // unless it is told which block to go behind, and there is no "before".
        // The first surviving block is written again after the new ones and the
        // original deleted — the one block a prepend costs (MANUAL §7).
        refuseIfPlaceholder(op.base, 'move', options);
        deletes.push({ kind: 'delete', id: found.block.id });
        pendingAnchor = found.anchorId;
        pending.push(...payload(op.next, options));
        counts.deleted += 1;
        counts.inserted += 1;
        continue;
      }
      flush();

      if (op.op === 'update') {
        update(found.block, op.base, op.next, options, updates);
        counts.updated += 1;
      } else counts.kept += 1;

      level(found.block.id, bodyBlocks(found.block.children ?? [], found.block.id), op.children);
      anchor = found.anchorId;
    }
    flush();
  }

  level(pageId, bodyBlocks(live, pageId), ops);
  // Bottom up, so that an append never depends on one made after it.
  return { operations: [...updates, ...inserts.reverse(), ...deletes], counts };
}

/** One update call: the block's own fields, with its rich text merged in. */
function update(
  live: NotionBlock,
  base: DiffBlock,
  next: DiffBlock,
  options: PatchOptions,
  out: PatchOperation[],
): void {
  refuseIfPlaceholder(base, 'update', options);
  const [block] = payload(next, options);
  if (block === undefined) return;
  if (block.type !== live.type) {
    // The dialect saw the same kind of block, Notion does not. Nothing here can
    // change a block's type, so this is left to the caller's own guard.
    throw new PushError(
      `cannot change a ${live.type} block into a ${block.type} block in place`,
      options.path,
    );
  }

  const body = { ...((block[block.type] as RawObject | undefined) ?? {}) };
  delete body.children;
  const liveBody = (live[live.type] ?? {}) as RawObject;

  if (Array.isArray(liveBody.rich_text) && base.inline !== undefined && next.inline !== undefined) {
    body.rich_text = mergeRichText(
      liveBody.rich_text as RichText[],
      base.inline,
      next.inline,
      options,
    );
  }
  if (Array.isArray(liveBody.cells) && base.cells !== undefined && next.cells !== undefined) {
    const cells = liveBody.cells as RichText[][];
    body.cells = next.cells.map((cell, column) =>
      mergeRichText(cells[column] ?? [], base.cells?.[column] ?? [], cell, options),
    );
  }

  out.push({ kind: 'update', id: live.id, body: { [live.type]: body } });
}

/** A block the dialect only carries as a placeholder is not ours to change. */
function refuseIfPlaceholder(block: DiffBlock, what: string, options: PatchOptions): void {
  if (!block.type.startsWith('placeholder:')) return;
  const type = block.type.slice('placeholder:'.length);
  throw new PushError(
    `a ${type} block cannot be ${what === 'update' ? 'edited' : 'moved'} through docsync; ` +
      `change it in Notion, or delete the line to delete the block`,
    options.path,
  );
}

/** One block as create requests: what an insertion sends. */
function payload(block: DiffBlock, options: FromMarkdownOptions): BlockInput[] {
  const tree: Root = { type: 'root', children: [...block.source] };
  const blocks = mdastToBlocks(tree, options);
  // A row's source is a table holding only that row, since a row cannot be
  // converted on its own; what goes in is the row.
  if (block.type === 'tableRow') return blocks[0]?.children ?? [];
  return blocks;
}

/**
 * The live blocks the dialect writes, in the order it writes them: a child page
 * and a child database are documents of their own, an empty paragraph has no
 * Markdown at all, and a paragraph's or heading's children are written beside
 * it rather than under it.
 */
function bodyBlocks(
  blocks: readonly NotionBlock[],
  parentId: string,
  anchorId?: string,
): Aligned[] {
  const out: Aligned[] = [];
  for (const block of blocks) {
    if (OWN_FILE.has(block.type) || isEmptyParagraph(block)) continue;
    const anchor = anchorId ?? block.id;
    out.push({ block, anchorId: anchor });
    if (isFlattened(block) && block.children !== undefined) {
      out.push(...bodyBlocks(block.children, parentId, anchor));
    }
  }
  return out;
}

/**
 * Whether `to-markdown.ts` writes this block's children beside it rather than
 * under it. A toggle heading is a toggle, so its children are its own; a plain
 * heading's and a paragraph's are written as blocks that follow it.
 */
function isFlattened(block: NotionBlock): boolean {
  if (!FLATTENED.has(block.type)) return false;
  return ((block[block.type] ?? {}) as RawObject).is_toggleable !== true;
}

/** An empty paragraph writes no Markdown, so no diff can speak for it. */
function isEmptyParagraph(block: NotionBlock): boolean {
  if (block.type !== 'paragraph') return false;
  const rich = ((block.paragraph ?? {}) as RawObject).rich_text;
  return Array.isArray(rich) && rich.length === 0 && (block.children ?? []).length === 0;
}
