/**
 * Where each block of the base version lives in the live document (ticket 16).
 *
 * A Google Doc has no block ids. What it has is indices — UTF-16 code units,
 * counted from the start of a segment — and every `batchUpdate` request names
 * them. So a patch needs a map: this block of the Markdown is that stretch of
 * that document, and this character of the block is that index.
 *
 * The map is not guessed. `to-markdown.ts` converts the live document with
 * **provenance**, so every node it builds carries the range it came from, and
 * `flattenBlocks` (`src/diff/blocks.ts`) then groups those same nodes into the
 * blocks the diff speaks about. Walking the result gives, for every block, the
 * elements it came from and the offsets inside them — including the two blocks
 * one paragraph split by a page break becomes, which is the case a map built
 * from the document alone gets wrong.
 *
 * Two kinds of piece exist inside a block. **Text** can be cut anywhere: its
 * character *n* is at `index + n`. Something **atomic** — a footnote reference,
 * an image, a drawing — is one code unit in the document and a whole comment
 * or nothing in the Markdown, so an edit that reaches into it takes all of it
 * (MANUAL §7).
 */
import type { PhrasingContent, Root, RootContent } from 'mdast';
import { type DiffBlock, flattenBlocks } from '../diff/blocks.js';
import { stringifyMarkdown } from '../markdown.js';
import type { DocsDocument } from './api.js';
import { type ConvertOptions, convertDocument, type Origin, originOf } from './to-markdown.js';

/** One piece of a block's text, and where the document keeps it. */
export interface Piece extends Origin {
  /** Where the piece starts in the block's own plain text. */
  at: number;
}

/** One block of the base version, mapped onto the live document. */
export interface Ranged {
  block: DiffBlock;
  /** The footnote segment the indices are in. Absent for the body. */
  segmentId?: string;
  /** The first index the block covers. */
  start: number;
  /** One past the last. The paragraph's newline is inside it. */
  end: number;
  /** The block's own text, piece by piece, in order. */
  pieces: Piece[];
  /** A table row's cells, each with its own text. */
  cells?: RangedCell[];
  /** Pending suggestions on the block (MANUAL §7). */
  suggestions: string[];
  children: Ranged[];
}

export interface RangedCell {
  start: number;
  end: number;
  pieces: Piece[];
}

/** The live document, as a push reads it. */
export interface LiveDocument {
  /** The body the dialect writes, which is what the base has to equal. */
  markdown: string;
  tree: Root;
  /** The base blocks, in the order `flattenBlocks` puts them in. */
  blocks: Ranged[];
  /** Every pending suggestion in the document. */
  suggestions: string[];
  /** One past the last index of the body: where an append has to go. */
  end: number;
}

/** The live document read as the version a push diffs against (MANUAL §7). */
export function readLive(doc: DocsDocument, options: ConvertOptions = {}): LiveDocument {
  const { tree, suggestions } = convertDocument(doc, { ...options, provenance: true });
  return {
    markdown: stringifyMarkdown(tree),
    tree,
    blocks: blockRanges(tree.children),
    suggestions,
    end: doc.body?.content?.at(-1)?.endIndex ?? 2,
  };
}

/** The blocks of a run of nodes, mapped: a body, or one footnote's body. */
export function blockRanges(nodes: readonly RootContent[]): Ranged[] {
  return flattenBlocks({ type: 'root', children: nodes.map(hoist) }).map(ranged);
}

/**
 * A paragraph that holds nothing but a placeholder comment, written as the
 * comment itself.
 *
 * The two say the same thing and print the same line, but a *parsed* document
 * has the comment at the top level, so the base blocks call it a placeholder
 * and these would call it a paragraph. Since the whole point of this module is
 * that base block *n* is live block *n*, they have to be flattened alike.
 */
function hoist(node: RootContent): RootContent {
  if (node.type !== 'paragraph' || node.children.length !== 1) return node;
  const only = node.children[0];
  if (only?.type !== 'html') return node;
  const own = originOf(node);
  const inner = originOf(only);
  if (own === undefined || inner === undefined) return only;
  // The block is the paragraph, so it is the paragraph's range that a deletion
  // of it has to cover.
  return { ...only, data: { ...only.data, gdocs: { ...inner, start: own.start, end: own.end } } };
}

/** One block, with the document indices its nodes came from. */
function ranged(block: DiffBlock): Ranged {
  const own = origin(block);
  const pieces = piecesOf(block.inline ?? []);
  const cells = block.cells === undefined ? undefined : cellsOf(block);
  const start = own?.start ?? pieces[0]?.start ?? cells?.[0]?.start ?? 0;
  const end = own?.end ?? pieces.at(-1)?.end ?? cells?.at(-1)?.end ?? start;
  return {
    block,
    ...(own?.segmentId === undefined ? {} : { segmentId: own.segmentId }),
    start,
    end,
    pieces,
    ...(cells === undefined ? {} : { cells }),
    suggestions: own?.suggestions ?? [],
    children: block.children.map(ranged),
  };
}

/**
 * The origin of the node the block *is*. A block's source is the node itself,
 * behind the attribute comment that belongs to it and, for a list item or a
 * table row, inside the one-item list or the row the flattening wrapped it in.
 * The scan runs backwards, because what stands in front is the comment — and
 * the page-break comment has an origin of its own, one code unit wide.
 */
function origin(block: DiffBlock): Origin | undefined {
  for (const node of [...block.source].reverse()) {
    const found = originIn(node);
    if (found !== undefined) return found;
  }
  return undefined;
}

function originIn(node: RootContent): Origin | undefined {
  const own = originOf(node);
  if (own !== undefined) return own;
  // A list item arrives wrapped in a list of one, a cell inside its row.
  if (node.type === 'list' || node.type === 'blockquote' || node.type === 'listItem') {
    for (const child of node.children) {
      const found = originIn(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** A table row's cells, each mapped onto the cell the document holds. */
function cellsOf(block: DiffBlock): RangedCell[] {
  const row = block.source.find((node) => node.type === 'tableRow');
  const cells = row?.type === 'tableRow' ? row.children : [];
  return (block.cells ?? []).map((content, column) => {
    const own = originOf(cells[column]);
    const pieces = piecesOf(content);
    return {
      start: own?.start ?? pieces[0]?.start ?? 0,
      end: own?.end ?? pieces.at(-1)?.end ?? 0,
      pieces,
    };
  });
}

/**
 * The pieces of one run of inline content, walked the way `inlineRuns` walks
 * it, so that a piece's `at` is an offset in exactly the text `diffText`
 * answers spans over (`src/diff/text.ts`).
 */
export function piecesOf(nodes: readonly PhrasingContent[]): Piece[] {
  const out: Piece[] = [];
  let at = 0;

  const walk = (children: readonly PhrasingContent[]): void => {
    for (const node of children) {
      if ('children' in node) {
        // strong, emphasis, delete, link: styling, not content of their own.
        walk(node.children as PhrasingContent[]);
        continue;
      }
      const found = originOf(node);
      if (found === undefined) continue;
      const length = found.text ?? 0;
      out.push({ ...found, at });
      at += length;
    }
  };

  walk(nodes);
  return out;
}

/**
 * The document index a character of a block's text is at.
 *
 * `offset` is an offset in the block's plain text; the answer is where that
 * character starts in the document, and `end` says whether an offset that
 * lands exactly on a piece boundary belongs to the piece before it (the end of
 * a range) or the one after it (its start).
 */
export function indexAt(pieces: readonly Piece[], offset: number, end = false): number {
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

/** Whether a stretch of a block's text touches something that cannot be cut. */
export function touchesAtomic(pieces: readonly Piece[], from: number, to: number): boolean {
  return pieces.some(
    (piece) =>
      piece.atomic === true && piece.at < to && piece.at + (piece.text ?? 0) > from && to > from,
  );
}
