/**
 * Where each block of the base version lives in the live document (#16).
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
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import type { DocsDocument } from './api.js';
import {
  type ConvertOptions,
  convertDocument,
  type Insertion,
  type Origin,
  originOf,
} from './to-markdown.js';

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
  /** The stretches of it that are somebody's pending suggested insertion. */
  insertions: Insertion[];
  children: Slot[];
}

/**
 * One position of the base block list, and the live block it maps to.
 *
 * `undefined` where the base has a block the live document does not — which
 * only happens on a document whose Markdown does not flatten the same way
 * twice, and where the honest answer is to write nothing rather than to write
 * somewhere else.
 */
export type Slot = Ranged | undefined;

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
  blocks: Slot[];
  /** Every pending suggestion in the document. */
  suggestions: string[];
  /** One past the last index of the body: where an append has to go. */
  end: number;
}

/** The live document read as the version a push diffs against (MANUAL §7). */
export function readLive(doc: DocsDocument, options: ConvertOptions = {}): LiveDocument {
  const { tree, suggestions } = convertDocument(doc, { ...options, provenance: true });
  const markdown = stringifyMarkdown(tree);
  return {
    markdown,
    tree,
    // The diff's base blocks come out of the *Markdown*; these come out of the
    // tree that printed it. `alignBlocks` is what makes the two the same list
    // (MANUAL §7 "Write-back").
    blocks: alignBlocks(flattenBlocks(parseMarkdown(markdown)), blockRanges(tree.children)),
    suggestions,
    end: doc.body?.content?.at(-1)?.endIndex ?? 2,
  };
}

/**
 * The live blocks, put in the order of the base blocks: base block *n* is
 * `blocks[n]` (MANUAL §7).
 *
 * The guarantee looks free — the base *is* the Markdown this tree prints, so
 * the two lists ought to be the same list — and it is not. The diff flattens
 * the Markdown a parser read; the ranges flatten the tree the converter built.
 * A node whose Markdown reads back as something else moves the two apart: a
 * paragraph that begins with one of the dialect's placeholder comments prints
 * a line CommonMark takes for an HTML block and the flattening drops, so the
 * live list gains a block the base list has not, and from there on every block
 * is addressed one place early. That is the two-and-three-paragraph jump of
 * #41; `hoist` below is an earlier, narrower patch on the same wound.
 *
 * So the mapping is made rather than assumed: a longest common subsequence
 * over the two lists' identities, and a base block with nothing to match is
 * left empty, which writes nothing. Where the two lists agree — every document
 * that round-trips, which is every document a fetch ever wrote — the answer is
 * the live list unchanged.
 */
export function alignBlocks(base: readonly DiffBlock[], live: readonly Ranged[]): Slot[] {
  const anchors = common(
    base.map((block) => identity(block)),
    live.map((block) => identity(block.block)),
  );
  const out: Slot[] = Array.from({ length: base.length });

  // Between two blocks that *are* the same block, a run of the base and a run
  // of the live document that are the same length are the same blocks in order
  // — a block whose Markdown reads back a little differently is still that
  // block, and that is the ordinary case. A run of a different length says the
  // two documents disagree about how many blocks are there, and the blocks in
  // it are left empty: a push writes nothing rather than somewhere else.
  const walk = (fromBase: number, toBase: number, fromLive: number, toLive: number): void => {
    if (toBase - fromBase !== toLive - fromLive) return;
    for (let at = 0; at < toBase - fromBase; at += 1) out[fromBase + at] = live[fromLive + at];
  };

  let previousBase = -1;
  let previousLive = -1;
  for (const [at, found] of anchors) {
    walk(previousBase + 1, at, previousLive + 1, found);
    out[at] = live[found];
    previousBase = at;
    previousLive = found;
  }
  walk(previousBase + 1, base.length, previousLive + 1, live.length);

  return out.map((one, at) =>
    one === undefined
      ? undefined
      : { ...one, children: alignBlocks(base[at]?.children ?? [], own(one.children)) },
  );
}

/** What makes two blocks the same block: the diff's own identity (blocks.ts). */
function identity(block: DiffBlock): string {
  return `${block.type} ${block.markdown}`;
}

/** The blocks of a level that are there, for a second pass of the alignment. */
function own(slots: readonly Slot[]): Ranged[] {
  return slots.filter((slot): slot is Ranged => slot !== undefined);
}

/**
 * The longest common subsequence of two lists of identities, as a map from an
 * index in the first to the index in the second it pairs with.
 */
function common(a: readonly string[], b: readonly string[]): Map<number, number> {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.set(i, j);
      i += 1;
      j += 1;
      continue;
    }
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i += 1;
    else j += 1;
  }
  return out;
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
    insertions: own?.insertions ?? [],
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
