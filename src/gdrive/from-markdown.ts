/**
 * Canonical Markdown back into Google Docs `batchUpdate` requests (MANUAL §7).
 *
 * The exact inverse of `to-markdown.ts`, over the same mdast tree that
 * `src/markdown.ts` produces: this module never looks at Markdown text and
 * never talks to Google. It answers requests; `write.ts` sends them.
 *
 * The whole design is one decision (ticket 08): **every block is inserted at
 * index 1, in reverse document order**, each with its own styling requests
 * immediately after its `insertText`. A request therefore only ever addresses
 * indices inside the block it belongs to, all of which are known while the
 * block is being generated — nothing has to be re-based when an earlier block
 * turns out to be longer than expected, and inserting a table or a page break
 * never shifts anything already emitted. Indices are UTF-16 code units, which
 * is what `string.length` counts and what the Docs API means.
 *
 * Two things inside a block do shift it, and both are therefore emitted last:
 * a `createFootnote` inserts its reference character (so they go in descending
 * offset order), and `createParagraphBullets` strips the leading tabs that
 * expressed the nesting (so it goes after every range that was measured with
 * those tabs in place).
 *
 * What the API cannot create is dropped and named in `dropped`, for the push
 * report: a horizontal rule above all (MANUAL §7 lists it as a phase-1 loss).
 * A placeholder produces nothing, because phase-1 write-back is a full replace
 * and a block we could not read back is not one we try to recreate.
 */
import type {
  Blockquote,
  Code,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import { parseMarkdown } from '../markdown.js';

/** One `batchUpdate` request. The API's own JSON, not a wrapper. */
export type DocsRequest = Record<string, unknown>;

/**
 * The font a run in inline code is written in. The read side calls any
 * monospace family code (`CODE_FONTS` in `to-markdown.ts`); this is the one it
 * writes back, so a round trip does not drift between families.
 */
export const CODE_FONT = 'Courier New';

/** A soft line break inside a paragraph, which Docs stores as a vertical tab. */
const VERTICAL_TAB = '\u000B';

/** `createParagraphBullets` presets, one per list the dialect has (MANUAL §6). */
export const BULLET_PRESETS = {
  bullet: 'BULLET_DISC_CIRCLE_SQUARE',
  ordered: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
  checklist: 'BULLET_CHECKBOX',
} as const;

type ListKind = keyof typeof BULLET_PRESETS;

/**
 * The text-style fields one `updateTextStyle` per run always sets. The whole
 * mask every time, never a subset: text inserted at index 1 inherits the style
 * of whatever is already there, so a field left out of the mask would be a
 * field inherited from the block that happens to follow this one.
 */
const TEXT_FIELDS = 'bold,italic,underline,strikethrough,weightedFontFamily,link';

/** Deepest list nesting Docs draws. Anything deeper is clamped to it. */
const MAX_NESTING = 8;

/** The Docs named styles for the six heading levels. */
const HEADINGS = ['HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6'];

const STYLE_COMMENT = /^<!--\s*docsync:\s*style=(title|subtitle)\s*-->$/;
const PAGE_BREAK_COMMENT = /^<!--\s*docsync:pagebreak\s*-->$/;
const PLACEHOLDER_COMMENT = /^<!--\s*docsync:(block|object)\b/;
const OPEN_UNDERLINE = /^<u>$/;
const CLOSE_UNDERLINE = /^<\/u>$/;

/** One block, with everything that has to be sent to write it. */
export interface Segment {
  /** The text it inserts at the insertion point. `''` for a table or a break. */
  text: string;
  /** Its `insertText` (or `insertTable`, `insertPageBreak`) first, then styling. */
  requests: DocsRequest[];
  /** Where in `requests` the `createFootnote`s are, and what goes in each. */
  footnotes: SegmentFootnote[];
}

/** A footnote this segment creates, and the requests that fill it. */
export interface SegmentFootnote {
  /** Position in the segment's `requests` of the `createFootnote`. */
  at: number;
  /** The body, built against the footnote segment's own index space. */
  body: DocsRequest[];
}

/** A footnote in the final request array, once the positions are absolute. */
export interface PlannedFootnote {
  /** Position in `requests` of the `createFootnote` whose reply names the id. */
  requestIndex: number;
  /** The body's requests, addressed to the segment the reply names. */
  requests(segmentId: string): DocsRequest[];
}

/** Everything a push has to send for one document body. */
export interface RequestPlan {
  /** One `documents.batchUpdate`, in order. */
  requests: DocsRequest[];
  /** Sent as a second batch, once the first batch's replies name the segments. */
  footnotes: PlannedFootnote[];
  /** What the API cannot create, named for the push report (MANUAL §7). */
  dropped: string[];
}

/** Canonical Markdown to the requests that write it. */
export function markdownToRequests(text: string): RequestPlan {
  return mdastToRequests(parseMarkdown(text));
}

/** mdast to the requests that write it, for a caller that has the tree. */
export function mdastToRequests(tree: Root): RequestPlan {
  const { segments, dropped } = mdastToSegments(tree);
  return { ...segmentsToRequests(segments), dropped };
}

/**
 * The blocks of one document, in document order, each addressed as if it were
 * inserted at index 1 — which it will be, because they go out in reverse.
 */
export function mdastToSegments(tree: Root): { segments: Segment[]; dropped: string[] } {
  const context: Context = { dropped: [], definitions: definitionsOf(tree), inFootnote: false };
  return { segments: buildSegments(tree.children, context, BODY_BASE), dropped: context.dropped };
}

/**
 * The segments as one request array: reversed, so that every insertion happens
 * at index 1 and none of them disturbs an index another request already names.
 */
export function segmentsToRequests(segments: readonly Segment[]): {
  requests: DocsRequest[];
  footnotes: PlannedFootnote[];
} {
  const requests: DocsRequest[] = [];
  const footnotes: PlannedFootnote[] = [];
  for (const segment of [...segments].reverse()) {
    for (const footnote of segment.footnotes) {
      footnotes.push({
        requestIndex: requests.length + footnote.at,
        requests: (segmentId) => inSegment(footnote.body, segmentId),
      });
    }
    requests.push(...segment.requests);
  }
  return { requests, footnotes };
}

/**
 * The same requests, addressed to one segment. A footnote's body can only be
 * built once its segment exists, and the id arrives in a reply — so the body is
 * built against the segment's index space and stamped with the id here.
 */
function inSegment(requests: readonly DocsRequest[], segmentId: string): DocsRequest[] {
  return requests.map((request) => stamp(request, segmentId) as DocsRequest);
}

function stamp(value: unknown, segmentId: string): unknown {
  if (Array.isArray(value)) return value.map((one) => stamp(one, segmentId));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(record)) out[key] = stamp(one, segmentId);
  // A location and a range are exactly the objects that carry an index.
  if ('index' in record || 'startIndex' in record) out.segmentId = segmentId;
  return out;
}

/** The index every body block is inserted at: after the section break. */
const BODY_BASE = 1;

/** The index a footnote segment starts at. */
const FOOTNOTE_BASE = 0;

interface Context {
  dropped: string[];
  definitions: Map<string, RootContent[]>;
  /** A footnote cannot hold a footnote, so a reference inside one is dropped. */
  inFootnote: boolean;
}

/** The footnote definitions of a document, which GFM puts at the end. */
function definitionsOf(tree: Root): Map<string, RootContent[]> {
  const definitions = new Map<string, RootContent[]>();
  for (const node of tree.children) {
    if (node.type === 'footnoteDefinition') definitions.set(node.identifier, node.children);
  }
  return definitions;
}

/* ------------------------------------------------------------------ blocks */

/** One text run, or the place a footnote reference goes. */
type Piece =
  | { kind: 'text'; text: string; style: RunStyle }
  | { kind: 'footnote'; identifier: string };

/** What the dialect can say about one run. Absent means off. */
interface RunStyle {
  bold?: true;
  italic?: true;
  underline?: true;
  strikethrough?: true;
  code?: true;
  link?: string;
}

/** One paragraph of a segment: its nesting tabs, and its runs. */
interface ParagraphSpec {
  prefix: string;
  pieces: Piece[];
}

/**
 * A run of sibling blocks. An attribute comment applies to the block after it,
 * so this is a cursor loop rather than a `flatMap`.
 */
function buildSegments(nodes: readonly RootContent[], context: Context, base: number): Segment[] {
  const out: Segment[] = [];
  let style: string | undefined;

  for (const node of nodes) {
    if (node.type === 'html') {
      const found = STYLE_COMMENT.exec(node.value.trim());
      if (found !== null) {
        // Title and Subtitle are named styles, not headings (MANUAL §6).
        style = found[1] === 'title' ? 'TITLE' : 'SUBTITLE';
        continue;
      }
      if (PAGE_BREAK_COMMENT.test(node.value.trim())) {
        out.push(pageBreakSegment(base));
        continue;
      }
      // A placeholder produces nothing, and so does any other stray HTML.
      continue;
    }

    const segments = blockSegments(node, context, base, style);
    style = undefined;
    out.push(...segments);
  }

  return out;
}

function blockSegments(
  node: RootContent,
  context: Context,
  base: number,
  style: string | undefined,
): Segment[] {
  switch (node.type) {
    case 'heading':
      return keep(headingSegment(node, context, base, style));
    case 'paragraph':
      return keep(
        textSegment([{ prefix: '', pieces: pieces(node.children, context) }], base, context),
      );
    case 'list':
      return keep(listSegment(node, context, base));
    case 'table':
      return keep(tableSegment(node, context, base));
    case 'code':
      return keep(codeSegment(node, base, context));
    case 'blockquote':
      // The dialect never writes one for Docs, but a person might.
      return buildSegments((node as Blockquote).children, context, base);
    case 'thematicBreak':
      // The Docs API has no request that creates one (ticket 08 decisions).
      context.dropped.push('horizontal rule');
      return [];
    case 'footnoteDefinition':
      // Collected already; the body goes where the reference is.
      return [];
    default:
      return [];
  }
}

function keep(segment: Segment | undefined): Segment[] {
  return segment === undefined ? [] : [segment];
}

function headingSegment(
  node: Heading,
  context: Context,
  base: number,
  style: string | undefined,
): Segment | undefined {
  const named = style ?? HEADINGS[node.depth - 1] ?? 'HEADING_1';
  return textSegment([{ prefix: '', pieces: pieces(node.children, context) }], base, context, {
    named,
  });
}

/** A fenced code block, which Docs can only say in the code font (MANUAL §6). */
function codeSegment(node: Code, base: number, context: Context): Segment | undefined {
  const paragraphs = node.value.split('\n').map((line) => ({
    prefix: '',
    pieces: [{ kind: 'text' as const, text: line, style: { code: true as const } }],
  }));
  return textSegment(paragraphs, base, context);
}

/** A page break is its own block in the dialect and its own request here. */
function pageBreakSegment(base: number): Segment {
  return {
    text: '',
    requests: [{ insertPageBreak: { location: { index: base } } }],
    footnotes: [],
  };
}

/* -------------------------------------------------------------------- text */

interface Bullets {
  /** The preset, and the paragraphs it covers, counted from the segment's start. */
  preset: string;
  from: number;
  to: number;
}

interface TextOptions {
  /** The named paragraph style every paragraph of the segment takes. */
  named?: string;
  /** The bullet runs to create, in document order. */
  bullets?: Bullets[];
}

/**
 * The core of the module: a run of paragraphs as one insertion plus everything
 * that styles it.
 *
 * Order is the whole point. The text goes in first; ranges measured against it
 * follow; then the footnotes, in descending offset order, because each one
 * inserts a character; then the bullets, because they strip the tabs the
 * ranges were measured with.
 */
function textSegment(
  paragraphs: readonly ParagraphSpec[],
  base: number,
  context: Context,
  options: TextOptions = {},
): Segment | undefined {
  // An empty paragraph has no Markdown form, and none is written back either.
  if (paragraphs.every((one) => one.pieces.length === 0)) return undefined;

  let text = '';
  const styles: DocsRequest[] = [];
  const notes: { offset: number; identifier: string }[] = [];
  /** Where each paragraph starts, for the bullet ranges. */
  const starts: number[] = [];

  for (const paragraph of paragraphs) {
    starts.push(text.length);
    text += paragraph.prefix;
    for (const piece of paragraph.pieces) {
      if (piece.kind === 'footnote') {
        notes.push({ offset: text.length, identifier: piece.identifier });
        continue;
      }
      const from = text.length;
      text += piece.text;
      if (piece.text !== '') styles.push(textStyleRequest(base + from, base + text.length, piece));
    }
    text += '\n';
  }
  starts.push(text.length);

  const requests: DocsRequest[] = [{ insertText: { location: { index: base }, text } }];
  requests.push({
    updateParagraphStyle: {
      range: range(base, base + text.length),
      paragraphStyle: { namedStyleType: options.named ?? 'NORMAL_TEXT' },
      fields: 'namedStyleType',
    },
  });
  // Text inserted at index 1 lands inside whatever paragraph is there, and
  // inherits its bullet: a block before a list would join the list. A list
  // clears them too, and must — `createParagraphBullets` only reads the
  // leading tabs of a paragraph that is not already a list item, which is what
  // the manual test caught (ticket 08 Outcome).
  requests.push({ deleteParagraphBullets: { range: range(base, base + text.length) } });
  requests.push(...styles);

  const footnotes: SegmentFootnote[] = [];
  for (const note of [...notes].reverse()) {
    footnotes.push({
      at: requests.length,
      body: footnoteBodyOf(context.definitions.get(note.identifier) ?? [], context),
    });
    requests.push({ createFootnote: { location: { index: base + note.offset } } });
  }

  // Every footnote reference is one more character in the body, which the
  // bullet ranges below have to cover.
  const end = base + text.length + notes.length;
  for (const bullets of [...(options.bullets ?? [])].reverse()) {
    requests.push({
      createParagraphBullets: {
        range: range(
          base + (starts[bullets.from] ?? 0),
          Math.min(base + (starts[bullets.to] ?? 0), end),
        ),
        bulletPreset: bullets.preset,
      },
    });
  }

  return { text, requests, footnotes };
}

function range(startIndex: number, endIndex: number): DocsRequest {
  return { startIndex, endIndex };
}

/** One run's styling: the whole mask, so nothing is inherited (see above). */
function textStyleRequest(
  startIndex: number,
  endIndex: number,
  piece: { style: RunStyle },
): DocsRequest {
  const style = piece.style;
  const textStyle: Record<string, unknown> = {
    bold: style.bold === true,
    italic: style.italic === true,
    underline: style.underline === true,
    strikethrough: style.strikethrough === true,
  };
  // The read side calls a monospace family inline code; this is how we say it.
  if (style.code === true) textStyle.weightedFontFamily = { fontFamily: CODE_FONT, weight: 400 };
  if (style.link !== undefined) textStyle.link = { url: style.link };
  return {
    updateTextStyle: { range: range(startIndex, endIndex), textStyle, fields: TEXT_FIELDS },
  };
}

/** The requests that fill one footnote, in the footnote segment's own space. */
function footnoteBodyOf(nodes: readonly RootContent[], context: Context): DocsRequest[] {
  const inner: Context = { ...context, inFootnote: true };
  return segmentsToRequests(buildSegments(nodes, inner, FOOTNOTE_BASE)).requests;
}

/* ------------------------------------------------------------------- lists */

/** One list item, flattened out of the tree the way Docs stores it. */
interface FlatItem {
  level: number;
  kind: ListKind;
  pieces: Piece[];
}

function listSegment(node: List, context: Context, base: number): Segment | undefined {
  const items: FlatItem[] = [];
  flatten(node, 0, items, context);
  if (items.length === 0) return undefined;

  // Nesting is leading tabs in the inserted text; `createParagraphBullets`
  // reads them, sets the level, and takes them out again.
  const paragraphs = items.map((item) => ({
    prefix: '\t'.repeat(Math.min(item.level, MAX_NESTING)),
    pieces: item.pieces,
  }));

  // One request per run of items that want the same preset. A run of its own
  // is a list of its own, which is exactly what Docs does with a nested list.
  const bullets: Bullets[] = [];
  for (const [index, item] of items.entries()) {
    const preset = BULLET_PRESETS[item.kind];
    const last = bullets.at(-1);
    if (last !== undefined && last.preset === preset && last.to === index) last.to = index + 1;
    else bullets.push({ preset, from: index, to: index + 1 });
  }

  return textSegment(paragraphs, base, context, { bullets });
}

/** A list and the lists inside it, as one flat run of levelled items. */
function flatten(node: List, level: number, out: FlatItem[], context: Context): void {
  for (const child of node.children) {
    const item = child as ListItem;
    const kind: ListKind =
      item.checked === null || item.checked === undefined
        ? node.ordered === true
          ? 'ordered'
          : 'bullet'
        : 'checklist';
    const lead = item.children.find((one) => one.type === 'paragraph') as Paragraph | undefined;
    out.push({ level, kind, pieces: lead === undefined ? [] : pieces(lead.children, context) });
    for (const nested of item.children) {
      if (nested.type === 'list') flatten(nested, level + 1, out, context);
    }
  }
}

/* ------------------------------------------------------------------ tables */

/**
 * A table: the empty grid first, then its cells filled from the last one
 * backwards, so that filling a cell never moves a cell still to be filled.
 *
 * The cell indices are the API's own arithmetic. `insertTable` puts a newline
 * before the table, so the table starts at `base + 1`; a row starts one past
 * the table, a cell one past the row, and a cell's paragraph one past the cell.
 * Every cell of a fresh table holds one empty paragraph, one code unit long.
 */
function tableSegment(node: Table, context: Context, base: number): Segment | undefined {
  const rows = node.children;
  const columns = Math.max(...rows.map((row) => row.children.length), 0);
  if (rows.length === 0 || columns === 0) return undefined;

  const requests: DocsRequest[] = [
    { insertTable: { rows: rows.length, columns, location: { index: base } } },
    // The newline `insertTable` puts before the table is a paragraph of the
    // block that was there, bullet and all; it is not part of this one.
    { deleteParagraphBullets: { range: range(base, base + 1) } },
  ];

  for (let row = rows.length - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const cell = rows[row]?.children[column];
      const at = base + 4 + row * (2 * columns + 1) + 2 * column;
      const content = cell === undefined ? [] : pieces(cell.children, context, true);
      let offset = 0;
      const styles: DocsRequest[] = [];
      let text = '';
      for (const piece of content) {
        if (piece.kind === 'footnote') continue;
        const from = at + offset;
        text += piece.text;
        offset += piece.text.length;
        if (piece.text !== '') styles.push(textStyleRequest(from, at + offset, piece));
      }
      if (text === '') continue;
      requests.push({ insertText: { location: { index: at }, text } }, ...styles);
    }
  }

  return { text: '', requests, footnotes: [] };
}

/* ------------------------------------------------------------------ inline */

/** Phrasing content as runs, with adjacent runs that agree merged into one. */
function pieces(nodes: readonly PhrasingContent[], context: Context, inCell = false): Piece[] {
  const out: Piece[] = [];
  walk(nodes, {}, out, context, inCell);
  return merge(out);
}

function walk(
  nodes: readonly PhrasingContent[],
  style: RunStyle,
  out: Piece[],
  context: Context,
  inCell: boolean,
): void {
  let current = style;
  const stack: RunStyle[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ kind: 'text', text: node.value, style: current });
        break;
      case 'inlineCode':
        out.push({ kind: 'text', text: node.value, style: { ...current, code: true } });
        break;
      case 'break':
        // A line break inside one paragraph is a vertical tab (MANUAL §6).
        out.push({ kind: 'text', text: VERTICAL_TAB, style: current });
        break;
      case 'strong':
        walk(node.children, { ...current, bold: true }, out, context, inCell);
        break;
      case 'emphasis':
        walk(node.children, { ...current, italic: true }, out, context, inCell);
        break;
      case 'delete':
        walk(node.children, { ...current, strikethrough: true }, out, context, inCell);
        break;
      case 'link':
        walk(node.children, { ...current, link: node.url }, out, context, inCell);
        break;
      case 'footnoteReference':
        // A footnote lives in the body: Docs has nowhere to put one inside a
        // table cell, and nowhere to put one inside another footnote.
        if (inCell || context.inFootnote) context.dropped.push('footnote');
        else out.push({ kind: 'footnote', identifier: node.identifier });
        break;
      case 'image':
        // Attachments are ticket 14; a push cannot create one (MANUAL §6).
        context.dropped.push('image');
        break;
      case 'html': {
        const value = node.value.trim();
        if (OPEN_UNDERLINE.test(value)) {
          stack.push(current);
          current = { ...current, underline: true };
        } else if (CLOSE_UNDERLINE.test(value)) {
          current = stack.pop() ?? style;
        } else if (PLACEHOLDER_COMMENT.test(value)) {
          // A placeholder produces nothing (MANUAL §7).
        }
        break;
      }
      default:
        // Inline math and anything remark adds later.
        break;
    }
  }
}

/**
 * Adjacent runs that agree on everything are one run. Markdown splits text at
 * escapes and entities; Docs does not, and a run per escape would make the
 * request array unreadable without changing what it writes.
 */
function merge(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (
      piece.kind === 'text' &&
      last !== undefined &&
      last.kind === 'text' &&
      sameStyle(last.style, piece.style)
    ) {
      last.text += piece.text;
      continue;
    }
    out.push(piece.kind === 'text' ? { ...piece } : piece);
  }
  return out.filter((piece) => piece.kind !== 'text' || piece.text !== '');
}

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.code === b.code &&
    a.link === b.link
  );
}
