/**
 * Notion blocks to canonical Markdown (MANUAL §6).
 *
 * Pure: it is handed the block tree `api.ts` recorded and a map of which pages
 * are in the checkout, and answers text. Everything it cannot express becomes a
 * placeholder carrying the block id, so that nothing is silently lost and
 * ticket 06 can put the block back where it found it.
 *
 * The output goes through the one pipeline in `markdown.ts`: this module builds
 * mdast and never concatenates Markdown by hand, which is what keeps escaping
 * correct and the round trip honest.
 */
import type {
  BlockContent,
  Heading,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
  TableRow,
} from 'mdast';
import { linkToAsset } from '../assets.js';
import { stringifyMarkdown } from '../markdown.js';
import type { NotionBlock, RawObject } from './api.js';

/** One entry of a Notion `rich_text` array. */
export interface RichText extends RawObject {
  type?: string;
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
}

export interface ToMarkdownOptions {
  /**
   * Repo-relative paths of the pages that are in the checkout, by undashed
   * page id. A mention of a page in here becomes a relative link; anything
   * else becomes a notion.so URL (MANUAL §6).
   */
  pages?: ReadonlyMap<string, string>;
  /** Repo-relative path of the file being written, for those relative links. */
  from?: string;
  /**
   * Where the files this page hosts were written, by undashed block id
   * (MANUAL §12 phase 2). A media block in here is linked into
   * `<title>.assets/`; one that is not — because nothing downloaded it — keeps
   * the placeholder it had.
   */
  assets?: ReadonlyMap<string, string>;
}

/** Notion's default colour, which is the one we do not write down. */
const DEFAULT_COLOR = 'default';

/** Block types that are documents of their own and never appear in a body. */
const OWN_FILE = new Set(['child_page', 'child_database']);

/** The three list types, grouped into runs before conversion. */
const BULLETS = new Set(['bulleted_list_item', 'to_do']);

/** A page id as docsync writes it: 32 hex digits, no dashes. */
export function bareId(id: string): string {
  return id.replaceAll('-', '').toLowerCase();
}

/** Block tree to canonical Markdown text. */
export function blocksToMarkdown(
  blocks: readonly NotionBlock[],
  options: ToMarkdownOptions = {},
): string {
  return stringifyMarkdown(blocksToMdast(blocks, options));
}

/** Block tree to mdast, for callers that want the tree (the round-trip test). */
export function blocksToMdast(
  blocks: readonly NotionBlock[],
  options: ToMarkdownOptions = {},
): Root {
  return { type: 'root', children: convertBlocks(blocks, options) };
}

/** The body of a block: `block[block.type]`, whatever shape it has. */
function bodyOf(block: NotionBlock): RawObject {
  const body = block[block.type];
  return typeof body === 'object' && body !== null ? (body as RawObject) : {};
}

function richTextOf(block: NotionBlock): RichText[] {
  const value = bodyOf(block).rich_text;
  return Array.isArray(value) ? (value as RichText[]) : [];
}

function childrenOf(block: NotionBlock): NotionBlock[] {
  return block.children ?? [];
}

/** A run of sibling blocks, with list items grouped into lists. */
function convertBlocks(blocks: readonly NotionBlock[], options: ToMarkdownOptions): RootContent[] {
  const out: RootContent[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;
    if (OWN_FILE.has(block.type)) {
      index += 1;
      continue;
    }

    const ordered = block.type === 'numbered_list_item';
    if (ordered || BULLETS.has(block.type)) {
      const run: NotionBlock[] = [];
      while (index < blocks.length) {
        const next = blocks[index];
        if (!next) break;
        const sameKind = ordered ? next.type === 'numbered_list_item' : BULLETS.has(next.type);
        if (!sameKind) break;
        run.push(next);
        index += 1;
      }
      out.push({
        type: 'list',
        ordered,
        start: ordered ? 1 : null,
        spread: false,
        children: run.map((item) => ({
          type: 'listItem' as const,
          spread: false,
          checked: item.type === 'to_do' ? bodyOf(item).checked === true : null,
          children: [
            { type: 'paragraph' as const, children: inline(richTextOf(item), options) },
            ...convertBlocks(childrenOf(item), options),
          ] as BlockContent[],
        })),
      });
      continue;
    }

    out.push(...attributes(block), ...convertBlock(block, options));
    index += 1;
  }

  return out;
}

/**
 * The `<!-- docsync: … -->` line above a block, for what Notion stores and GFM
 * cannot (MANUAL §6). Only non-default values, so an ordinary document has
 * none of these.
 */
function attributes(block: NotionBlock): RootContent[] {
  const body = bodyOf(block);
  const pairs: string[] = [];

  const color = body.color;
  if (typeof color === 'string' && color !== DEFAULT_COLOR) pairs.push(`color=${color}`);
  if (block.type === 'table') {
    // GFM always renders a header row; Notion's default is not to have one.
    if (body.has_column_header !== true) pairs.push('header-row=false');
    if (body.has_row_header === true) pairs.push('header-column=true');
  }

  return pairs.length === 0
    ? []
    : [{ type: 'html', value: `<!-- docsync: ${pairs.join(' ')} -->` }];
}

/** The placeholder for a block the dialect cannot express (MANUAL §6). */
function placeholder(block: NotionBlock): RootContent[] {
  return [
    { type: 'html', value: `<!-- docsync:block notion:${bareId(block.id)} type=${block.type} -->` },
  ];
}

function convertBlock(block: NotionBlock, options: ToMarkdownOptions): RootContent[] {
  switch (block.type) {
    case 'paragraph':
      return [paragraph(block, options), ...convertBlocks(childrenOf(block), options)];

    case 'heading_1':
    case 'heading_2':
    case 'heading_3':
      return heading(block, options);

    case 'quote':
      return [
        {
          type: 'blockquote',
          children: [
            paragraph(block, options),
            ...(convertBlocks(childrenOf(block), options) as BlockContent[]),
          ],
        },
      ];

    case 'callout':
      return callout(block, options);

    case 'toggle':
      return details(inlineText(richTextOf(block), options), childrenOf(block), options);

    case 'code':
      return code(block);

    case 'divider':
      return [{ type: 'thematicBreak' }];

    case 'table':
      return table(block, options);

    case 'equation':
      return [{ type: 'math', value: String(bodyOf(block).expression ?? '') }];

    case 'image':
    case 'file':
    case 'pdf':
    case 'video':
      return media(block, options);

    default:
      return placeholder(block);
  }
}

function paragraph(block: NotionBlock, options: ToMarkdownOptions): Paragraph {
  return { type: 'paragraph', children: inline(richTextOf(block), options) };
}

function heading(block: NotionBlock, options: ToMarkdownOptions): RootContent[] {
  const depth = Number(block.type.slice('heading_'.length)) as 1 | 2 | 3;
  const node: Heading = { type: 'heading', depth, children: inline(richTextOf(block), options) };
  if (bodyOf(block).is_toggleable !== true) {
    return [node, ...convertBlocks(childrenOf(block), options)];
  }
  // A toggle heading is a toggle whose summary is the heading (MANUAL §6).
  return details(
    `${'#'.repeat(depth)} ${inlineText(richTextOf(block), options)}`,
    childrenOf(block),
    options,
  );
}

/** `<details><summary>…</summary>` around converted children. */
function details(
  summary: string,
  children: readonly NotionBlock[],
  options: ToMarkdownOptions,
): RootContent[] {
  return [
    { type: 'html', value: `<details>\n<summary>${summary}</summary>` },
    ...convertBlocks(children, options),
    { type: 'html', value: '</details>' },
  ];
}

/**
 * `> [!CALLOUT] 💡` and the body under it. The marker is an HTML node rather
 * than text so that it survives stringification unescaped, which is what makes
 * the file read the way MANUAL §6 shows it.
 */
function callout(block: NotionBlock, options: ToMarkdownOptions): RootContent[] {
  const icon = bodyOf(block).icon;
  const emoji =
    typeof icon === 'object' && icon !== null && typeof (icon as RawObject).emoji === 'string'
      ? ` ${(icon as RawObject).emoji as string}`
      : '';
  const marker: PhrasingContent[] = [
    { type: 'html', value: `[!CALLOUT]${emoji}` },
    { type: 'break' },
  ];
  return [
    {
      type: 'blockquote',
      children: [
        { type: 'paragraph', children: [...marker, ...inline(richTextOf(block), options)] },
        ...(convertBlocks(childrenOf(block), options) as BlockContent[]),
      ],
    },
  ];
}

/**
 * A fenced block. Notion's `plain text` is a fence with no language, which is
 * canonical in both directions (ticket 05 decisions). A language that carries a
 * space is split into the fence's info word and its meta, so that the text
 * still says what Notion said.
 */
function code(block: NotionBlock): RootContent[] {
  const body = bodyOf(block);
  const language = typeof body.language === 'string' ? body.language : 'plain text';
  const value = plain(Array.isArray(body.rich_text) ? (body.rich_text as RichText[]) : []);
  if (language === 'plain text') return [{ type: 'code', lang: null, value }];
  const [first = language, ...rest] = language.split(' ');
  return [{ type: 'code', lang: first, meta: rest.length === 0 ? null : rest.join(' '), value }];
}

function table(block: NotionBlock, options: ToMarkdownOptions): RootContent[] {
  const width = Number(bodyOf(block).table_width ?? 0);
  const rows: TableRow[] = childrenOf(block)
    .filter((row) => row.type === 'table_row')
    .map((row) => {
      const cells = bodyOf(row).cells;
      const list = Array.isArray(cells) ? (cells as RichText[][]) : [];
      const children: TableCell[] = [];
      for (let column = 0; column < Math.max(width, list.length); column += 1) {
        children.push({ type: 'tableCell', children: inline(list[column] ?? [], options) });
      }
      return { type: 'tableRow', children };
    });
  // A Notion table with no rows at all cannot be written as GFM.
  if (rows.length === 0) return placeholder(block);
  return [{ type: 'table', align: [], children: rows }];
}

/**
 * An image, file, PDF or video (MANUAL §6).
 *
 * An external URL is written as it stands: an image when the block is an
 * image, a link otherwise, and nothing is downloaded. A file **Notion hosts**
 * is written the same way but pointing into `<title>.assets/`, where the fetch
 * put it (MANUAL §12 phase 2); its signed URL is never in the file, because it
 * expires within the hour. A hosted block nobody downloaded keeps the
 * placeholder, so a page is never written with a link to a file that is not
 * there.
 */
function media(block: NotionBlock, options: ToMarkdownOptions): RootContent[] {
  const body = bodyOf(block);
  const external = body.external;
  const asset = typeof block.id === 'string' ? options.assets?.get(bareId(block.id)) : undefined;
  const url =
    asset !== undefined
      ? linkToAsset(options.from ?? '', asset)
      : typeof external === 'object' && external !== null
        ? (external as RawObject).url
        : undefined;
  if (typeof url !== 'string') return placeholder(block);

  const caption = Array.isArray(body.caption) ? (body.caption as RichText[]) : [];
  const label = plain(caption) || (typeof body.name === 'string' ? body.name : block.type);
  if (block.type === 'image') {
    return [{ type: 'paragraph', children: [{ type: 'image', url, alt: label }] }];
  }
  // A file has a name and a caption; the link's text is the caption when there
  // is one, and the file's own name when there is not, so that a link never
  // comes out empty.
  const children =
    caption.length > 0 ? inline(caption, options) : [{ type: 'text' as const, value: label }];
  return [{ type: 'paragraph', children: [{ type: 'link', url, children }] }];
}

/** The plain text of a rich-text array, with no Markdown at all. */
export function plain(richText: readonly RichText[]): string {
  return richText.map((part) => part.plain_text ?? '').join('');
}

/** Inline Markdown for a rich-text array, as text (for a `<summary>`). */
function inlineText(richText: readonly RichText[], options: ToMarkdownOptions): string {
  return stringifyMarkdown({
    type: 'root',
    children: [{ type: 'paragraph', children: inline(richText, options) }],
  }).trim();
}

/** A rich-text array to mdast phrasing content. */
export function inline(
  richText: readonly RichText[],
  options: ToMarkdownOptions = {},
): PhrasingContent[] {
  return trimEdges(mergeRuns(richText).flatMap((part) => annotate(part, options)));
}

/**
 * A block's inline content, without the spaces at its very start and its very
 * end (MANUAL §6). A space there is invisible at the source, and the writer
 * has to encode it — `&#x20;SA: …`, `…(Contract.md)&#x20;` — so it is noise in
 * every diff of every document that has one.
 *
 * Spaces only, and only at the block's own two edges: a space beside a line
 * break inside the block is the block's text, and a space inside a link or a
 * `<span>` is that node's. The push-time comparison converts the live block
 * with this same code, so a trimmed base never reads as an edit, and
 * `mergeRichText` compares plain text, so the space at the source survives.
 */
function trimEdges(nodes: PhrasingContent[]): PhrasingContent[] {
  const out = [...nodes];
  const first = out[0];
  if (first?.type === 'text') out[0] = { ...first, value: first.value.replace(/^ +/, '') };
  const last = out.at(-1);
  if (last?.type === 'text')
    out[out.length - 1] = { ...last, value: last.value.replace(/ +$/, '') };
  return out;
}

/** The annotations that decide whether two runs are really one. */
const FLAGS = ['bold', 'italic', 'strikethrough', 'underline', 'code'] as const;

/** The link a run carries, from its own `text.link` or the `href` Notion adds. */
function linkOf(part: RichText): string | null {
  const body = part.text;
  const link = typeof body === 'object' && body !== null ? (body as RawObject).link : undefined;
  const url = typeof link === 'object' && link !== null ? (link as RawObject).url : undefined;
  if (typeof url === 'string') return url;
  return typeof part.href === 'string' ? part.href : null;
}

/** A text run: neither a mention nor an equation, which are atomic. */
function isText(part: RichText): boolean {
  const type = part.type ?? 'text';
  return type !== 'mention' && type !== 'equation';
}

/**
 * Two adjacent runs that agree on every annotation and on their link are one
 * run. Notion cuts a run wherever an edit or a comment started, and renders
 * the pieces as one; `**early****.**` is not what the dialect means by that,
 * so the runs are joined before anything is wrapped (MANUAL §6).
 */
function mergeRuns(richText: readonly RichText[]): RichText[] {
  const out: RichText[] = [];
  for (const part of richText) {
    const last = out.at(-1);
    if (last !== undefined && mergeable(last, part)) {
      const content = (last.plain_text ?? '') + (part.plain_text ?? '');
      const body = last.text;
      out[out.length - 1] = {
        ...last,
        plain_text: content,
        ...(typeof body === 'object' && body !== null
          ? { text: { ...(body as RawObject), content } }
          : {}),
      };
      continue;
    }
    out.push(part);
  }
  return out;
}

function mergeable(a: RichText, b: RichText): boolean {
  if (!isText(a) || !isText(b)) return false;
  if (linkOf(a) !== linkOf(b)) return false;
  const one = a.annotations ?? {};
  const two = b.annotations ?? {};
  if (!FLAGS.every((flag) => (one[flag] === true) === (two[flag] === true))) return false;
  return (one.color ?? DEFAULT_COLOR) === (two.color ?? DEFAULT_COLOR);
}

/**
 * One rich-text run: its content, wrapped in its annotations from the inside
 * out. The order is fixed — colour, underline, strikethrough, italic, bold,
 * link — so that the same annotations always produce the same Markdown.
 *
 * Notion styles a space as readily as a letter, and shows a bold space as
 * nothing at all, while Markdown cannot open emphasis on a space: the run
 * would print as `**Send the&#x20;**`. So a run whose emphasis would wrap a
 * space at either edge sheds those spaces, and wraps what is left — possibly
 * nothing, which gets nothing. `<u>` and `<span>` hold a space perfectly
 * well, so they stay around all of the pieces, and so does the link. This is
 * the rule the Docs converter got in `0137c02`.
 */
function annotate(part: RichText, options: ToMarkdownOptions): PhrasingContent[] {
  const annotations = part.annotations ?? {};

  const html = (nodes: PhrasingContent[]): PhrasingContent[] => {
    let out = nodes;
    const color = annotations.color;
    if (typeof color === 'string' && color !== DEFAULT_COLOR) {
      out = wrapHtml(out, `<span data-color="${color}">`, '</span>');
    }
    return annotations.underline ? wrapHtml(out, '<u>', '</u>') : out;
  };
  const emphasis = (nodes: PhrasingContent[]): PhrasingContent[] => {
    let out = nodes;
    if (annotations.strikethrough) out = [{ type: 'delete', children: out }];
    if (annotations.italic) out = [{ type: 'emphasis', children: out }];
    if (annotations.bold) out = [{ type: 'strong', children: out }];
    return out;
  };
  // A link on a mention is already part of the mention's own node.
  const href = part.type === 'mention' ? undefined : (part.href ?? undefined);
  const link = (nodes: PhrasingContent[]): PhrasingContent[] =>
    typeof href === 'string' && nodes.length > 0
      ? [{ type: 'link', url: href, children: nodes }]
      : nodes;

  const wraps =
    annotations.bold === true || annotations.italic === true || annotations.strikethrough === true;
  // The spaces inside a code run are its content, not its edges.
  if (wraps && annotations.code !== true && isText(part)) {
    const content = part.plain_text ?? '';
    // A run of nothing but spaces and newlines has nothing to wrap: a bold
    // newline is not a thing, and `**\n**` is not Markdown anybody wrote. It
    // goes out whole and unstyled, the way the shed rule sends out a space,
    // and its newlines are line breaks like any other (MANUAL §6).
    if (content !== '' && /^[ \n]+$/.test(content)) return link(html(textNodes(content)));
    const lead = /^ +/.exec(content)?.[0] ?? '';
    const trail = content.length > lead.length ? (/ +$/.exec(content)?.[0] ?? '') : '';
    if (lead !== '' || trail !== '' || content === '') {
      const core = content.slice(lead.length, content.length - trail.length);
      const piece = (value: string, styled: boolean): PhrasingContent[] => {
        if (value === '') return [];
        const nodes = html(textNodes(value));
        return styled ? emphasis(nodes) : nodes;
      };
      return link([...piece(lead, false), ...piece(core, true), ...piece(trail, false)]);
    }
  }

  return link(emphasis(html(base(part, options))));
}

function wrapHtml(nodes: PhrasingContent[], open: string, close: string): PhrasingContent[] {
  return [{ type: 'html', value: open }, ...nodes, { type: 'html', value: close }];
}

/** The content of one rich-text run, before annotations. */
function base(part: RichText, options: ToMarkdownOptions): PhrasingContent[] {
  if (part.type === 'equation') {
    const equation = part.equation;
    const expression =
      typeof equation === 'object' && equation !== null
        ? String((equation as RawObject).expression ?? '')
        : '';
    return [{ type: 'inlineMath', value: expression }];
  }
  if (part.type === 'mention') return mention(part, options);

  const text = part.plain_text ?? '';
  if (part.annotations?.code) return [{ type: 'inlineCode', value: text }];
  return textNodes(text);
}

/**
 * Plain text as mdast. A line break inside one block is two trailing spaces
 * (MANUAL §6), which is what a `break` node prints under our stringifier
 * options.
 */
function textNodes(text: string): PhrasingContent[] {
  return text
    .split('\n')
    .flatMap((line, index) =>
      index === 0
        ? [{ type: 'text' as const, value: line }]
        : [{ type: 'break' as const }, { type: 'text' as const, value: line }],
    );
}

/**
 * What a rich-text part reads as in the Markdown: its plain text, except for a
 * page mention the API labelled "Untitled", which it does for a page inside a
 * table cell whatever the page is called, and for a page the integration
 * cannot see. A page in the checkout is then named after its file, which came
 * from its title; one outside it says `{page title}`, plainly, rather than
 * pretend the page has none (MANUAL §6). The comment sidecar searches the body
 * with this same text, and the push-time comparison runs the same rule on the
 * live page, so all three agree.
 */
export function labelOf(part: RichText, options: ToMarkdownOptions = {}): string {
  const label = part.plain_text ?? '';
  if (part.type !== 'mention' || (label !== '' && label !== 'Untitled')) return label;
  const raw = part.mention;
  const body = typeof raw === 'object' && raw !== null ? (raw as RawObject) : {};
  if (body.type !== 'page') return label;
  const target = body.page;
  const id =
    typeof target === 'object' && target !== null ? String((target as RawObject).id ?? '') : '';
  const path = options.pages?.get(bareId(id));
  return path === undefined ? '{page title}' : stemOf(path);
}

/** A mention, as the table in MANUAL §6 spells it. */
function mention(part: RichText, options: ToMarkdownOptions): PhrasingContent[] {
  const raw = part.mention;
  const body = typeof raw === 'object' && raw !== null ? (raw as RawObject) : {};
  const kind = typeof body.type === 'string' ? body.type : '';
  const label = labelOf(part, options);
  const link = (url: string): PhrasingContent[] => [
    { type: 'link', url, children: [{ type: 'text', value: label }] },
  ];

  if (kind === 'page' || kind === 'database' || kind === 'data_source') {
    const target = body[kind];
    const id =
      typeof target === 'object' && target !== null ? String((target as RawObject).id ?? '') : '';
    const path = kind === 'page' ? pathTo(id, options) : undefined;
    return link(path ?? `https://www.notion.so/${bareId(id)}`);
  }
  if (kind === 'user') {
    const user = body.user;
    const id =
      typeof user === 'object' && user !== null ? String((user as RawObject).id ?? '') : '';
    return link(`notion://user/${bareId(id)}`);
  }
  if (kind === 'date') {
    const date = body.date;
    const value = typeof date === 'object' && date !== null ? (date as RawObject) : {};
    const start = String(value.start ?? '');
    const end = typeof value.end === 'string' ? `/${value.end}` : '';
    return link(`notion://date/${start}${end}`);
  }

  // Link previews, template mentions and anything Notion adds later: a plain
  // link when there is a URL, and the text alone when there is not.
  const href = part.href;
  return typeof href === 'string' && href !== '' ? link(href) : [{ type: 'text', value: label }];
}

/** The relative link to a page in the checkout, if it is in the checkout. */
/** The file name of a page's path without its extension: `Specs/Auth.md` → `Auth`. */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function pathTo(id: string, options: ToMarkdownOptions): string | undefined {
  const target = options.pages?.get(bareId(id));
  if (target === undefined) return undefined;
  return relativePath(options.from ?? '', target);
}

/**
 * A repo-relative path rewritten relative to the file it is linked from. Both
 * arguments are `/`-separated and repo-relative; `from` is a file, so its last
 * segment is dropped. A link that would have no `../` prefix keeps `./`-free
 * form, the way a person would write it.
 */
export function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length - 1 &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }
  const up = Array.from({ length: fromParts.length - shared }, () => '..');
  return [...up, ...toParts.slice(shared)].join('/');
}
