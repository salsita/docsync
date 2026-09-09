/**
 * Where a piece of quoted text sits in a fetched document (MANUAL §6).
 *
 * A comment at either source names the text it is attached to and nothing else:
 * Drive answers `quotedFileContent`, Notion answers the block. Neither says
 * where that is on disk, and the reader wants context — the whole paragraph,
 * and the heading it is under. So this module searches the Markdown body a
 * fetch just produced and answers the block that holds the text, quoted as it
 * is written, with the range to mark.
 *
 * It is pure and knows nothing about either source: text in, position out.
 *
 * Matching is on the block's **plain text**, not on its Markdown, because a
 * source quotes what the reader sees: `\*` in the file is `*` in the quote, and
 * a run split by bold is one sentence in the quote. Whitespace is collapsed on
 * both sides, so a selection that ran over a line break still matches. The
 * offsets answered are into the Markdown, mapped back through the nodes the
 * plain text came from.
 *
 * A selection can also run **over a block boundary** — the end of one paragraph
 * and the start of the next — and then no single block holds the quote. So a
 * second pass matches a run of consecutive blocks, their plain text joined by a
 * space, and answers those blocks joined by a blank line as the quote, with the
 * mark running from inside the first block to inside the last (ticket 34).
 * Single blocks are tried first, so a quote that fits in one is anchored to it,
 * and the pass is off for Notion, whose comments belong to one block by
 * construction.
 */
import type { Heading, Node, Nodes, Parent } from 'mdast';
import { parseMarkdown } from '../markdown.js';

/** Where a quoted piece of text was found. */
export interface Anchor {
  /**
   * The block that holds it — paragraph, heading, list item or table cell — as
   * written. A quote that ran over a block boundary is every block it touched,
   * joined by a blank line.
   */
  quote: string;
  /** Where the first block starts in the body, which is what threads are sorted by. */
  offset: number;
  /** The nearest heading above the first block. Absent when there is none. */
  heading?: string;
  /** The quoted text's range inside `quote`, when it could be placed exactly. */
  mark?: [number, number];
  /** How many consecutive blocks the quote spans. One for all but a run. */
  blocks: number;
}

/** How `locate` may match: over one block, or over a run of them. */
export interface LocateOptions {
  /**
   * Whether a quote may span consecutive blocks. On by default; Notion turns it
   * off, since a Notion comment belongs to exactly one block (MANUAL §6).
   */
  spans?: boolean;
}

/** The part of an anchor a sidecar thread carries. `blocks` is not one. */
export function placeOf(anchor: Anchor): {
  quote: string;
  offset: number;
  heading?: string;
  mark?: [number, number];
} {
  return {
    quote: anchor.quote,
    offset: anchor.offset,
    ...(anchor.heading === undefined ? {} : { heading: anchor.heading }),
    ...(anchor.mark === undefined ? {} : { mark: anchor.mark }),
  };
}

/** The block types a comment can be anchored to (MANUAL §6). */
const BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading', 'tableCell', 'code']);

/** Leaf nodes whose `value` is text the reader sees, and their raw span. */
const LEAVES: ReadonlySet<string> = new Set(['text', 'inlineCode', 'inlineMath', 'math', 'code']);

/** One leaf's text, and where it is in the body. */
interface Piece {
  text: string;
  start: number;
  end: number;
}

function isParent(node: Node): node is Parent {
  return Array.isArray((node as Parent).children);
}

/** Every text leaf under a node, in document order. */
function piecesOf(node: Nodes, out: Piece[] = []): Piece[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (LEAVES.has(node.type) && start !== undefined && end !== undefined) {
    out.push({ text: String((node as { value?: unknown }).value ?? ''), start, end });
    return out;
  }
  if (isParent(node)) for (const child of node.children) piecesOf(child as Nodes, out);
  return out;
}

/** The text of a node as the reader sees it, with no Markdown punctuation. */
export function plainOf(node: Nodes): string {
  return piecesOf(node)
    .map((piece) => piece.text)
    .join('');
}

/**
 * A string with its whitespace collapsed, and the index in the original each
 * kept character came from. Matching on this is what lets a quote that ran over
 * a line break find the paragraph it came from.
 */
function collapse(text: string): { text: string; at: number[] } {
  const out: string[] = [];
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (!/\s/.test(character)) {
      out.push(character);
      at.push(index);
      continue;
    }
    if (out.at(-1) === ' ') continue;
    out.push(' ');
    at.push(index);
  }
  return { text: out.join(''), at };
}

/**
 * A lookup from an offset in the body to the nearest heading above it, as
 * plain text. Exported because the Notion side anchors on whole blocks and has
 * no text to search for.
 */
export function headingsOf(body: string): (offset: number) => string | undefined {
  const headings: { offset: number; text: string }[] = [];
  for (const node of parseMarkdown(body).children) {
    if (node.type !== 'heading') continue;
    const offset = node.position?.start.offset;
    if (offset !== undefined) headings.push({ offset, text: plainOf(node as Heading) });
  }
  return (offset) => {
    let found: string | undefined;
    for (const heading of headings) {
      if (heading.offset >= offset) break;
      found = heading.text;
    }
    return found;
  };
}

/**
 * The anchor blocks of a body, in document order: every paragraph, heading,
 * table cell and code block, each replaced by the innermost list item that
 * holds it, so that a comment on a list item quotes the whole item.
 */
function anchors(body: string): Nodes[] {
  const found: Nodes[] = [];
  const seen = new Set<Nodes>();

  const visit = (node: Nodes, item: Nodes | undefined): void => {
    const inside = node.type === 'listItem' ? node : item;
    if (BLOCKS.has(node.type)) {
      const anchor = inside ?? node;
      if (!seen.has(anchor)) {
        seen.add(anchor);
        found.push(anchor);
      }
      // A block's own children are inline; nothing below it is an anchor.
      return;
    }
    if (isParent(node)) for (const child of node.children) visit(child as Nodes, inside);
  };

  for (const node of parseMarkdown(body).children) visit(node as Nodes, undefined);
  return found;
}

/** One anchor block: where it is in the body, and the text leaves under it. */
interface Block {
  start: number;
  end: number;
  pieces: Piece[];
}

/** The anchor blocks of a body that have a span, in document order. */
function blocksOf(body: string): Block[] {
  const out: Block[] = [];
  for (const node of anchors(body)) {
    const [start, end] = spanOf(node);
    if (start === undefined || end === undefined) continue;
    out.push({ start, end, pieces: piecesOf(node) });
  }
  return out;
}

/**
 * A run of consecutive blocks as one quote: the Markdown of each, joined by a
 * blank line, with every text leaf moved into that string's coordinates and a
 * one-space separator standing between two blocks. Matching then works on a run
 * exactly as it works on a single block, and the offsets it answers are already
 * relative to the quote.
 */
function runOf(
  body: string,
  blocks: readonly Block[],
): { quote: string; pieces: Piece[]; firstLength: number } {
  const parts: string[] = [];
  const pieces: Piece[] = [];
  let base = 0;
  let firstLength = 0;
  for (const block of blocks) {
    // A separator is two characters of Markdown and one of text, so `rangeOf`
    // takes it whole rather than cutting a blank line in half.
    if (base > 0) pieces.push({ text: ' ', start: base - 2, end: base });
    for (const piece of block.pieces) {
      pieces.push({
        text: piece.text,
        start: piece.start - block.start + base,
        end: piece.end - block.start + base,
      });
    }
    const quote = body.slice(block.start, block.end);
    parts.push(quote);
    base += quote.length + 2;
    if (parts.length === 1) {
      // The first block's own text, plus the separator's one space: everything
      // before this is text a match has to reach into for the run to be minimal.
      firstLength = pieces.reduce((total, piece) => total + piece.text.length, 0) + 1;
    }
  }
  return { quote: parts.join('\n\n'), pieces, firstLength };
}

/** What one run of blocks says about a needle. */
interface Match {
  /** The anchor, when the run holds the needle and needs its first block for it. */
  anchor?: Anchor;
  /** The run's collapsed text length, which is what bounds how far a run grows. */
  length: number;
  /** The collapsed index at which the second block's text starts. */
  boundary: number;
}

/** The anchor a run of blocks makes for `needle`, and what growing it further costs. */
function match(
  body: string,
  blocks: readonly Block[],
  needle: string,
  heading: (offset: number) => string | undefined,
): Match {
  const first = blocks[0];
  const { quote, pieces, firstLength } = runOf(body, blocks);
  const plain = collapse(pieces.map((piece) => piece.text).join(''));
  const boundary = blocks.length === 1 ? plain.text.length : collapsedIndex(plain.at, firstLength);
  const bounds = { length: plain.text.length, boundary };

  const found = plain.text.indexOf(needle);
  // A match that does not reach into the first block belongs to a shorter run
  // starting later, which document order reaches on its own.
  if (first === undefined || found < 0 || found >= boundary) return bounds;

  const anchor: Anchor = {
    quote,
    offset: first.start,
    blocks: blocks.length,
    ...headingOf(heading(first.start)),
  };
  const mark = rangeOf(pieces, plain.at[found], plain.at[found + needle.length - 1]);
  return { ...bounds, anchor: mark === undefined ? anchor : { ...anchor, mark } };
}

/** Where an index into the uncollapsed text falls in the collapsed one. */
function collapsedIndex(map: readonly number[], at: number): number {
  const found = map.findIndex((index) => index >= at);
  return found < 0 ? map.length : found;
}

/**
 * The first block of `body` whose text holds `quoted`, or the first run of
 * consecutive blocks that does, or `undefined` when nothing does. "First" is
 * document order, which is what makes the sidecar's order stable across
 * fetches (MANUAL §6).
 */
export function locate(
  body: string,
  quoted: string,
  options: LocateOptions = {},
): Anchor | undefined {
  const needle = collapse(quoted).text.trim();
  if (needle === '') return undefined;
  const { blocks, heading, joined } = parsed(body);

  for (const block of blocks) {
    const { anchor } = match(body, [block], needle, heading);
    if (anchor !== undefined) return anchor;
  }
  if (options.spans === false) return undefined;

  // Nothing holds the whole quote, so the selection ran over a block boundary.
  // The needle is looked for once in the text of every block joined by a
  // space, and the run is exactly the blocks the match covers (ticket 34):
  // one pass over the body, however long it is and however many threads ask.
  const found = joined.text.indexOf(needle);
  if (found < 0) return undefined;
  const first = joined.blockAt(found);
  const last = joined.blockAt(found + needle.length - 1);
  if (first === undefined || last === undefined) return undefined;
  return match(body, blocks.slice(first, last + 1), needle, heading).anchor;
}

/** A body's blocks, headings and joined text, parsed once per body. */
interface Parsed {
  blocks: Block[];
  heading: (offset: number) => string | undefined;
  joined: {
    /** The plain text of every block, joined by one space, whitespace collapsed. */
    text: string;
    /** The block a collapsed index falls in. */
    blockAt: (index: number) => number | undefined;
  };
}

/**
 * The sidecar asks about one body once per thread, and a long document has
 * many; parsing it once per body rather than once per thread is what keeps a
 * fetch linear in the document.
 */
let lastParsed: { body: string; parsed: Parsed } | undefined;

function parsed(body: string): Parsed {
  if (lastParsed?.body === body) return lastParsed.parsed;
  const blocks = blocksOf(body);
  const heading = headingsOf(body);

  // Every block's text, one after another with a space between, and where
  // each one starts and ends in that string before whitespace is collapsed.
  const parts: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (const block of blocks) {
    const text = block.pieces.map((piece) => piece.text).join('');
    starts.push(at);
    parts.push(text);
    at += text.length + 1;
  }
  const whole = collapse(parts.join(' '));
  const blockAt = (index: number): number | undefined => {
    const raw = whole.at[index];
    if (raw === undefined) return undefined;
    let found: number | undefined;
    for (const [block, start] of starts.entries()) {
      if (start > raw) break;
      found = block;
    }
    return found;
  };

  const result: Parsed = { blocks, heading, joined: { text: whole.text, blockAt } };
  lastParsed = { body, parsed: result };
  return result;
}

/**
 * The span of a block in the body. A table cell's own position takes in the
 * `|` that separates it from its neighbour and the padding around it, so a cell
 * is measured by its content instead.
 */
function spanOf(node: Nodes): [number | undefined, number | undefined] {
  if (node.type === 'tableCell' && node.children.length > 0) {
    const start = node.children[0]?.position?.start.offset;
    const end = node.children.at(-1)?.position?.end.offset;
    if (start !== undefined && end !== undefined) return [start, end];
  }
  return [node.position?.start.offset, node.position?.end.offset];
}

function headingOf(text: string | undefined): { heading?: string } {
  return text === undefined || text === '' ? {} : { heading: text };
}

/**
 * The span in the body that a range of the block's plain text came from. The
 * ends are the ends of the leaves the match started and stopped in, so a match
 * that runs through a bold word takes the `**` with it rather than cutting it.
 */
function rangeOf(
  pieces: readonly Piece[],
  from: number | undefined,
  to: number | undefined,
): [number, number] | undefined {
  if (from === undefined || to === undefined) return undefined;
  let at = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const piece of pieces) {
    const next = at + piece.text.length;
    // A run whose Markdown is longer than its text — inline code, an equation —
    // is taken whole, punctuation and all, rather than cut at a wrong offset.
    const plain = piece.end - piece.start === piece.text.length;
    if (start === undefined && from < next) start = plain ? piece.start + (from - at) : piece.start;
    if (end === undefined && to < next) end = plain ? piece.start + (to - at) + 1 : piece.end;
    at = next;
  }
  return start === undefined || end === undefined || end <= start ? undefined : [start, end];
}
