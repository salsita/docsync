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
 * size, alignment, indentation — is dropped here (MANUAL §6, §7). Comments and
 * suggestions never arrive: `api.ts` asks for the document without them.
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
}

/** The conversion in progress: the document, and the footnotes met so far. */
interface Context {
  doc: DocsDocument;
  /** Footnote definitions in the order their references appeared. */
  footnotes: FootnoteDefinition[];
  seen: Set<string>;
}

/** A Google Doc to canonical Markdown text. */
export function documentToMarkdown(doc: DocsDocument): string {
  return stringifyMarkdown(documentToMdast(doc));
}

/** A Google Doc to mdast, for callers that want the tree (the round trip). */
export function documentToMdast(doc: DocsDocument): Root {
  const context: Context = { doc, footnotes: [], seen: new Set() };
  const children = convertContent(doc.body?.content ?? [], context);
  // GFM puts every definition at the end of the document (MANUAL §6).
  return { type: 'root', children: [...children, ...context.footnotes] };
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
        items.push({
          level: paragraph.bullet.nestingLevel ?? 0,
          kind: kindOf(context.doc.lists?.[paragraph.bullet.listId ?? ''], paragraph.bullet),
          content: inline(paragraph.elements ?? [], context),
        });
        index += 1;
      }
      // A run can hold more than one tree: a list that starts deeper than it
      // ends leaves items behind, and they are lists of their own.
      let at = 0;
      while (at < items.length) {
        const [nodes, next] = listsFrom(items, at);
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
  if (element.paragraph !== undefined) return paragraph(element.paragraph, context);
  if (element.table !== undefined) return table(element, context);
  if (element.tableOfContents !== undefined) {
    return [blockPlaceholder(context, element.startIndex, 'table-of-contents')];
  }
  // A section break carries page setup and nothing the dialect can hold.
  return [];
}

/**
 * One paragraph. A page break is an inline element in Docs but a block in the
 * dialect, so the paragraph is cut at every one of them.
 */
function paragraph(node: Paragraph, context: Context): RootContent[] {
  const style = node.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
  const out: RootContent[] = [];

  for (const [position, part] of splitAtPageBreaks(node.elements ?? []).entries()) {
    if (position > 0) out.push({ type: 'html', value: '<!-- docsync:pagebreak -->' });

    // A rule is an inline element in an otherwise empty paragraph.
    const rules = part.filter((element) => element.horizontalRule !== undefined).length;
    for (let n = 0; n < rules; n += 1) out.push({ type: 'thematicBreak' });

    const children = inline(part, context);
    // An empty paragraph has no Markdown form (MANUAL §6).
    if (children.length === 0) continue;

    const document = DOCUMENT_STYLES[style];
    if (document !== undefined) {
      out.push(
        { type: 'html', value: `<!-- docsync: style=${document.style} -->` },
        { type: 'heading', depth: document.depth, children },
      );
      continue;
    }
    const depth = HEADINGS[style];
    out.push(
      depth === undefined ? { type: 'paragraph', children } : { type: 'heading', depth, children },
    );
  }

  return out;
}

/** The paragraph's elements, cut into one group per page break. */
function splitAtPageBreaks(elements: readonly ParagraphElement[]): ParagraphElement[][] {
  const parts: ParagraphElement[][] = [[]];
  for (const element of elements) {
    if (element.pageBreak !== undefined) parts.push([]);
    else parts.at(-1)?.push(element);
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
  if (rows.length === 0 || merged) return [blockPlaceholder(context, element.startIndex, 'table')];

  const width = Math.max(
    element.table?.columns ?? 0,
    ...rows.map((row) => (row.tableCells ?? []).length),
  );
  const children: MdTableRow[] = rows.map((row) => {
    const cells = row.tableCells ?? [];
    const out: MdTableCell[] = [];
    for (let column = 0; column < width; column += 1) {
      out.push({ type: 'tableCell', children: cellContent(cells[column]?.content ?? [], context) });
    }
    return { type: 'tableRow', children: out };
  });
  return [{ type: 'table', align: [], children }];
}

/** A cell holds inline formatting only (MANUAL §6), so its blocks are flattened. */
function cellContent(content: readonly StructuralElement[], context: Context): PhrasingContent[] {
  return convertContent(content, context).flatMap((node) =>
    node.type === 'paragraph' ? node.children : [],
  );
}

/** The placeholder for a block the dialect cannot express (MANUAL §6). */
function blockPlaceholder(
  context: Context,
  startIndex: number | undefined,
  type: string,
): RootContent {
  // A Docs structural element has no id of its own, so it is addressed by the
  // document it is in and the index it starts at.
  const at = `${context.doc.documentId ?? ''}#${startIndex ?? ''}`;
  return { type: 'html', value: `<!-- docsync:block gdocs:${at} type=${type} -->` };
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
function listsFrom(items: readonly FlatItem[], start: number): [RootContent[], number] {
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
        const [nested, next] = listsFrom(items, index);
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
      list.children.push(node);
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
  if (element.textRun !== undefined)
    return annotate(element.textRun.content ?? '', element.textRun.textStyle ?? {});
  if (element.footnoteReference !== undefined) return [footnote(element, context)];
  if (element.inlineObjectElement !== undefined) return [inlineObject(element, context)];
  // A rule is emitted as a block by `paragraph`; a page break splits it.
  if (element.horizontalRule !== undefined || element.pageBreak !== undefined) return [];
  return [
    objectPlaceholder(
      `${context.doc.documentId ?? ''}#${element.startIndex ?? ''}`,
      kindOfUnknown(element),
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
 * An image is a placeholder carrying its object id until ticket 14 downloads
 * it (MANUAL §6). It stays inline, so an image in the middle of a sentence
 * does not cut the sentence in two.
 */
function inlineObject(element: ParagraphElement, context: Context): PhrasingContent {
  const id = element.inlineObjectElement?.inlineObjectId ?? '';
  const embedded = context.doc.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject;
  let type = 'object';
  if (embedded?.imageProperties !== undefined) type = 'image';
  else if (embedded?.embeddedDrawingProperties !== undefined) type = 'drawing';
  return objectPlaceholder(id, type);
}

function objectPlaceholder(id: string, type: string): PhrasingContent {
  return { type: 'html', value: `<!-- docsync:object gdocs:${id} type=${type} -->` };
}

/** `[^n]`, with the definition collected for the end of the document. */
function footnote(element: ParagraphElement, context: Context): PhrasingContent {
  const reference = element.footnoteReference ?? {};
  const identifier = reference.footnoteNumber ?? String(context.footnotes.length + 1);
  const body = context.doc.footnotes?.[reference.footnoteId ?? ''];
  if (body !== undefined && !context.seen.has(identifier)) {
    context.seen.add(identifier);
    context.footnotes.push({
      type: 'footnoteDefinition',
      identifier,
      label: identifier,
      // Docs writes the note with a leading space after the marker.
      children: trimLeading(convertContent(body.content ?? [], context)) as BlockContent[],
    });
  }
  return { type: 'footnoteReference', identifier, label: identifier };
}

/** Drops the space Docs puts between a footnote's number and its text. */
function trimLeading(nodes: RootContent[]): RootContent[] {
  const first = nodes[0];
  if (first?.type !== 'paragraph') return nodes;
  const head = first.children[0];
  if (head?.type === 'text') head.value = head.value.replace(/^\s+/, '');
  return nodes;
}

/**
 * One text run: its content, wrapped in its annotations from the inside out.
 * The order is fixed — code, underline, strikethrough, italic, bold, link — so
 * that the same styling always produces the same Markdown.
 */
function annotate(content: string, style: TextStyle): PhrasingContent[] {
  if (content === '') return [];
  let nodes = textNodes(content, style);
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
function textNodes(content: string, style: TextStyle): PhrasingContent[] {
  const text = content.replace(/\n$/, '');
  const font = style.weightedFontFamily?.fontFamily?.toLowerCase() ?? '';
  if (CODE_FONT_SET.has(font)) return text === '' ? [] : [{ type: 'inlineCode', value: text }];

  return text
    .split(VERTICAL_TAB)
    .flatMap((line, index) =>
      index === 0
        ? [{ type: 'text' as const, value: line }]
        : [{ type: 'break' as const }, { type: 'text' as const, value: line }],
    );
}
