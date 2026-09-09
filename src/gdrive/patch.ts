/**
 * The block diff, turned into the `batchUpdate` that patches a live Doc (§7).
 *
 * Pure: a mapped live document and the ops in, one request array out, so that
 * what a push would do is a thing a test can read. The Notion patch is the
 * shape this mirrors (`src/notion/patch.ts`); what makes Docs its own problem
 * is that there are no block ids to address, only **indices** — so every
 * request names a number, and every number is invalidated by any request that
 * changes the length of the text before it.
 *
 * That is the whole design: requests are grouped by the index they address and
 * sent in **descending** order. A request never moves the text an earlier one
 * has yet to name, so nothing has to be re-based, and one batch does the lot.
 * Inside one index the order is delete, then insert, then style, because a
 * replacement is a deletion followed by an insertion at the same place and the
 * style of inserted text can only be set once the text is there.
 *
 * What is *not* written is the point of the ticket. An untouched paragraph is
 * never addressed, so its colour, font, size, alignment, inline images and
 * comment anchors are untouched. An edited one is addressed only over the
 * characters that changed, and `updateTextStyle` names only the attributes the
 * dialect owns, so a colour on the text around an edit survives it.
 */
import type { PhrasingContent, Root } from 'mdast';
import { resolveAssetPath } from '../assets.js';
import { type BlockCounts, type BlockOp, type DiffBlock, diffBlocks } from '../diff/blocks.js';
import {
  DEFAULT_STYLE,
  diffInline,
  type InlineStyle,
  inlineRuns,
  plainOf,
  type Span,
  type StyledRun,
} from '../diff/text.js';
import { PushError } from '../push-types.js';
import type { DocsWriteRequest } from './api.js';
import {
  BULLET_PRESETS,
  CODE_FONT,
  mdastToSegments,
  type PlannedFootnote,
  segmentsToRequests,
} from './from-markdown.js';
import { blockRanges, type LiveDocument, type Piece, type Ranged } from './ranges.js';

/** A soft line break inside a paragraph, which Docs stores as a vertical tab. */
const VERTICAL_TAB = '';

/**
 * The attributes of a text run the dialect owns, and the only ones any
 * `fields` mask here may name. Colour, highlight, size and font are not in it,
 * which is what makes them survive an edit (MANUAL §7).
 */
const TEXT_FIELDS = 'bold,italic,underline,strikethrough,weightedFontFamily,link';

/** The Docs named styles for the six heading levels. */
const HEADINGS = ['HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];

/** Block types that are one paragraph, and can be restyled into each other. */
const PARAGRAPH_LIKE = /^(paragraph|heading:[1-6]|listItem:(bullet|ordered|todo))$/;

/** Requests are grouped by index; inside one index, this is their order. */
const DELETE = 0;
const INSERT = 1;
const STYLE = 2;

export interface PatchOptions {
  /** The file the ops came from, for the message of a refusal. */
  path?: string;
  /**
   * The public URI each of the document's attachments is shared under, by
   * repo-relative path (MANUAL §12 phase 2). An inserted block that links one
   * becomes an `insertInlineImage`; one that links a file nobody staged is
   * dropped, as an image always was.
   */
  images?: ReadonlyMap<string, string>;
}

export interface PatchPlan {
  /** One `documents.batchUpdate`, in descending index order. */
  requests: DocsWriteRequest[];
  /** The bodies of footnotes an insertion created, for the second batch. */
  footnotes: PlannedFootnote[];
  counts: BlockCounts;
  /** What the API cannot create, for the report (MANUAL §7). */
  dropped: string[];
  /** Pending suggestions this push overwrote (MANUAL §7). */
  suggestions: string[];
  /** What could only be written by replacing it whole. */
  rewritten: string[];
}

/** One run of requests, and the index it is measured against. */
interface Group {
  index: number;
  phase: number;
  order: number;
  requests: DocsWriteRequest[];
  /** Footnotes created inside this group, at offsets into its requests. */
  footnotes: { offset: number; requests: (segmentId: string) => DocsWriteRequest[] }[];
}

/** What one level of the tree is written into. */
interface Level {
  /** The footnote segment, absent for the body. */
  segmentId?: string;
  /** One past the last index of the segment: what an append has to stay under. */
  end: number;
  /** How deep in the block tree, since only a top-level item can gain a bullet. */
  depth: number;
  /** Set when the blocks of this level are the rows of a table. */
  table?: { start: number; columns: number };
  /** How many list items this level is nested under: a new item goes in at that depth. */
  list?: number;
}

/** What a push must send to make the live document say what the ops say. */
export function planPatch(
  live: LiveDocument,
  ops: readonly BlockOp[],
  options: PatchOptions = {},
): PatchPlan {
  const groups: Group[] = [];
  const counts: BlockCounts = { kept: 0, updated: 0, inserted: 0, deleted: 0 };
  const dropped: string[] = [];
  const suggestions: string[] = [];
  const rewritten: string[] = [];
  let order = 0;

  function emit(
    index: number,
    phase: number,
    requests: DocsWriteRequest[],
    footnotes: Group['footnotes'] = [],
  ): void {
    if (requests.length === 0) return;
    order += 1;
    groups.push({ index, phase, order, requests, footnotes });
  }

  /* ------------------------------------------------------------ insertion */

  /**
   * One run of new blocks, written at `index` as `from-markdown.ts` writes.
   *
   * `beforeTable` says `index` is where a table starts: Docs takes no text
   * there, so the paragraph before the table is split instead (see below).
   */
  function insert(
    blocks: readonly DiffBlock[],
    index: number,
    level: Level,
    beforeTable = false,
  ): void {
    const children = blocks.flatMap((block) => [...block.source]);
    const tree: Root = { type: 'root', children };
    // At the very end of the body there is no index to insert *at*: the last
    // paragraph's newline is the last thing there is. So the newline is split
    // first, and the new blocks go into the empty paragraph that leaves behind.
    // The start of a table is the same case: the API only inserts inside a
    // paragraph, and a table is always preceded by one, whose newline is split.
    const trailing = index >= level.end;
    const split = trailing || beforeTable;
    const at = trailing ? level.end - 1 : beforeTable ? index - 1 : index;
    const base = split ? at + 1 : at;

    const { segments, dropped: lost } = mdastToSegments(tree, base, {
      ...(options.images === undefined ? {} : { images: options.images }),
      ...(options.path === undefined ? {} : { from: options.path }),
      ...(level.list === undefined ? {} : { level: level.list }),
    });
    const built = segmentsToRequests(segments);
    dropped.push(...lost);
    if (built.requests.length === 0) return;
    // The split leaves an empty paragraph behind, and the last new block goes
    // into it: without its own newline, or the empty paragraph would stay as
    // one more blank line in the document.
    if (split) {
      const last = segments.at(-1);
      const first = built.requests[0] as { insertText?: { text?: string } } | undefined;
      if (last !== undefined && last.text.endsWith('\n') && first?.insertText?.text === last.text) {
        first.insertText.text = last.text.slice(0, -1);
      }
    }

    const head: DocsWriteRequest[] = [];
    if (split) {
      head.push(
        { insertText: { location: location(at, level.segmentId), text: '\n' } },
        // The paragraph the split leaves behind is still the last paragraph's:
        // its bullet would draw an empty list item under the new text.
        {
          deleteParagraphBullets: { range: range(base, base + 1, level.segmentId) },
        },
      );
    }
    const requests = [
      ...head,
      ...built.requests.map((request) =>
        level.segmentId === undefined
          ? request
          : (stamp(request, level.segmentId) as DocsWriteRequest),
      ),
    ];
    emit(
      at,
      INSERT,
      requests,
      built.footnotes.map((footnote) => ({
        offset: head.length + footnote.requestIndex,
        requests: footnote.requests,
      })),
    );
  }

  /* -------------------------------------------------------------- editing */

  /**
   * A block the dialect only carries as a placeholder is not ours to change.
   * It can be deleted — that deletes the thing it stands for — but nothing
   * here could write it back (MANUAL §6).
   */
  function refuseIfPlaceholder(block: DiffBlock, what: 'edited' | 'moved'): void {
    if (!block.type.startsWith('placeholder:')) return;
    const type = block.type.slice('placeholder:'.length);
    throw new PushError(
      `a ${type} cannot be ${what} through docsync; change it in Google Docs, ` +
        'or delete the line to delete it',
      options.path,
    );
  }

  /** One block edited in place: only the characters that changed (MANUAL §7). */
  function edit(ranged: Ranged, base: DiffBlock, next: DiffBlock): void {
    const segmentId = ranged.segmentId;
    refuseIfPlaceholder(base, 'edited');
    if (base.type !== next.type) restyle(ranged, next);

    if (base.cells !== undefined && next.cells !== undefined) {
      for (const [column, cell] of (ranged.cells ?? []).entries()) {
        spans(cell.pieces, base.cells[column] ?? [], next.cells[column] ?? [], segmentId);
      }
      return;
    }
    if (base.inline === undefined || next.inline === undefined) return;

    // A paragraph carrying a pending suggestion cannot be edited around: the
    // API can neither accept nor reject one, so the text is written over and
    // the suggestion resolves by being overwritten (MANUAL §7, ticket 17).
    if (ranged.suggestions.length > 0 && plainOf(base.inline) !== plainOf(next.inline)) {
      suggestions.push(...ranged.suggestions);
      rewrite(ranged, next.inline, segmentId);
      return;
    }
    spans(ranged.pieces, base.inline, next.inline, segmentId);
  }

  /** The character diff of one stretch of text, as requests. */
  function spans(
    pieces: readonly Piece[],
    base: readonly PhrasingContent[],
    next: readonly PhrasingContent[],
    segmentId?: string,
  ): void {
    const { spans: found, styles } = diffInline(base, next);
    const baseRuns = inlineRuns(base);
    const nextRuns = inlineRuns(next);

    for (const span of found) {
      if (span.kind === 'keep') continue;
      const at = indexAt(pieces, span.base);
      if (span.kind === 'delete') {
        const to = indexAt(pieces, span.base + span.text.length, true);
        if (to > at) {
          emit(at, DELETE, [{ deleteContentRange: { range: range(at, to, segmentId) } }]);
        }
        continue;
      }
      insertSpan(span, at, baseRuns, nextRuns, segmentId);
    }

    // The style of text that stayed: only the attributes that disagree, so
    // nothing else about the run is named and nothing else changes.
    for (const change of styles) {
      const from = baseOffset(found, change.at);
      const at = indexAt(pieces, from);
      const to = indexAt(pieces, from + change.length, true);
      if (to <= at) continue;
      const fields = Object.keys(change.style)
        .flatMap((key) => fieldOf(key))
        .join(',');
      if (fields === '') continue;
      emit(at, STYLE, [
        {
          updateTextStyle: {
            range: range(at, to, segmentId),
            textStyle: textStyle({ ...DEFAULT_STYLE, ...change.style }, Object.keys(change.style)),
            fields,
          },
        },
      ]);
    }
  }

  /**
   * New text inside a block. It inherits the style of the character before it,
   * which is what a colour or a size around the edit needs; the attributes the
   * dialect owns are set only where the new text disagrees with what it landed
   * in.
   *
   * An image is not text: the run that stands for one is one object
   * replacement character in the span, and what goes out for it is
   * `insertInlineImage` at the index it reached — one code unit, the same
   * width the character had (ticket 23).
   */
  function insertSpan(
    span: Span,
    at: number,
    baseRuns: readonly StyledRun[],
    nextRuns: readonly StyledRun[],
    segmentId?: string,
  ): void {
    const requests: DocsWriteRequest[] = [];
    const styles: DocsWriteRequest[] = [];
    const inherited = styleAt(baseRuns, span.base === 0 ? 0 : span.base - 1);

    // Where the next character goes, and the text still to be written as one
    // request: an image splits the span, since it is written as an object.
    let cursor = at;
    let pending = '';
    let pendingAt = at;
    const flush = (): void => {
      if (pending === '') return;
      requests.push({
        insertText: {
          location: location(pendingAt, segmentId),
          // A line break inside one block is a vertical tab, never a newline:
          // a newline would cut the paragraph in two (MANUAL §6).
          text: pending.replaceAll('\n', VERTICAL_TAB),
        },
      });
      pending = '';
    };

    for (const run of slice(nextRuns, span.next, span.next + span.text.length)) {
      if (run.image !== undefined) {
        flush();
        const uri = imageUri(run.image);
        // An image whose file nobody staged cannot be created, and is dropped
        // rather than written as the character standing in for it.
        if (uri === undefined) {
          dropped.push('image');
          continue;
        }
        requests.push({ insertInlineImage: { location: location(cursor, segmentId), uri } });
        cursor += 1;
        pendingAt = cursor;
        continue;
      }
      if (run.text === '') continue;
      if (pending === '') pendingAt = cursor;
      pending += run.text;
      const from = cursor;
      cursor += run.text.length;
      if (sameStyle(run.style, inherited)) continue;
      styles.push({
        updateTextStyle: {
          range: range(from, cursor, segmentId),
          textStyle: textStyle(run.style),
          fields: TEXT_FIELDS,
        },
      });
    }
    flush();
    // The style of text can only be set once the text is there.
    emit(at, INSERT, [...requests, ...styles]);
  }

  /** The public URI an image link is created from, if the push staged one. */
  function imageUri(url: string): string | undefined {
    const path = resolveAssetPath(options.path ?? '', url);
    return path === undefined ? undefined : options.images?.get(path);
  }

  /** One block's text replaced whole, its paragraph and its newline kept. */
  function rewrite(ranged: Ranged, next: readonly PhrasingContent[], segmentId?: string): void {
    const to = ranged.end - 1;
    if (to > ranged.start) {
      emit(ranged.start, DELETE, [
        { deleteContentRange: { range: range(ranged.start, to, segmentId) } },
      ]);
    }
    emit(ranged.start, INSERT, runRequests(inlineRuns(next), ranged.start, segmentId));
  }

  /**
   * The text of a run of styled text, written at an index from nothing. An
   * image is not text and is not written here — a whole-block rewrite and a
   * fresh table cell both go through this — so it is dropped and named, never
   * written as the character that stands for it (ticket 23).
   */
  function runRequests(
    all: readonly StyledRun[],
    at: number,
    segmentId?: string,
  ): DocsWriteRequest[] {
    const runs = all.filter((run) => run.image === undefined);
    for (const run of all) if (run.image !== undefined) dropped.push('image');
    const text = runs
      .map((run) => run.text)
      .join('')
      .replaceAll('\n', VERTICAL_TAB);
    if (text === '') return [];
    const out: DocsWriteRequest[] = [{ insertText: { location: location(at, segmentId), text } }];
    let offset = 0;
    for (const run of runs) {
      const from = at + offset;
      offset += run.text.length;
      if (run.text === '') continue;
      out.push({
        updateTextStyle: {
          range: range(from, at + offset, segmentId),
          textStyle: textStyle(run.style),
          fields: TEXT_FIELDS,
        },
      });
    }
    return out;
  }

  /**
   * A block that became a block of another kind: a style request, not a
   * rewrite, so the text keeps the comments and the formatting on it.
   */
  function restyle(ranged: Ranged, next: DiffBlock): void {
    const requests: DocsWriteRequest[] = [];
    const whole = range(ranged.start, ranged.end, ranged.segmentId);
    const heading = /^heading:([1-6])$/.exec(next.type);
    const named =
      heading === null ? 'NORMAL_TEXT' : (HEADINGS[Number(heading[1]) - 1] ?? 'HEADING_1');
    requests.push({
      updateParagraphStyle: {
        range: whole,
        paragraphStyle: { namedStyleType: named },
        fields: 'namedStyleType',
      },
    });

    const item = /^listItem:(bullet|ordered|todo)$/.exec(next.type);
    if (item !== null) {
      const kind = item[1] === 'todo' ? 'checklist' : (item[1] as 'bullet' | 'ordered');
      requests.push({
        createParagraphBullets: { range: whole, bulletPreset: BULLET_PRESETS[kind] },
      });
    } else if (/^listItem:/.test(ranged.block.type)) {
      requests.push({ deleteParagraphBullets: { range: whole } });
    }
    emit(ranged.start, STYLE, requests);
  }

  /* ------------------------------------------------------------ the walk */

  /**
   * A block deleted and a block inserted in its place, where Docs can say the
   * difference as a style: a paragraph made a heading, a list item made a
   * paragraph. The diff cannot pair two blocks of different types — nothing
   * about the dialect says they are the same block — but Docs can change one
   * into the other without touching the text, and the text is what carries the
   * comments and the formatting (MANUAL §7).
   *
   * Only a lone deletion followed by a lone insertion, and only when both are
   * one paragraph: two of either do not say which is which, and a delete and
   * an insert is the honest answer. Being the only pair in the hunk is the
   * signal, the same one ticket 15 settled on for a rewritten paragraph.
   */
  function restyled(ops: readonly BlockOp[], blocks: readonly Ranged[], context: Level): BlockOp[] {
    if (context.table !== undefined) return [...ops];
    const out = [...ops];
    for (let at = 0; at < out.length - 1; at += 1) {
      const one = out[at];
      const other = out[at + 1];
      if (one?.op !== 'delete' || other?.op !== 'insert') continue;
      if (out[at - 1]?.op === 'delete' || out[at + 2]?.op === 'insert') continue;
      const { base } = one;
      const { next } = other;
      if (base.type === next.type) continue;
      if (!PARAGRAPH_LIKE.test(base.type) || !PARAGRAPH_LIKE.test(next.type)) continue;
      // A bullet is created from the leading tabs of a paragraph, which only a
      // top-level insertion writes; a nested item is written afresh.
      if (context.depth > 0 && next.type.startsWith('listItem:')) continue;
      if (blocks[base.index] === undefined) continue;
      out.splice(at, 2, { op: 'update', base, next, children: [] });
    }
    return out;
  }

  function level(ops: readonly BlockOp[], blocks: readonly Ranged[], context: Level): void {
    const paired = restyled(ops, blocks, context);
    let pending: DiffBlock[] = [];
    let anchor: number | undefined;

    const flush = (): void => {
      if (pending.length === 0) return;
      const at = anchor ?? context.end;
      // New blocks anchored where a table starts cannot go in at that index.
      const beforeTable = blocks.some(
        (block) => block.block.type === 'table' && block.start === at,
      );
      insert(pending, at, context, beforeTable);
      pending = [];
      anchor = undefined;
    };

    for (const [at, op] of paired.entries()) {
      if (op.op === 'insert' || op.op === 'move') {
        if (op.op === 'move') refuseIfPlaceholder(op.base, 'moved');
        if (context.table !== undefined) {
          // A row is its own request, and its cells are filled inside it.
          if (op.op === 'move') {
            remove(blocks[op.base.index] as Ranged, context);
            counts.deleted += 1;
          }
          insertRow(op.next, blocks, context);
          counts.inserted += 1;
          continue;
        }
        if (op.op === 'move') {
          const found = blocks[op.base.index];
          if (found !== undefined) remove(found, context);
          counts.deleted += 1;
        }
        if (pending.length === 0) anchor = anchorFor(paired, at, blocks, context);
        pending.push(op.next);
        counts.inserted += 1;
        continue;
      }
      flush();

      const found = blocks[op.base.index];
      if (found === undefined) continue;
      if (op.op === 'delete') {
        remove(found, context);
        counts.deleted += 1;
        continue;
      }
      if (op.op === 'keep') counts.kept += 1;
      else counts.updated += 1;

      // A table whose shape changed is not a table that can be patched.
      if (op.op === 'update' && op.base.type === 'table' && op.base.markdown !== op.next.markdown) {
        rewritten.push('table');
        emit(found.start, DELETE, [
          {
            deleteContentRange: {
              range: range(found.start, found.end, found.segmentId),
            },
          },
        ]);
        insert([op.next], found.start, context);
        continue;
      }
      // A footnote is a document of its own, in a segment of its own: the same
      // diff runs over its blocks, and the same requests address them there.
      if (op.base.type === 'footnoteDefinition') {
        if (op.op === 'update') footnote(found, op.base, op.next);
        continue;
      }
      if (op.op === 'update') edit(found, op.base, op.next);

      const inner = inside(found, op.base, context);
      if (inner !== undefined) level(op.children, inner.blocks, inner.level);
    }
    flush();
  }

  /** One block taken out: a row of a table, or a stretch of the text. */
  function remove(found: Ranged, context: Level): void {
    if (context.table !== undefined) {
      emit(found.start, DELETE, [
        {
          deleteTableRow: {
            tableCellLocation: {
              tableStartLocation: location(context.table.start, context.segmentId),
              rowIndex: found.block.index,
              columnIndex: 0,
            },
          },
        },
      ]);
      return;
    }
    emit(found.start, DELETE, [
      { deleteContentRange: { range: range(found.start, extent(found), found.segmentId) } },
    ]);
  }

  /**
   * One past the last index a block covers, its nested blocks included.
   *
   * A block's own range is the paragraph it *is*: for a list item, the line
   * with the bullet on it and nothing under it. The diff, though, says nothing
   * about the children of a block it deletes — they go with their parent, and
   * a child that survives elsewhere arrives there as an insertion (MANUAL §7).
   * Deleting only the parent's own range left the nested items behind, still
   * bulleted and still indented, hanging under whatever came before (ticket
   * 32). A footnote's body lives in a segment of its own, so it is no part of
   * the stretch of the body a deletion cuts.
   */
  function extent(found: Ranged): number {
    let end = found.end;
    for (const child of found.children) {
      if (child.segmentId !== found.segmentId) continue;
      end = Math.max(end, extent(child));
    }
    return end;
  }

  /** Where the blocks the ops at `at` insert have to go. */
  function anchorFor(
    ops: readonly BlockOp[],
    at: number,
    blocks: readonly Ranged[],
    context: Level,
  ): number {
    for (let index = at; index < ops.length; index += 1) {
      const found = liveOf(ops[index], blocks);
      if (found !== undefined) return found.start;
    }
    for (let index = at - 1; index >= 0; index -= 1) {
      const found = liveOf(ops[index], blocks);
      // Past everything the block before covers, its nested blocks included:
      // at the end of a level the new blocks go after the whole subtree, and a
      // block being deleted is deleted over that same stretch, so an anchor
      // inside it would put the new text where the deletion is about to run.
      if (found !== undefined) return extent(found);
    }
    return context.end;
  }

  function liveOf(op: BlockOp | undefined, blocks: readonly Ranged[]): Ranged | undefined {
    if (op === undefined || op.op === 'insert') return undefined;
    return blocks[op.base.index];
  }

  /** One footnote's body, patched inside the segment it lives in. */
  function footnote(found: Ranged, base: DiffBlock, next: DiffBlock): void {
    const one = base.source[0];
    const other = next.source[0];
    if (one?.type !== 'footnoteDefinition' || other?.type !== 'footnoteDefinition') return;
    const node = found.block.source[0];
    if (node?.type !== 'footnoteDefinition') return;
    level(
      diffBlocks(
        { type: 'root', children: one.children },
        { type: 'root', children: other.children },
      ),
      blockRanges(node.children),
      { depth: 1, end: found.end, segmentId: found.segmentId },
    );
  }

  /** The level inside a block: a table's rows, or a footnote's own body. */
  function inside(
    found: Ranged,
    base: DiffBlock,
    context: Level,
  ): { blocks: Ranged[]; level: Level } | undefined {
    if (found.children.length === 0) return undefined;
    if (base.type === 'table') {
      return {
        blocks: found.children,
        level: {
          ...context,
          depth: context.depth + 1,
          table: { start: found.start, columns: found.children[0]?.cells?.length ?? 0 },
        },
      };
    }
    return {
      blocks: found.children,
      level: {
        ...context,
        depth: context.depth + 1,
        table: undefined,
        ...(base.type.startsWith('listItem:') ? { list: (context.list ?? 0) + 1 } : {}),
      },
    };
  }

  /* -------------------------------------------------------------- rows */

  /** A new row of a table: the row itself, then its cells, right to left. */
  function insertRow(next: DiffBlock, blocks: readonly Ranged[], context: Level): void {
    const table = context.table;
    if (table === undefined) return;
    const before = blocks[next.index - 1];
    const below = before !== undefined;
    const rowIndex = below ? next.index - 1 : 0;
    const start = below ? before.end : (blocks[0]?.start ?? table.start + 1);

    const requests: DocsWriteRequest[] = [
      {
        insertTableRow: {
          tableCellLocation: {
            tableStartLocation: location(table.start, context.segmentId),
            rowIndex,
            columnIndex: 0,
          },
          insertBelow: below,
        },
      },
    ];
    // Every cell of a fresh row holds one empty paragraph: one code unit for
    // the cell, one for the paragraph. Filled from the last column back, so
    // that filling one never moves one still to be filled.
    const cells = next.cells ?? [];
    for (let column = table.columns - 1; column >= 0; column -= 1) {
      const at = start + 2 + 2 * column;
      requests.push(...runRequests(inlineRuns(cells[column] ?? []), at, context.segmentId));
    }
    emit(start, INSERT, requests);
  }

  /* --------------------------------------------------------- the answer */

  level(ops, live.blocks, { depth: 0, end: live.end });

  // Two insertions at one index are sent later-in-the-document first, as the
  // blocks inside one insertion are: what goes in first ends up after what
  // goes in next. Everything else keeps the order it was planned in.
  groups.sort(
    (a, b) =>
      b.index - a.index ||
      a.phase - b.phase ||
      (a.phase === INSERT ? b.order - a.order : a.order - b.order),
  );

  const requests: DocsWriteRequest[] = [];
  const footnotes: PlannedFootnote[] = [];
  for (const group of groups) {
    for (const footnote of group.footnotes) {
      footnotes.push({
        requestIndex: requests.length + footnote.offset,
        requests: footnote.requests,
      });
    }
    requests.push(...group.requests);
  }

  return {
    requests,
    footnotes,
    counts,
    dropped,
    suggestions,
    rewritten,
  };
}

/* ------------------------------------------------------------- the pieces */

/** A range, in the segment it belongs to. */
function range(startIndex: number, endIndex: number, segmentId?: string): DocsWriteRequest {
  return { startIndex, endIndex, ...(segmentId === undefined ? {} : { segmentId }) };
}

/** A location, in the segment it belongs to. */
function location(index: number, segmentId?: string): DocsWriteRequest {
  return { index, ...(segmentId === undefined ? {} : { segmentId }) };
}

/** The same request, addressed to one segment. */
function stamp(value: unknown, segmentId: string): unknown {
  if (Array.isArray(value)) return value.map((one) => stamp(one, segmentId));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(record)) out[key] = stamp(one, segmentId);
  if ('index' in record || 'startIndex' in record) out.segmentId = segmentId;
  return out;
}

/** The document index a character of a block's text is at. */
function indexAt(pieces: readonly Piece[], offset: number, end = false): number {
  let last = pieces[0]?.start ?? 0;
  for (const piece of pieces) {
    const length = piece.text ?? 0;
    const inside = end
      ? offset > piece.at && offset <= piece.at + length
      : offset < piece.at + length;
    if (inside) {
      if (piece.atomic === true) return offset <= piece.at ? piece.start : piece.end;
      return piece.start + Math.max(0, offset - piece.at);
    }
    last = piece.end;
  }
  return last;
}

/** The offset in the base text of an offset in the new one, over kept spans. */
function baseOffset(spans: readonly Span[], next: number): number {
  for (const span of spans) {
    if (span.kind !== 'keep') continue;
    if (next >= span.next && next < span.next + span.text.length) {
      return span.base + (next - span.next);
    }
  }
  return next;
}

/** The style of the character at an offset. */
function styleAt(runs: readonly StyledRun[], offset: number): InlineStyle {
  let at = 0;
  for (const run of runs) {
    if (offset < at + run.text.length) return run.style;
    at += run.text.length;
  }
  return runs.at(-1)?.style ?? DEFAULT_STYLE;
}

/** The runs of a stretch of text, cut at its ends. */
function slice(runs: readonly StyledRun[], from: number, to: number): StyledRun[] {
  const out: StyledRun[] = [];
  let at = 0;
  for (const run of runs) {
    const start = Math.max(from, at);
    const end = Math.min(to, at + run.text.length);
    if (end > start) {
      out.push({
        text: run.text.slice(start - at, end - at),
        style: run.style,
        // An image is one character, so a slice that keeps any of it keeps it.
        ...(run.image === undefined ? {} : { image: run.image }),
      });
    }
    at += run.text.length;
  }
  return out;
}

/** Whether two styles agree on everything Docs can be told about. */
function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.underline === b.underline &&
    a.code === b.code &&
    a.link === b.link
  );
}

/** One dialect attribute as the Docs field that carries it, if any. */
function fieldOf(key: string): string[] {
  if (key === 'code') return ['weightedFontFamily'];
  // A colour span is Notion's; Docs colours are not in the dialect (MANUAL §6).
  if (key === 'color') return [];
  return [key];
}

/** A style as Docs spells it, over the keys named. */
function textStyle(style: InlineStyle, keys?: readonly string[]): Record<string, unknown> {
  const wanted = new Set(keys ?? ['bold', 'italic', 'underline', 'strikethrough', 'code', 'link']);
  const out: Record<string, unknown> = {};
  if (wanted.has('bold')) out.bold = style.bold;
  if (wanted.has('italic')) out.italic = style.italic;
  if (wanted.has('underline')) out.underline = style.underline;
  if (wanted.has('strikethrough')) out.strikethrough = style.strikethrough;
  // A field named with no value is the field set back to its default: no link,
  // and the document's own font rather than the code one.
  if (wanted.has('code') && style.code) {
    out.weightedFontFamily = { fontFamily: CODE_FONT, weight: 400 };
  }
  if (wanted.has('link') && style.link !== null) out.link = { url: style.link };
  return out;
}
