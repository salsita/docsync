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
 */
import type { Heading, Node, Nodes, Parent } from 'mdast';
import { parseMarkdown } from '../markdown.js';

/** Where a quoted piece of text was found. */
export interface Anchor {
  /** The block that holds it — paragraph, heading, list item or table cell — as written. */
  quote: string;
  /** Where the block starts in the body, which is what threads are sorted by. */
  offset: number;
  /** The nearest heading above the block. Absent when there is none. */
  heading?: string;
  /** The quoted text's range inside `quote`, when it could be placed exactly. */
  mark?: [number, number];
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

/**
 * The first block of `body` whose text holds `quoted`, or `undefined` when no
 * block does. "First" is document order, which is what makes the sidecar's
 * order stable across fetches (MANUAL §6).
 */
export function locate(body: string, quoted: string): Anchor | undefined {
  const needle = collapse(quoted).text.trim();
  if (needle === '') return undefined;
  const heading = headingsOf(body);

  for (const node of anchors(body)) {
    const [start, end] = spanOf(node);
    if (start === undefined || end === undefined) continue;

    const pieces = piecesOf(node);
    const plain = collapse(pieces.map((piece) => piece.text).join(''));
    const found = plain.text.indexOf(needle);
    if (found < 0) continue;

    const quote = body.slice(start, end);
    const anchor: Anchor = { quote, offset: start, ...headingOf(heading(start)) };
    const mark = rangeOf(pieces, plain.at[found], plain.at[found + needle.length - 1]);
    return mark === undefined
      ? anchor
      : { ...anchor, mark: [mark[0] - start, mark[1] - start] as [number, number] };
  }
  return undefined;
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
