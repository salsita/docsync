/**
 * Canonical Markdown back into Notion blocks (MANUAL §6, §7).
 *
 * The exact inverse of `to-markdown.ts`, and the reason the round trip is a
 * real test rather than string juggling: both directions walk the *same* mdast
 * tree, produced by the one pipeline in `markdown.ts`. This module never looks
 * at Markdown text — `parseMarkdown` does that — and never talks to Notion.
 * It answers block payloads in the shape `api.ts` records, with children hung
 * off `children`; `write.ts` decides how those become API requests.
 *
 * Anything the dialect writes as a placeholder produces nothing: phase 1
 * write-back is a full replace, and a block the API cannot create is a block we
 * do not try to recreate (MANUAL §7).
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
import { extensionOf, MEDIA_EXTENSIONS, resolveAssetPath } from '../assets.js';
import { parseMarkdown } from '../markdown.js';
import { PushError } from '../push-types.js';
import type { RawObject } from './api.js';
import { bareId } from './to-markdown.js';

/**
 * One block as the API takes it, with its children hung off `children` rather
 * than nested inside the body. `write.ts` puts them where each request wants
 * them; keeping them out here is what lets the round-trip test compare this
 * against a recorded block tree field for field.
 */
export interface BlockInput extends RawObject {
  type: string;
  children?: BlockInput[];
}

/** One entry of a `rich_text` array, as the API takes it. */
export interface RichTextInput extends RawObject {
  type: 'text' | 'mention' | 'equation';
  annotations: Annotations;
}

interface Annotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

export interface FromMarkdownOptions {
  /**
   * Undashed page id by repo-relative path: the inverse of the map
   * `to-markdown.ts` takes. A `[Title](relative/path.md)` link whose target is
   * in here becomes a page mention; one whose target is not stays a link.
   */
  ids?: ReadonlyMap<string, string>;
  /** Repo-relative path of the file being converted, for those relative links. */
  from?: string;
  /**
   * The file upload each asset was sent to Notion as, by repo-relative path
   * (MANUAL §12 phase 2). A link into `<title>.assets/` becomes an image, file,
   * PDF or video block pointing at the upload; one whose file the push did not
   * upload is refused, since a block cannot point at a path.
   */
  uploads?: ReadonlyMap<string, string>;
  /**
   * Asset paths this push would not upload — over the source's limit, or
   * refused by it. A link to one produces no block at all: the file was
   * reported and skipped, never half-written (MANUAL §12 phase 2).
   */
  skippedAssets?: ReadonlySet<string>;
}

const DEFAULT_COLOR = 'default';

const NO_ANNOTATIONS: Annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: DEFAULT_COLOR,
};

/** Block types whose Notion body carries a `color`. */
const COLORED = new Set([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'quote',
  'callout',
  'toggle',
]);

/** Markdown text to Notion blocks. */
export function markdownToBlocks(text: string, options: FromMarkdownOptions = {}): BlockInput[] {
  return mdastToBlocks(parseMarkdown(text), options);
}

/** mdast to Notion blocks, for callers that already have the tree. */
export function mdastToBlocks(tree: Root, options: FromMarkdownOptions = {}): BlockInput[] {
  return convertBlocks(tree.children, options);
}

/** The attributes an `<!-- docsync: … -->` comment carries to the next block. */
interface Attributes {
  color?: string;
  headerRow?: boolean;
  headerColumn?: boolean;
}

const ATTRIBUTE_COMMENT = /^<!--\s*docsync:\s*(.*?)\s*-->$/;
const PLACEHOLDER_COMMENT = /^<!--\s*docsync:block\b/;
const DETAILS_OPEN = /^<details\b/;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
const HEADING_SUMMARY = /^(#{1,6})\s+([\s\S]*)$/;

/**
 * A run of sibling nodes. Attribute comments apply to the block after them,
 * and a `<details>` swallows everything up to its matching close, so this is a
 * cursor loop rather than a `flatMap`.
 */
function convertBlocks(nodes: readonly RootContent[], options: FromMarkdownOptions): BlockInput[] {
  const out: BlockInput[] = [];
  let attributes: Attributes = {};
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    index += 1;
    if (!node) continue;

    if (node.type === 'html') {
      const value = node.value.trim();
      if (PLACEHOLDER_COMMENT.test(value)) {
        // A placeholder is an id, not content: it produces nothing (MANUAL §7).
        attributes = {};
        continue;
      }
      const comment = ATTRIBUTE_COMMENT.exec(value);
      if (comment?.[1] !== undefined) {
        attributes = readAttributes(comment[1]);
        continue;
      }
      if (DETAILS_OPEN.test(value)) {
        const end = closingDetails(nodes, index - 1);
        out.push(details(node.value, nodes.slice(index, end), attributes, options));
        attributes = {};
        index = end + 1;
        continue;
      }
      // A stray `</details>` or any HTML we do not write ourselves.
      continue;
    }

    const blocks = convertBlock(node, attributes, options);
    attributes = {};
    out.push(...blocks);
  }

  return out;
}

/** `color=green header-row=false`, lenient about keys it does not know. */
function readAttributes(body: string): Attributes {
  const attributes: Attributes = {};
  for (const pair of body.split(/\s+/)) {
    const cut = pair.indexOf('=');
    if (cut < 1) continue;
    const key = pair.slice(0, cut);
    const value = pair.slice(cut + 1);
    if (key === 'color') attributes.color = value;
    else if (key === 'header-row') attributes.headerRow = value === 'true';
    else if (key === 'header-column') attributes.headerColumn = value === 'true';
  }
  return attributes;
}

/** The index of the `</details>` that closes the `<details>` at `start`. */
function closingDetails(nodes: readonly RootContent[], start: number): number {
  let depth = 0;
  for (let index = start; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.type !== 'html') continue;
    depth += count(node.value, /<details\b/g) - count(node.value, /<\/details>/g);
    if (depth <= 0) return index;
  }
  // An unclosed toggle takes the rest of the document, which is what a reader
  // of the Markdown would expect it to mean.
  return nodes.length;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** `<details><summary>…</summary>` is a toggle, or a toggle heading (MANUAL §6). */
function details(
  open: string,
  inside: readonly RootContent[],
  attributes: Attributes,
  options: FromMarkdownOptions,
): BlockInput {
  const summary = SUMMARY.exec(open)?.[1]?.trim() ?? '';
  const children = convertBlocks(inside, options);
  const heading = HEADING_SUMMARY.exec(summary);

  if (heading?.[1] !== undefined && heading[2] !== undefined) {
    const depth = heading[1].length;
    if (depth > 3) throw tooDeep(depth, options, undefined);
    const type = `heading_${depth}`;
    return withChildren(
      body(type, { rich_text: summaryText(heading[2], options), is_toggleable: true }, attributes),
      children,
    );
  }

  return withChildren(
    body('toggle', { rich_text: summaryText(summary, options) }, attributes),
    children,
  );
}

/** The inline Markdown inside a `<summary>`, as rich text. */
function summaryText(text: string, options: FromMarkdownOptions): RichTextInput[] {
  const first = parseMarkdown(text).children[0];
  if (first?.type !== 'paragraph' && first?.type !== 'heading') return [];
  return inline(first.children, options);
}

function convertBlock(
  node: RootContent,
  attributes: Attributes,
  options: FromMarkdownOptions,
): BlockInput[] {
  switch (node.type) {
    case 'paragraph':
      return toList(paragraph(node, attributes, options));
    case 'heading':
      return [headingBlock(node, attributes, options)];
    case 'list':
      return listItems(node, attributes, options);
    case 'blockquote':
      return [quoteOrCallout(node, attributes, options)];
    case 'code':
      return [codeBlock(node)];
    case 'thematicBreak':
      return [{ type: 'divider', divider: {} }];
    case 'table':
      return [tableBlock(node, attributes, options)];
    case 'math':
      return [{ type: 'equation', equation: { expression: node.value } }];
    default:
      // Frontmatter, link definitions, footnotes: nothing Notion holds.
      return [];
  }
}

/** The body of a block, with its colour when the type carries one. */
function body(type: string, fields: RawObject, attributes: Attributes): BlockInput {
  const color = COLORED.has(type) ? { color: attributes.color ?? DEFAULT_COLOR } : {};
  return { type, [type]: { ...fields, ...color } };
}

/**
 * A paragraph, unless it is one of the two shapes that mean a media block.
 *
 * A paragraph holding **only** an image is an `image` block, and a paragraph
 * holding **only** a link with an absolute URL that is not a mention is a
 * `file` block (MANUAL §6: "On push a bare link block becomes a `file`
 * block"). Everything else — a link with text around it, a relative link, a
 * mention — is an ordinary paragraph, so a sentence that happens to be one
 * link keeps being a sentence.
 */
function paragraph(
  node: Paragraph,
  attributes: Attributes,
  options: FromMarkdownOptions,
): BlockInput | undefined {
  const only = node.children.length === 1 ? node.children[0] : undefined;

  if (only?.type === 'image') {
    const asset = assetBlock(only.url, 'image', captionOf(only.alt), options);
    if (asset !== undefined) return asset;
    if (resolveAssetPath(options.from ?? '', only.url) !== undefined) return undefined;
    return {
      type: 'image',
      image: {
        type: 'external',
        external: { url: only.url },
        caption: only.alt ? [textRun(only.alt, NO_ANNOTATIONS)] : [],
      },
    };
  }
  if (only?.type === 'link' && mention(only.url, options) === undefined) {
    const caption = inline(only.children, options);
    const asset = assetBlock(only.url, undefined, caption, options);
    if (asset !== undefined) return asset;
    if (resolveAssetPath(options.from ?? '', only.url) !== undefined) return undefined;
    if (isAbsolute(only.url)) {
      return {
        type: 'file',
        file: { type: 'external', external: { url: only.url }, caption },
      };
    }
  }

  return body('paragraph', { rich_text: inline(node.children, options) }, attributes);
}

/** A block, or nothing at all when the push had nothing to write. */
function toList(block: BlockInput | undefined): BlockInput[] {
  return block === undefined ? [] : [block];
}

/** An alt text as the caption Notion keeps for a media block. */
function captionOf(alt: string | null | undefined): RichTextInput[] {
  return alt ? [textRun(alt, NO_ANNOTATIONS)] : [];
}

/**
 * A link into the document's own `<title>.assets/` as the block that carries
 * the file (MANUAL §12 phase 2).
 *
 * `force` is the block type an `![]()` link takes whatever the extension says;
 * a `[]()` link is a PDF, a video or a plain file, by its extension. A link
 * into the assets directory whose file the push did not upload is refused by
 * name: there is nothing to point the block at.
 */
function assetBlock(
  url: string,
  force: string | undefined,
  caption: RichTextInput[],
  options: FromMarkdownOptions,
): BlockInput | undefined {
  const path = resolveAssetPath(options.from ?? '', url);
  if (path === undefined) return undefined;
  const upload = options.uploads?.get(path);
  if (upload === undefined) {
    // Reported and skipped: the file is named in the push report and the block
    // is simply not written (MANUAL §12 phase 2).
    if (options.skippedAssets?.has(path) === true) return undefined;
    throw new PushError(
      `${path}: this link points at a file that is not in the checkout; add the file or remove the link`,
      options.from,
    );
  }
  const ext = extensionOf(path).toLowerCase();
  const type =
    force ??
    (MEDIA_EXTENSIONS.pdf.has(ext) ? 'pdf' : MEDIA_EXTENSIONS.video.has(ext) ? 'video' : 'file');
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    type,
    [type]: {
      type: 'file_upload',
      file_upload: { id: upload },
      caption,
      ...(type === 'image' ? {} : { name }),
    },
  };
}

/** A URL with a scheme, which is what makes a link a link and not a path. */
function isAbsolute(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function headingBlock(
  node: Heading,
  attributes: Attributes,
  options: FromMarkdownOptions,
): BlockInput {
  if (node.depth > 3) throw tooDeep(node.depth, options, node.position?.start.line);
  const type = `heading_${node.depth}`;
  return body(
    type,
    { rich_text: inline(node.children, options), is_toggleable: false },
    attributes,
  );
}

/** Notion has three heading levels; clamping a fourth would not round-trip. */
function tooDeep(depth: number, options: FromMarkdownOptions, line: number | undefined): PushError {
  return new PushError(
    `Notion has only three heading levels; this file uses ${'#'.repeat(depth)}`,
    options.from,
    line,
  );
}

/** A list becomes one block per item; the run is not a block of its own. */
function listItems(node: List, attributes: Attributes, options: FromMarkdownOptions): BlockInput[] {
  return node.children.map((item) => listItem(item, node.ordered === true, attributes, options));
}

function listItem(
  item: ListItem,
  ordered: boolean,
  attributes: Attributes,
  options: FromMarkdownOptions,
): BlockInput {
  const [first, ...rest] = item.children;
  const lead = first?.type === 'paragraph' ? first : undefined;
  const richText = lead ? inline(lead.children, options) : [];
  const children = convertBlocks(lead ? rest : item.children, options);

  const checked = item.checked;
  const type = ordered
    ? 'numbered_list_item'
    : typeof checked === 'boolean'
      ? 'to_do'
      : 'bulleted_list_item';
  const fields: RawObject = { rich_text: richText };
  if (type === 'to_do') fields.checked = checked === true;

  return { ...body(type, fields, attributes), ...(children.length > 0 ? { children } : {}) };
}

/**
 * `[!CALLOUT]` and the emoji after it, up to the end of the line. The escaped
 * spelling `\[!CALLOUT]` parses to the same text, so one pattern covers both
 * (MANUAL §6); the line ends either at a hard break, which is what we write,
 * or at a plain newline, which is what an editor that dropped the two trailing
 * spaces leaves behind.
 */
const CALLOUT_MARKER = /^\[!CALLOUT\][ \t]*(\S*)[ \t]*(\n|$)/;

/**
 * A blockquote is a quote, or a callout when its first line is the callout
 * marker (MANUAL §6). The emoji after the marker is the callout's icon; the
 * rest of the first paragraph, after the line break, is its own text.
 */
function quoteOrCallout(
  node: Blockquote,
  attributes: Attributes,
  options: FromMarkdownOptions,
): BlockInput {
  const [first, ...rest] = node.children;
  const lead = first?.type === 'paragraph' ? first : undefined;
  const marker = lead ? calloutMarker(lead.children) : undefined;

  if (lead && marker) {
    const icon = marker.emoji === '' ? {} : { icon: { type: 'emoji', emoji: marker.emoji } };
    const block = body('callout', { rich_text: inline(marker.rest, options), ...icon }, attributes);
    return withChildren(block, convertBlocks(rest, options));
  }

  const richText = lead ? inline(lead.children, options) : [];
  const block = body('quote', { rich_text: richText }, attributes);
  return withChildren(block, convertBlocks(lead ? rest : node.children, options));
}

function withChildren(block: BlockInput, children: BlockInput[]): BlockInput {
  return children.length > 0 ? { ...block, children } : block;
}

/** The marker at the head of a callout's first paragraph, if it is one. */
function calloutMarker(
  children: readonly PhrasingContent[],
): { emoji: string; rest: PhrasingContent[] } | undefined {
  const first = children[0];
  if (first?.type !== 'text') return undefined;
  const found = CALLOUT_MARKER.exec(first.value);
  if (!found) return undefined;

  // Whatever is left of the first text node after the marker's line, then the
  // rest of the paragraph — minus the hard break the marker is followed by.
  const tail = first.value.slice(found[0].length);
  const after = children.slice(tail === '' && children[1]?.type === 'break' ? 2 : 1);
  const rest: PhrasingContent[] = tail === '' ? after : [{ type: 'text', value: tail }, ...after];
  return { emoji: found[1] ?? '', rest };
}

/**
 * A fence. No language means Notion's `plain text` (ticket 05); a fence whose
 * info line carries meta puts it back together, since that is what the
 * language was called on the way out.
 */
function codeBlock(node: Code): BlockInput {
  const language = node.lang === null || node.lang === undefined ? 'plain text' : node.lang;
  const meta = node.meta ? ` ${node.meta}` : '';
  return {
    type: 'code',
    code: {
      rich_text: node.value === '' ? [] : [textRun(node.value, NO_ANNOTATIONS)],
      language: `${language}${meta}`,
      caption: [],
    },
  };
}

/**
 * A GFM table. Every row is a Notion row — GFM's header row included, since
 * Notion's header is a flag on the table and not a different kind of row. The
 * flag's default is the opposite of the attribute comment's absence, which is
 * why `header-row=false` is what gets written down (MANUAL §6).
 */
function tableBlock(node: Table, attributes: Attributes, options: FromMarkdownOptions): BlockInput {
  const width = Math.max(0, ...node.children.map((row) => row.children.length));
  const rows: BlockInput[] = node.children.map((row) => ({
    type: 'table_row',
    table_row: {
      cells: Array.from({ length: width }, (_unused, column) =>
        inline(row.children[column]?.children ?? [], options),
      ),
    },
  }));

  return {
    type: 'table',
    table: {
      table_width: width,
      has_column_header: attributes.headerRow ?? true,
      has_row_header: attributes.headerColumn ?? false,
    },
    children: rows,
  };
}

/* ------------------------------------------------------------------ inline */

/** Phrasing content to a Notion `rich_text` array. */
export function inline(
  nodes: readonly PhrasingContent[],
  options: FromMarkdownOptions = {},
): RichTextInput[] {
  const runs: RichTextInput[] = [];
  walkInline(nodes, NO_ANNOTATIONS, undefined, runs, options);
  return merge(runs);
}

/**
 * Walks phrasing content, carrying the annotations in force.
 *
 * `<u>` and `<span data-color="…">` are HTML nodes rather than mdast marks, so
 * they are handled as a stack over the sibling list instead of by recursion.
 */
function walkInline(
  nodes: readonly PhrasingContent[],
  annotations: Annotations,
  link: string | undefined,
  out: RichTextInput[],
  options: FromMarkdownOptions,
): void {
  let current = annotations;
  const stack: Annotations[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(textRun(node.value, current, link));
        break;
      case 'inlineCode':
        out.push(textRun(node.value, { ...current, code: true }, link));
        break;
      case 'break':
        // A line break inside one block is a newline in one run (MANUAL §6).
        out.push(textRun('\n', current, link));
        break;
      case 'strong':
        walkInline(node.children, { ...current, bold: true }, link, out, options);
        break;
      case 'emphasis':
        walkInline(node.children, { ...current, italic: true }, link, out, options);
        break;
      case 'delete':
        walkInline(node.children, { ...current, strikethrough: true }, link, out, options);
        break;
      case 'inlineMath':
        out.push({
          type: 'equation',
          equation: { expression: node.value },
          annotations: current,
          plain_text: node.value,
          href: null,
        });
        break;
      case 'link': {
        const found = mention(node.url, options);
        if (found) out.push({ ...found, annotations: current, plain_text: label(node.children) });
        else walkInline(node.children, current, node.url, out, options);
        break;
      }
      case 'image':
        // Notion has no inline image; the alt text keeps the link visible.
        out.push(textRun(node.alt ?? node.url, current, node.url));
        break;
      case 'html': {
        const opened = openTag(node.value, current);
        if (opened) {
          stack.push(current);
          current = opened;
        } else if (/^<\/(u|span)>$/.test(node.value.trim())) {
          current = stack.pop() ?? annotations;
        }
        break;
      }
      default:
        // Footnote references and anything remark adds later.
        break;
    }
  }
}

const COLOR_SPAN = /^<span\s+data-color="([^"]*)"\s*>$/;

/** The annotations an opening `<u>` or `<span data-color>` turns on. */
function openTag(value: string, current: Annotations): Annotations | undefined {
  const tag = value.trim();
  if (tag === '<u>') return { ...current, underline: true };
  const color = COLOR_SPAN.exec(tag);
  return color?.[1] === undefined ? undefined : { ...current, color: color[1] };
}

/**
 * One text run. `plain_text` and `href` are what Notion *computes* for a run,
 * and a create request may not carry them — `write.ts` strips them — but they
 * are what `to-markdown.ts` reads, so writing them here is what makes a block
 * this module produced convertible without a trip through Notion. That is the
 * round trip in `round-trip.test.ts`.
 */
function textRun(content: string, annotations: Annotations, link?: string): RichTextInput {
  return {
    type: 'text',
    text: { content, link: link === undefined ? null : { url: link } },
    annotations,
    plain_text: content,
    href: link ?? null,
  };
}

/**
 * Adjacent text runs that agree on everything are one run. Markdown splits
 * text at escapes, entities and hard breaks; Notion does not, and the fixture
 * tree shows a multi-line paragraph as a single run with a newline in it.
 */
function merge(runs: readonly RichTextInput[]): RichTextInput[] {
  const out: RichTextInput[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.type === 'text' &&
      run.type === 'text' &&
      sameLink(last, run) &&
      same(last.annotations, run.annotations)
    ) {
      const text = last.text as { content: string };
      const joined = text.content + content(run);
      out[out.length - 1] = {
        ...last,
        text: { ...text, content: joined },
        plain_text: joined,
      };
      continue;
    }
    out.push(run);
  }
  return out;
}

function content(run: RichTextInput): string {
  return (run.text as { content: string }).content;
}

function sameLink(a: RichTextInput, b: RichTextInput): boolean {
  const url = (run: RichTextInput) => (run.text as { link: { url: string } | null }).link?.url;
  return url(a) === url(b);
}

function same(a: Annotations, b: Annotations): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.underline === b.underline &&
    a.code === b.code &&
    a.color === b.color
  );
}

/* ---------------------------------------------------------------- mentions */

const USER_URL = /^notion:\/\/user\/(.+)$/;
const DATE_URL = /^notion:\/\/date\/(.+)$/;
const PAGE_URL = /^https:\/\/(?:www\.notion\.so|app\.notion\.com)\/(?:.*-)?([0-9a-f-]{32,36})$/i;

/** The visible text of a link, which is the label Notion shows for a mention. */
function label(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node) =>
      node.type === 'text' || node.type === 'inlineCode'
        ? node.value
        : 'children' in node
          ? label(node.children)
          : '',
    )
    .join('');
}

/** The mention a link URL stands for, if it stands for one (MANUAL §6). */
function mention(
  url: string,
  options: FromMarkdownOptions,
): { type: 'mention'; mention: RawObject; href: null } | undefined {
  const user = USER_URL.exec(url);
  if (user?.[1] !== undefined) {
    return {
      type: 'mention',
      mention: { type: 'user', user: { object: 'user', id: user[1] } },
      href: null,
    };
  }

  const date = DATE_URL.exec(url);
  if (date?.[1] !== undefined) {
    const [start, end] = date[1].split('/');
    return {
      type: 'mention',
      mention: { type: 'date', date: { start: start ?? '', end: end ?? null } },
      href: null,
    };
  }

  const page = PAGE_URL.exec(url);
  if (page?.[1] !== undefined) {
    return {
      type: 'mention',
      mention: { type: 'page', page: { id: bareId(page[1]) } },
      href: null,
    };
  }

  if (!isAbsolute(url) && url.endsWith('.md')) {
    const id = options.ids?.get(resolvePath(options.from ?? '', url));
    if (id !== undefined) {
      return { type: 'mention', mention: { type: 'page', page: { id: bareId(id) } }, href: null };
    }
  }

  return undefined;
}

/**
 * A link relative to the file it sits in, resolved to a repo-relative path.
 * The inverse of `relativePath` in `to-markdown.ts`; both are `/`-separated.
 */
export function resolvePath(from: string, relative: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const segment of relative.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

export { PushError } from '../push-types.js';
