/**
 * A Google Doc's document model to canonical Markdown (MANUAL §6).
 *
 * Pure: it is handed the JSON `documents.get` answered — the same JSON
 * `__fixtures__/` records — and answers text. It builds mdast and hands it to
 * the one pipeline in `src/markdown.ts`; there is no second Markdown emitter,
 * which is what keeps escaping correct and the round trip honest.
 *
 * Docs is not a block model the way Notion is. A page break, a horizontal rule,
 * an image and a footnote marker are all *inline* elements inside a paragraph,
 * and a list is a run of paragraphs that happen to carry a `bullet`. So the
 * shape of this module is: split the body into structural elements, split each
 * paragraph at the inline elements that are really blocks, and group list
 * paragraphs back into trees.
 *
 * What Docs stores and the dialect does not carry — colour, highlight, font,
 * size, alignment, indentation — is dropped here (MANUAL §6, §7). Comments
 * never arrive. Suggestions do, since ticket 16: a push asks for the document
 * with them inline, and the body this module describes is the one they were
 * suggested against (see `convertDocument`).
 *
 * A caller that means to write the document back asks for **provenance**: every
 * node then carries the index range it came from under `data.gdocs`, which is
 * what `ranges.ts` turns into the map a patch addresses the document through.
 */
import type {
  BlockContent,
  FootnoteDefinition,
  List,
  ListItem,
  TableCell as MdTableCell,
  TableRow as MdTableRow,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast';
import { linkToAsset } from '../assets.js';
import { stringifyMarkdown } from '../markdown.js';
import type {
  DocsDocument,
  DocsList,
  NestingLevel,
  Paragraph,
  ParagraphElement,
  StructuralElement,
  TextStyle,
} from './api.js';

/**
 * A run in one of these fonts is inline code. It is the only signal Docs has
 * for code: there is no character style for it (ticket 07 decisions). Compared
 * case-insensitively, because an imported document spells them in lower case.
 */
export const CODE_FONTS = [
  'Courier New',
  'Roboto Mono',
  'Consolas',
  'Source Code Pro',
  'Menlo',
] as const;

const CODE_FONT_SET = new Set(CODE_FONTS.map((font) => font.toLowerCase()));

/** A soft line break inside a paragraph, which Docs stores as a vertical tab. */
const VERTICAL_TAB = '\u000B';

/** Named paragraph styles that are headings, and the level they print at. */
const HEADINGS: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

/**
 * Title and Subtitle are their own named styles, not headings, and a plain `#`
 * is Heading 1 — so they carry the block-attribute comment (MANUAL §6).
 */
const DOCUMENT_STYLES: Record<string, { depth: 1 | 2; style: string }> = {
  TITLE: { depth: 1, style: 'title' },
  SUBTITLE: { depth: 2, style: 'subtitle' },
};

/** What a run of list paragraphs is. */
type ListKind = 'bullet' | 'ordered' | 'checklist';

/** One list paragraph, flattened, before the tree is rebuilt from `level`. */
interface FlatItem {
  level: number;
  kind: ListKind;
  content: PhrasingContent[];
  /** The paragraph the item is, for the patch (ticket 16). */
  origin: Omit<Origin, 'segmentId'>;
}

/** The conversion in progress: the document, and the footnotes met so far. */
interface Context {
  /** Where the inline images went, and what to write them relative to. */
  assets?: ReadonlyMap<string, string>;
  from?: string;
  doc: DocsDocument;
  /** Footnote definitions in the order their references appeared. */
  footnotes: FootnoteDefinition[];
  seen: Set<string>;
  /** Whether every node records where in the document it came from. */
  provenance: boolean;
  /** The footnote segment being converted. Absent for the body. */
  segmentId?: string;
  /** Suggestion ids met in the paragraph being converted. */
  pending: Set<string>;
  /** Suggestion ids met anywhere in the document. */
  suggestions: Set<string>;
}

/**
 * Where a node came from in the live document, in the UTF-16 code units both
 * `documents.get` and `batchUpdate` count in (ticket 16).
 *
 * Recorded under `data.gdocs`, which nothing in the Markdown pipeline reads,
 * and only when the caller asks: a fetch has no use for it.
 */
export interface Origin {
  /** The footnote segment the indices are in. Absent for the body. */
  segmentId?: string;
  /** The first index the node covers. */
  start: number;
  /** One past the last. A paragraph's own newline is inside it. */
  end: number;
  /** How many characters the node contributes to its block's plain text. */
  text?: number;
  /** Whether an edit cannot cut it in half: a footnote reference, an image. */
  atomic?: boolean;
  /** Pending suggestions inside it (MANUAL §7). */
  suggestions?: string[];
}

/** A node's origin, or `undefined` when it was built without provenance. */
export function originOf(node: { data?: unknown } | undefined): Origin | undefined {
  return (node?.data as { gdocs?: Origin } | undefined)?.gdocs;
}

export interface ConvertOptions {
  /** Record every node's origin under `data.gdocs`, for the patch. */
  provenance?: boolean;
  /**
   * Where the document's inline images were written, by object id (MANUAL §12
   * phase 2). An image in here is linked into `<title>.assets/`; one that is
   * not — because nothing downloaded it — keeps the placeholder it had.
   */
  assets?: ReadonlyMap<string, string>;
  /** Repo-relative path of the document, for those relative links. */
  from?: string;
}

/** What a conversion learned about the document beyond the tree itself. */
export interface Converted {
  tree: Root;
  /** Every pending suggestion the document carries, in document order. */
  suggestions: string[];
}

/** A Google Doc to canonical Markdown text. */
export function documentToMarkdown(doc: DocsDocument, options: ConvertOptions = {}): string {
  return stringifyMarkdown(documentToMdast(doc, options));
}

/** A Google Doc to mdast, for callers that want the tree (the round trip). */
export function documentToMdast(doc: DocsDocument, options: ConvertOptions = {}): Root {
  return convertDocument(doc, options).tree;
}

/**
 * The same conversion, with what a suggestions view adds to it.
 *
 * A document fetched with `suggestionsViewMode=SUGGESTIONS_INLINE` carries both
 * sides of every pending suggestion at once. The body the dialect describes is
 * the one the suggestions were made *against*: a suggested insertion is
 * dropped, a suggested deletion is kept, and the indices stay the live ones
 * either way — so a patch computed from this text addresses the document as it
 * really is (ticket 16, MANUAL §7).
 */
export function convertDocument(doc: DocsDocument, options: ConvertOptions = {}): Converted {
  const context: Context = {
    doc,
    footnotes: [],
    seen: new Set(),
    provenance: options.provenance === true,
    pending: new Set(),
    suggestions: new Set(),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.from === undefined ? {} : { from: options.from }),
  };
  const children = convertContent(doc.body?.content ?? [], context);
  // GFM puts every definition at the end of the document (MANUAL §6).
  return {
    tree: { type: 'root', children: [...children, ...context.footnotes] },
    suggestions: [...context.suggestions],
  };
}

/** One node, with its origin on it when the caller asked for provenance. */
function mark<T extends RootContent | PhrasingContent | MdTableRow | MdTableCell>(
  node: T,
  context: Context,
  origin: Omit<Origin, 'segmentId'>,
): T {
  if (!context.provenance) return node;
  return {
    ...node,
    data: {
      ...(node.data ?? {}),
      gdocs: {
        ...origin,
        ...(context.segmentId === undefined ? {} : { segmentId: context.segmentId }),
      },
    },
  };
}

/** The suggestion ids met since the last `takeSuggestions`, in order. */
function takeSuggestions(context: Context): string[] {
  const found = [...context.pending];
  context.pending.clear();
  return found;
}

/** A run of structural elements: a body, a footnote, or one table cell. */
function convertContent(content: readonly StructuralElement[], context: Context): RootContent[] {
  const out: RootContent[] = [];
  let index = 0;

  while (index < content.length) {
    const element = content[index];
    if (element === undefined) break;

    if (element.paragraph?.bullet !== undefined) {
      const items: FlatItem[] = [];
      while (index < content.length) {
        const paragraph = content[index]?.paragraph;
        if (paragraph?.bullet === undefined) break;
        const element = content[index];
        items.push({
          level: paragraph.bullet.nestingLevel ?? 0,
          kind: kindOf(context.doc.lists?.[paragraph.bullet.listId ?? ''], paragraph.bullet),
          content: inline(paragraph.elements ?? [], context),
          origin: {
            start: element?.startIndex ?? 0,
            end: element?.endIndex ?? 0,
            suggestions: takeSuggestions(context),
          },
        });
        index += 1;
      }
      // A run can hold more than one tree: a list that starts deeper than it
      // ends leaves items behind, and they are lists of their own.
      let at = 0;
      while (at < items.length) {
        const [nodes, next] = listsFrom(items, at, context);
        out.push(...nodes);
        at = next;
      }
      continue;
    }

    out.push(...convertElement(element, context));
    index += 1;
  }

  return out;
}

/** One structural element that is not a list item. */
function convertElement(element: StructuralElement, context: Context): RootContent[] {
  if (element.paragraph !== undefined) return paragraph(element.paragraph, context, element);
  if (element.table !== undefined) return table(element, context);
  if (element.tableOfContents !== undefined) {
    return [blockPlaceholder(context, element, 'table-of-contents')];
  }
  // A section break carries page setup and nothing the dialect can hold.
  return [];
}

/**
 * One paragraph. A page break is an inline element in Docs but a block in the
 * dialect, so the paragraph is cut at every one of them.
 */
function paragraph(node: Paragraph, context: Context, element: StructuralElement): RootContent[] {
  const style = node.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const out: RootContent[] = [];

  for (const part of splitAtPageBreaks(node.elements ?? [], element)) {
    if (part.after !== undefined) {
      out.push(
        mark({ type: 'html', value: '<!-- docsync:pagebreak -->' }, context, {
          start: part.after.startIndex ?? 0,
          end: part.after.endIndex ?? 0,
        }),
      );
    }

    // A rule is an inline element in an otherwise empty paragraph.
    for (const rule of part.elements) {
      if (rule.horizontalRule === undefined) continue;
      out.push(
        mark({ type: 'thematicBreak' }, context, {
          start: rule.startIndex ?? part.start,
          end: rule.endIndex ?? part.end,
        }),
      );
    }

    const children = inline(part.elements, context);
    const origin = { start: part.start, end: part.end, suggestions: takeSuggestions(context) };
    // An empty paragraph has no Markdown form (MANUAL §6).
    if (children.length === 0) continue;

    const document = DOCUMENT_STYLES[style];
    if (document !== undefined) {
      out.push(
        { type: 'html', value: `<!-- docsync: style=${document.style} -->` },
        mark({ type: 'heading', depth: document.depth, children }, context, origin),
      );
      continue;
    }
    const depth = HEADINGS[style];
    out.push(
      mark(
        depth === undefined
          ? { type: 'paragraph', children }
          : { type: 'heading', depth, children },
        context,
        origin,
      ),
    );
  }

  return out;
}

/** One stretch of a paragraph between two page breaks, and where it sits. */
interface Part {
  elements: ParagraphElement[];
  /** The page break this part follows, for the comment that stands for it. */
  after?: ParagraphElement;
  start: number;
  end: number;
}

/**
 * The paragraph's elements, cut into one group per page break, each carrying
 * the range it covers: the paragraph's own, up to the first break, and from a
 * break to the next one. The last part ends where the paragraph does, so it is
 * the one that owns the newline.
 */
function splitAtPageBreaks(
  elements: readonly ParagraphElement[],
  element: StructuralElement,
): Part[] {
  const start = element.startIndex ?? elements[0]?.startIndex ?? 0;
  const end = element.endIndex ?? elements.at(-1)?.endIndex ?? start;
  const parts: Part[] = [{ elements: [], start, end }];
  for (const one of elements) {
    if (one.pageBreak !== undefined) {
      const last = parts.at(-1);
      if (last !== undefined) last.end = one.startIndex ?? last.end;
      parts.push({ elements: [], after: one, start: one.endIndex ?? start, end });
      continue;
    }
    parts.at(-1)?.elements.push(one);
  }
  return parts;
}

/** A table, or the placeholder that stands for one the dialect cannot hold. */
function table(element: StructuralElement, context: Context): RootContent[] {
  const rows = element.table?.tableRows ?? [];
  const merged = rows.some((row) =>
    (row.tableCells ?? []).some(
      (cell) =>
        (cell.tableCellStyle?.rowSpan ?? 1) > 1 || (cell.tableCellStyle?.columnSpan ?? 1) > 1,
    ),
  );
  // Merged cells are not supported and make the table a placeholder (MANUAL §6).
  if (rows.length === 0 || merged) return [blockPlaceholder(context, element, 'table')];

  const width = Math.max(
    element.table?.columns ?? 0,
    ...rows.map((row) => (row.tableCells ?? []).length),
  );
  const children: MdTableRow[] = rows.map((row) => {
    const cells = row.tableCells ?? [];
    const out: MdTableCell[] = [];
    for (let column = 0; column < width; column += 1) {
      const cell = cells[column];
      out.push(
        mark({ type: 'tableCell', children: cellContent(cell?.content ?? [], context) }, context, {
          start: cell?.startIndex ?? 0,
          end: cell?.endIndex ?? 0,
        }),
      );
    }
    return mark({ type: 'tableRow', children: out }, context, {
      start: row.startIndex ?? 0,
      end: row.endIndex ?? 0,
    });
  });
  return [
    mark({ type: 'table', align: [], children }, context, {
      start: element.startIndex ?? 0,
      end: element.endIndex ?? 0,
    }),
  ];
}

/** A cell holds inline formatting only (MANUAL §6), so its blocks are flattened. */
function cellContent(content: readonly StructuralElement[], context: Context): PhrasingContent[] {
  return convertContent(content, context).flatMap((node) =>
    node.type === 'paragraph' ? node.children : [],
  );
}

/** The placeholder for a block the dialect cannot express (MANUAL §6). */
function blockPlaceholder(context: Context, element: StructuralElement, type: string): RootContent {
  // A Docs structural element has no id of its own, so it is addressed by the
  // document it is in and the index it starts at.
  const at = `${context.doc.documentId ?? ''}#${element.startIndex ?? ''}`;
  return mark({ type: 'html', value: `<!-- docsync:block gdocs:${at} type=${type} -->` }, context, {
    start: element.startIndex ?? 0,
    end: element.endIndex ?? 0,
  });
}

/** Which of the three lists a `bullet` belongs to (ticket 07 decisions). */
function kindOf(list: DocsList | undefined, bullet: NonNullable<Paragraph['bullet']>): ListKind {
  const level = list?.listProperties?.nestingLevels?.[bullet.nestingLevel ?? 0];
  return glyphKind(level);
}

/**
 * The glyph tells the three lists apart: a bullet has a symbol to draw, a
 * numbered list has a glyph type and a format with punctuation in it, and a
 * checklist is Docs' odd one out — no symbol, no type, and a bare `%0`.
 *
 * A list that says none of this (an HTML-imported document: see the ticket 07
 * Outcome) is drawn as a bullet, which is what Docs itself defaults to.
 */
function glyphKind(level: NestingLevel | undefined): ListKind {
  if (level === undefined) return 'bullet';
  if (level.glyphSymbol !== undefined && level.glyphSymbol !== '') return 'bullet';
  if (level.glyphType !== undefined && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED') {
    return 'ordered';
  }
  return /^%\d+$/.test(level.glyphFormat ?? '') ? 'checklist' : 'bullet';
}

/**
 * The flattened items back into nested lists. A run keeps going while the
 * level and the kind hold; a change of kind at one level starts a sibling list,
 * and a deeper level becomes a list inside the item above it.
 */
function listsFrom(
  items: readonly FlatItem[],
  start: number,
  context: Context,
): [RootContent[], number] {
  const out: RootContent[] = [];
  const level = items[start]?.level ?? 0;
  let index = start;

  while (index < items.length && (items[index]?.level ?? 0) >= level) {
    const kind = items[index]?.kind ?? 'bullet';
    const list: List = {
      type: 'list',
      ordered: kind === 'ordered',
      start: kind === 'ordered' ? 1 : null,
      spread: false,
      children: [],
    };

    while (index < items.length) {
      const item = items[index];
      if (item === undefined || item.level !== level || item.kind !== kind) break;
      index += 1;

      const children: BlockContent[] = [{ type: 'paragraph', children: item.content }];
      if ((items[index]?.level ?? -1) > level) {
        const [nested, next] = listsFrom(items, index, context);
        children.push(...(nested as BlockContent[]));
        index = next;
      }
      const node: ListItem = {
        type: 'listItem',
        spread: false,
        // The Docs API does not report which box is ticked, so a checklist
        // item is always unchecked (ticket 07 Outcome).
        checked: kind === 'checklist' ? false : null,
        children,
      };
      list.children.push(mark(node, context, item.origin));
    }

    out.push(list);
  }

  return [out, index];
}

/** A paragraph's elements as inline Markdown. */
function inline(elements: readonly ParagraphElement[], context: Context): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const element of elements) out.push(...inlineElement(element, context));
  // A paragraph ends in the newline Docs stores; it is not content.
  while (out.length > 0 && isEmptyText(out.at(-1))) out.pop();
  return out;
}

function isEmptyText(node: PhrasingContent | undefined): boolean {
  return node?.type === 'text' && node.value === '';
}

function inlineElement(element: ParagraphElement, context: Context): PhrasingContent[] {
  if (element.textRun !== undefined) {
    const run = element.textRun;
    for (const id of [...(run.suggestedInsertionIds ?? []), ...(run.suggestedDeletionIds ?? [])]) {
      context.pending.add(id);
      context.suggestions.add(id);
    }
    // A suggested insertion is not in the version the suggestion was made
    // against, and that version is the base a push diffs from (MANUAL §7).
    if ((run.suggestedInsertionIds ?? []).length > 0) return [];
    return annotate(run.content ?? '', run.textStyle ?? {}, context, element.startIndex ?? 0);
  }
  if (element.footnoteReference !== undefined) return [footnote(element, context)];
  if (element.inlineObjectElement !== undefined) return [inlineObject(element, context)];
  // A rule is emitted as a block by `paragraph`; a page break splits it.
  if (element.horizontalRule !== undefined || element.pageBreak !== undefined) return [];
  return [
    objectPlaceholder(
      `${context.doc.documentId ?? ''}#${element.startIndex ?? ''}`,
      kindOfUnknown(element),
      context,
      element,
    ),
  ];
}

/** The name of an element this module has no conversion for. */
function kindOfUnknown(element: ParagraphElement): string {
  for (const key of Object.keys(element)) {
    if (key !== 'startIndex' && key !== 'endIndex') return key;
  }
  return 'unknown';
}

/**
 * An inline object. An image the fetch downloaded is an `![alt](path)` link
 * into `<title>.assets/`; anything else — a drawing, an image nobody
 * downloaded — is the placeholder carrying its object id (MANUAL §6, §12
 * phase 2).
 *
 * Either way it stays inline, so an image in the middle of a sentence does not
 * cut the sentence in two, and either way it is **atomic**: one code unit in
 * the document, all of it or none of it in the Markdown.
 */
function inlineObject(element: ParagraphElement, context: Context): PhrasingContent {
  const id = element.inlineObjectElement?.inlineObjectId ?? '';
  const embedded = context.doc.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject;
  const asset = context.assets?.get(id);
  if (asset !== undefined && embedded?.imageProperties !== undefined) {
    // Docs keeps the alt text in two fields; the description is the one the
    // editor's "Alt text" box writes, and the title is the older one.
    const alt = embedded.description ?? embedded.title ?? '';
    const node: PhrasingContent = {
      type: 'image',
      url: linkToAsset(context.from ?? '', asset),
      alt,
    };
    return mark(node, context, {
      start: element.startIndex ?? 0,
      end: element.endIndex ?? (element.startIndex ?? 0) + 1,
      // What the block's plain text says at this offset is the alt text: that
      // is what `plain` and `inlineRuns` count (`src/diff/`).
      text: alt.length,
      atomic: true,
    });
  }
  let type = 'object';
  if (embedded?.imageProperties !== undefined) type = 'image';
  else if (embedded?.embeddedDrawingProperties !== undefined) type = 'drawing';
  return objectPlaceholder(id, type, context, element);
}

/**
 * One inline element the dialect cannot carry. It is one code unit in the
 * document and a whole comment in the Markdown, so it is atomic: an edit that
 * reaches into it takes the object with it (MANUAL §7).
 */
function objectPlaceholder(
  id: string,
  type: string,
  context: Context,
  element: ParagraphElement,
): PhrasingContent {
  const value = `<!-- docsync:object gdocs:${id} type=${type} -->`;
  return mark({ type: 'html', value }, context, {
    start: element.startIndex ?? 0,
    end: element.endIndex ?? (element.startIndex ?? 0) + 1,
    text: value.length,
    atomic: true,
  });
}

/** `[^n]`, with the definition collected for the end of the document. */
function footnote(element: ParagraphElement, context: Context): PhrasingContent {
  const reference = element.footnoteReference ?? {};
  const identifier = reference.footnoteNumber ?? String(context.footnotes.length + 1);
  const segmentId = reference.footnoteId ?? '';
  const body = context.doc.footnotes?.[segmentId];
  if (body !== undefined && !context.seen.has(identifier)) {
    context.seen.add(identifier);
    // The body is a document of its own, in a segment of its own, so the
    // indices inside it are the segment's and are marked as such.
    const outer = { segmentId: context.segmentId, pending: context.pending };
    context.segmentId = segmentId;
    context.pending = new Set();
    const children = trimLeading(convertContent(body.content ?? [], context)) as BlockContent[];
    const end = body.content?.at(-1)?.endIndex ?? 1;
    context.segmentId = segmentId;
    context.footnotes.push(
      mark(
        { type: 'footnoteDefinition', identifier, label: identifier, children },
        context,
        // Docs writes the note with a leading space after the marker.
        { start: 0, end },
      ),
    );
    context.segmentId = outer.segmentId;
    context.pending = outer.pending;
  }
  return mark({ type: 'footnoteReference', identifier, label: identifier }, context, {
    start: element.startIndex ?? 0,
    end: element.endIndex ?? (element.startIndex ?? 0) + 1,
    text: 0,
    atomic: true,
  });
}

/** Drops the space Docs puts between a footnote's number and its text. */
function trimLeading(nodes: RootContent[]): RootContent[] {
  const first = nodes[0];
  if (first?.type !== 'paragraph') return nodes;
  const head = first.children[0];
  if (head?.type !== 'text') return nodes;
  const value = head.value.replace(/^\s+/, '');
  const origin = originOf(head);
  // The characters that go are characters of the document all the same, so the
  // run's origin moves with them.
  if (origin !== undefined) {
    origin.start += head.value.length - value.length;
    origin.text = value.length;
  }
  head.value = value;
  return nodes;
}

/**
 * One text run: its content, wrapped in its annotations from the inside out.
 * The order is fixed — code, underline, strikethrough, italic, bold, link — so
 * that the same styling always produces the same Markdown.
 */
function annotate(
  content: string,
  style: TextStyle,
  context: Context,
  start: number,
): PhrasingContent[] {
  if (content === '') return [];
  let nodes = textNodes(content, style, context, start);
  if (style.underline === true && style.link?.url === undefined) {
    nodes = [{ type: 'html', value: '<u>' }, ...nodes, { type: 'html', value: '</u>' }];
  }
  if (style.strikethrough === true) nodes = [{ type: 'delete', children: nodes }];
  if (style.italic === true) nodes = [{ type: 'emphasis', children: nodes }];
  if (style.bold === true) nodes = [{ type: 'strong', children: nodes }];
  const url = style.link?.url;
  if (url !== undefined) nodes = [{ type: 'link', url, children: nodes }];
  return nodes;
}

/**
 * The text itself. A vertical tab is a soft line break, which prints as two
 * trailing spaces and a newline (MANUAL §6); the newline Docs ends every
 * paragraph with is not content and goes the same way, into nothing.
 */
function textNodes(
  content: string,
  style: TextStyle,
  context: Context,
  start: number,
): PhrasingContent[] {
  const text = content.replace(/\n$/, '');
  const font = style.weightedFontFamily?.fontFamily?.toLowerCase() ?? '';
  if (CODE_FONT_SET.has(font)) {
    return text === ''
      ? []
      : [
          mark({ type: 'inlineCode', value: text }, context, {
            start,
            end: start + text.length,
            text: text.length,
          }),
        ];
  }

  const out: PhrasingContent[] = [];
  let at = start;
  for (const [index, line] of text.split(VERTICAL_TAB).entries()) {
    // A soft line break is the one code unit the vertical tab occupies, and
    // one character of the block's text (MANUAL §6).
    if (index > 0) {
      out.push(mark({ type: 'break' }, context, { start: at, end: at + 1, text: 1 }));
      at += 1;
    }
    out.push(
      mark({ type: 'text', value: line }, context, {
        start: at,
        end: at + line.length,
        text: line.length,
      }),
    );
    at += line.length;
  }
  return out;
}
