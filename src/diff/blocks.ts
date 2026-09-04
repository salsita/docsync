/**
 * What changed between two versions of a document, block by block.
 *
 * `git diff` over blocks, and nothing more clever than that: a longest common
 * subsequence over the top-level blocks with a block's canonical Markdown as
 * its identity, then, inside each stretch of change, a removed and an inserted
 * block of the same type whose text is at least half the same pair up as an
 * **update** — git's rename measure, applied to paragraphs. A removed block
 * that turns up unchanged elsewhere is a **move**. Everything left is a
 * deletion or an insertion (MANUAL §7).
 *
 * Pure and source-agnostic, over the mdast of the dialect (MANUAL §6): the
 * Notion adapter and the Google Docs one both patch their live document from
 * these ops, and neither source is named here. What makes that work is
 * `flattenBlocks`, which turns the mdast into the *blocks a source holds* —
 * one per list item rather than one per list, a toggle's body and a table's
 * rows hanging off their parent — so that the ops line up with the live
 * document block for block.
 */
import type {
  Blockquote,
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
} from 'mdast';
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import { similarity } from './similarity.js';
import { OBJECT_REPLACEMENT } from './text.js';

/** One block of a document, as both sources hold blocks. */
export interface DiffBlock {
  /**
   * The dialect's type, fine enough that two blocks of the same type can be
   * patched into one another: `paragraph`, `heading:2`, `listItem:todo`,
   * `quote`, `callout`, `toggle`, `toggleHeading:1`, `code`, `divider`,
   * `table`, `tableRow`, `equation`, `image`, `file`, `placeholder:embed`.
   */
  type: string;
  /**
   * The block's own canonical Markdown, children excluded, attribute comment
   * included. Its identity: two blocks with the same one are the same block.
   */
  markdown: string;
  /** The block's own plain text, for the similarity measure and the text diff. */
  text: string;
  /** The block's own inline content, for `diffInline`. Absent for a table. */
  inline?: PhrasingContent[];
  /** A table row's cells, each its own inline content. */
  cells?: PhrasingContent[][];
  /** The whole block as mdast, children included: what an insertion converts. */
  source: RootContent[];
  children: DiffBlock[];
  /** Position among its siblings. */
  index: number;
}

/** What the diff says to do with one block. */
export type BlockOp =
  | { op: 'keep'; base: DiffBlock; next: DiffBlock; children: BlockOp[] }
  | { op: 'update'; base: DiffBlock; next: DiffBlock; children: BlockOp[] }
  | { op: 'move'; base: DiffBlock; next: DiffBlock }
  | { op: 'insert'; next: DiffBlock }
  | { op: 'delete'; base: DiffBlock };

/** How much a push touched, for the report (MANUAL §7). */
export interface BlockCounts {
  kept: number;
  updated: number;
  inserted: number;
  deleted: number;
}

/** How alike two blocks must be to be one block edited. Git's threshold. */
const RENAME_THRESHOLD = 0.5;

/** The most cells the block alignment will fill in. See `text.ts`. */
const MAX_CELLS = 4_000_000;

const ATTRIBUTE_COMMENT = /^<!--\s*docsync:\s*(?!block\b)(.*?)\s*-->$/;
const PLACEHOLDER_COMMENT = /^<!--\s*docsync:(?:block|object)\b.*?\btype=(\S+?)\s*-->$/;
const DETAILS_OPEN = /^<details\b/;
const SUMMARY = /<summary>([\s\S]*?)<\/summary>/;
const HEADING_SUMMARY = /^(#{1,6})\s+([\s\S]*)$/;
const CALLOUT_MARKER = /^\[!CALLOUT\][ \t]*(\S*)[ \t]*(\n|$)/;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/** A link into some document's `<title>.assets/`, which is a file (§12). */
const ASSET_LINK = /(^|\/)[^/]+\.assets\//;
const MENTION_URL = /^notion:\/\/|^https:\/\/(?:www\.notion\.so|app\.notion\.com)\//i;

/** The diff of two documents, as ops over their blocks. */
export function diffBlocks(base: Root, next: Root): BlockOp[] {
  return diffLevel(flattenBlocks(base), flattenBlocks(next));
}

/** What a run of ops did, the whole tree counted. */
export function countOps(ops: readonly BlockOp[]): BlockCounts {
  const counts: BlockCounts = { kept: 0, updated: 0, inserted: 0, deleted: 0 };
  const add = (one: BlockCounts): void => {
    counts.kept += one.kept;
    counts.updated += one.updated;
    counts.inserted += one.inserted;
    counts.deleted += one.deleted;
  };
  for (const op of ops) {
    if (op.op === 'keep') {
      counts.kept += 1;
      add(countOps(op.children));
    } else if (op.op === 'update') {
      counts.updated += 1;
      add(countOps(op.children));
    } else if (op.op === 'insert') counts.inserted += 1;
    else if (op.op === 'delete') counts.deleted += 1;
    else {
      // A move is a deletion and an insertion: neither source can move a block.
      counts.inserted += 1;
      counts.deleted += 1;
    }
  }
  return counts;
}

/* --------------------------------------------------------------- alignment */

function identity(block: DiffBlock): string {
  return `${block.type} ${block.markdown}`;
}

/** One level of the tree: the alignment, the hunks in it, and the moves. */
function diffLevel(base: readonly DiffBlock[], next: readonly DiffBlock[]): BlockOp[] {
  const ops: BlockOp[] = [];
  const a = base.map(identity);
  const b = next.map(identity);
  const table = alignment(a, b);
  const width = b.length + 1;

  let i = 0;
  let j = 0;
  let removed: DiffBlock[] = [];
  let inserted: DiffBlock[] = [];
  const flush = (): void => {
    if (removed.length > 0 || inserted.length > 0) ops.push(...hunk(removed, inserted));
    removed = [];
    inserted = [];
  };

  while (i < base.length || j < next.length) {
    const one = base[i];
    const other = next[j];
    if (one !== undefined && other !== undefined && a[i] === b[j]) {
      flush();
      ops.push({
        op: 'keep',
        base: one,
        next: other,
        children: diffLevel(one.children, other.children),
      });
      i += 1;
      j += 1;
      continue;
    }
    const down = table === undefined ? 0 : (table[(i + 1) * width + j] ?? 0);
    const right = table === undefined ? 0 : (table[i * width + j + 1] ?? 0);
    if (other === undefined || (one !== undefined && down >= right)) {
      removed.push(one as DiffBlock);
      i += 1;
    } else {
      inserted.push(other);
      j += 1;
    }
  }
  flush();

  return moves(ops);
}

/**
 * `table[i * width + j]`: the longest common subsequence of the blocks from
 * `i` and from `j` on. `undefined` when the two versions are too large to
 * align, in which case nothing matches and the whole document is one hunk —
 * where similarity pairing still does the useful work.
 */
function alignment(a: readonly string[], b: readonly string[]): Uint32Array | undefined {
  if (a.length * b.length > MAX_CELLS) return undefined;
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
  return table;
}

/**
 * One stretch of change. A removed and an inserted block of the same type that
 * are at least half the same text are one block edited; the best pair wins, so
 * a hunk with two candidates gives the edit to the closer one.
 *
 * Then one fallback, for the case the measure is wrong about: when exactly one
 * removed and exactly one inserted block of the same type are left over, they
 * are one block edited whatever they score. `Two.` became `Two, edited.` — a
 * third of it survived, which git would call a different file and a reader
 * calls a typo fixed. One paragraph replaced by one paragraph in the same
 * place keeps its id and its comments (MANUAL §7).
 */
function hunk(removed: readonly DiffBlock[], inserted: readonly DiffBlock[]): BlockOp[] {
  const pairs: { from: number; to: number; score: number }[] = [];
  for (const [from, one] of removed.entries()) {
    for (const [to, other] of inserted.entries()) {
      if (one.type !== other.type) continue;
      const score = similarity(one.text, other.text);
      if (score >= RENAME_THRESHOLD) pairs.push({ from, to, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score || Math.abs(x.from - x.to) - Math.abs(y.from - y.to));

  const pairedFrom = new Map<number, number>();
  const takenTo = new Set<number>();
  for (const pair of pairs) {
    if (pairedFrom.has(pair.from) || takenTo.has(pair.to)) continue;
    pairedFrom.set(pair.from, pair.to);
    takenTo.add(pair.to);
  }

  // The one-for-one fallback. Two left over of the same type say which is
  // which by being the only ones; three or more do not, and stay a deletion
  // and an insertion rather than a guess.
  const restFrom = [...removed.entries()].filter(([from]) => !pairedFrom.has(from));
  const restTo = [...inserted.entries()].filter(([to]) => !takenTo.has(to));
  const [only] = restFrom;
  const [other] = restTo;
  if (
    restFrom.length === 1 &&
    restTo.length === 1 &&
    only !== undefined &&
    other !== undefined &&
    only[1].type === other[1].type
  ) {
    pairedFrom.set(only[0], other[0]);
    takenTo.add(other[0]);
  }

  const ops: BlockOp[] = [];
  // Deletions first: they free nothing, but the ops after them are the ones
  // an adapter positions against, and those must be in the new document order.
  for (const [from, one] of removed.entries()) {
    if (!pairedFrom.has(from)) ops.push({ op: 'delete', base: one });
  }
  const updates = new Map([...pairedFrom].map(([from, to]) => [to, removed[from] as DiffBlock]));
  for (const [to, other] of inserted.entries()) {
    const one = updates.get(to);
    ops.push(
      one === undefined
        ? { op: 'insert', next: other }
        : {
            op: 'update',
            base: one,
            next: other,
            children: diffLevel(one.children, other.children),
          },
    );
  }
  return ops;
}

/**
 * A block deleted here and inserted unchanged there is one block that moved.
 * It is still a deletion and an insertion at the source — neither Notion nor
 * Docs can move a block — but the report and the manual call it what it is.
 */
function moves(ops: readonly BlockOp[]): BlockOp[] {
  const deleted = new Map<string, number>();
  for (const [at, op] of ops.entries()) {
    if (op.op === 'delete') deleted.set(identity(op.base), at);
  }
  if (deleted.size === 0) return [...ops];

  const dropped = new Set<number>();
  const out = ops.map((op, at) => {
    if (op.op !== 'insert') return op;
    const from = deleted.get(identity(op.next));
    if (from === undefined || from === at || dropped.has(from)) return op;
    const source = ops[from];
    if (source?.op !== 'delete') return op;
    deleted.delete(identity(op.next));
    dropped.add(from);
    return { op: 'move', base: source.base, next: op.next } satisfies BlockOp;
  });
  return out.filter((_op, at) => !dropped.has(at));
}

/* -------------------------------------------------------------- flattening */

/** The blocks of a document, as the sources hold them. */
export function flattenBlocks(root: Root): DiffBlock[] {
  return flatten(root.children);
}

/** The attributes comment that belongs to the block after it, if any. */
type Pending = RootContent | undefined;

function flatten(nodes: readonly RootContent[]): DiffBlock[] {
  const out: DiffBlock[] = [];
  let attributes: Pending;
  let index = 0;

  const push = (block: Omit<DiffBlock, 'index' | 'source'>, source: RootContent[]): void => {
    out.push({
      ...block,
      markdown:
        attributes === undefined ? block.markdown : `${text(attributes)}\n${block.markdown}`,
      source: attributes === undefined ? source : [attributes, ...source],
      index: out.length,
    });
    attributes = undefined;
  };

  while (index < nodes.length) {
    const node = nodes[index];
    index += 1;
    if (node === undefined) continue;

    if (node.type === 'html') {
      const value = node.value.trim();
      const placeholder = PLACEHOLDER_COMMENT.exec(value);
      if (placeholder?.[1] !== undefined) {
        push(
          { type: `placeholder:${placeholder[1]}`, markdown: value, text: value, children: [] },
          [node],
        );
        continue;
      }
      if (ATTRIBUTE_COMMENT.test(value)) {
        attributes = node;
        continue;
      }
      if (DETAILS_OPEN.test(value)) {
        const end = closingDetails(nodes, index - 1);
        push(toggle(node.value, flatten(nodes.slice(index, end))), [
          node,
          ...nodes.slice(index, end + 1),
        ]);
        index = end + 1;
        continue;
      }
      // A stray closing tag, or HTML the dialect does not write.
      continue;
    }

    if (node.type === 'list') {
      for (const item of node.children) push(...listItem(item, node));
      continue;
    }

    push(...block(node));
  }

  return out;
}

/** One block that is not a list and not a toggle. */
function block(node: RootContent): [Omit<DiffBlock, 'index' | 'source'>, RootContent[]] {
  switch (node.type) {
    case 'heading':
      return [
        {
          type: `heading:${(node as Heading).depth}`,
          markdown: text(node),
          text: plain(node.children),
          inline: node.children,
          children: [],
        },
        [node],
      ];
    case 'blockquote':
      return [quote(node as Blockquote), [node]];
    case 'table':
      return [tableBlock(node as Table), [node]];
    case 'paragraph':
      return [paragraph(node as Paragraph), [node]];
    default:
      return [
        {
          type:
            node.type === 'thematicBreak'
              ? 'divider'
              : node.type === 'math'
                ? 'equation'
                : node.type,
          markdown: text(node),
          text: 'value' in node && typeof node.value === 'string' ? node.value : text(node),
          inline:
            'value' in node && typeof node.value === 'string'
              ? [{ type: 'text', value: node.value }]
              : undefined,
          children: [],
        },
        [node],
      ];
  }
}

/** A paragraph, unless it is the dialect's spelling of a media block (§6). */
function paragraph(node: Paragraph): Omit<DiffBlock, 'index' | 'source'> {
  const only = node.children.length === 1 ? node.children[0] : undefined;
  const type =
    only?.type === 'image'
      ? 'image'
      : only?.type === 'link' &&
          !MENTION_URL.test(only.url) &&
          (ABSOLUTE.test(only.url) || ASSET_LINK.test(only.url))
        ? 'file'
        : 'paragraph';
  return {
    type,
    markdown: text(node),
    text: plain(node.children),
    inline: node.children,
    children: [],
  };
}

/** A blockquote is a quote, or a callout when its first line says so (§6). */
function quote(node: Blockquote): Omit<DiffBlock, 'index' | 'source'> {
  const [first, ...rest] = node.children;
  const lead = first?.type === 'paragraph' ? first : undefined;
  const marker = lead === undefined ? undefined : calloutMarker(lead.children);
  const inline = marker ?? lead?.children ?? [];
  const own: Blockquote = {
    type: 'blockquote',
    children: lead === undefined ? [] : [lead],
  };
  return {
    type: marker === undefined ? 'quote' : 'callout',
    markdown: text(own),
    text: plain(inline),
    inline,
    children: flatten(lead === undefined ? node.children : rest),
  };
}

/** What is left of a callout's first paragraph after the marker line. */
function calloutMarker(children: readonly PhrasingContent[]): PhrasingContent[] | undefined {
  const first = children[0];
  if (first?.type !== 'text') return undefined;
  const found = CALLOUT_MARKER.exec(first.value);
  if (found === null) return undefined;
  const tail = first.value.slice(found[0].length);
  const after = children.slice(tail === '' && children[1]?.type === 'break' ? 2 : 1);
  return tail === '' ? after : [{ type: 'text', value: tail }, ...after];
}

/** A table is its rows; its own identity is its shape, not its content. */
function tableBlock(node: Table): Omit<DiffBlock, 'index' | 'source'> {
  const width = Math.max(0, ...node.children.map((row) => row.children.length));
  return {
    type: 'table',
    markdown: `columns=${width}`,
    text: '',
    children: node.children.map((row, index) => ({ ...tableRow(row), index, source: [row] })),
  };
}

function tableRow(row: TableRow): Omit<DiffBlock, 'index' | 'source'> {
  const cells = row.children.map((cell) => cell.children);
  return {
    type: 'tableRow',
    markdown: cells.map((cell) => inlineText(cell)).join('|'),
    text: cells.map((cell) => plain(cell)).join('\t'),
    cells,
    children: [],
  };
}

function listItem(
  item: ListItem,
  list: List,
): [Omit<DiffBlock, 'index' | 'source'>, RootContent[]] {
  const [first, ...rest] = item.children;
  const lead = first?.type === 'paragraph' ? first : undefined;
  const inline = lead?.children ?? [];
  const kind =
    list.ordered === true ? 'ordered' : typeof item.checked === 'boolean' ? 'todo' : 'bullet';
  // The item on its own, with only its lead paragraph: `- [x] text`, which is
  // the identity a to-do's tick belongs in.
  const own: List = {
    ...list,
    children: [{ ...item, children: lead === undefined ? [] : [lead] }],
  };
  return [
    {
      type: `listItem:${kind}`,
      markdown: text(own),
      text: plain(inline),
      inline,
      children: flatten(lead === undefined ? item.children : rest),
    },
    [{ ...list, children: [item] }],
  ];
}

/** `<details><summary>…</summary>` is a toggle, or a toggle heading (§6). */
function toggle(open: string, children: DiffBlock[]): Omit<DiffBlock, 'index' | 'source'> {
  const summary = SUMMARY.exec(open)?.[1]?.trim() ?? '';
  const heading = HEADING_SUMMARY.exec(summary);
  const inline = phrasingOf(heading?.[2] ?? summary);
  return {
    type: heading?.[1] === undefined ? 'toggle' : `toggleHeading:${heading[1].length}`,
    markdown: open.trim(),
    text: plain(inline),
    inline,
    children,
  };
}

/** The inline Markdown of a `<summary>`, as phrasing content. */
function phrasingOf(markdown: string): PhrasingContent[] {
  const first = parseMarkdown(markdown).children[0];
  return first?.type === 'paragraph' || first?.type === 'heading' ? first.children : [];
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
  return nodes.length;
}

function count(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

/** One node as canonical Markdown, which is what makes it an identity. */
function text(node: RootContent): string {
  return stringifyMarkdown({ type: 'root', children: [node] }).trim();
}

/** Inline content as canonical Markdown, for a table cell's identity. */
function inlineText(nodes: readonly PhrasingContent[]): string {
  return stringifyMarkdown({
    type: 'root',
    children: [{ type: 'paragraph', children: [...nodes] }],
  }).trim();
}

/** Inline content as the text a reader sees. */
function plain(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') {
        return node.value;
      }
      if (node.type === 'break') return '\n';
      // An image is one object, and its alt is no part of the text: an image
      // added or removed has to move the text even when its alt is empty. Its
      // URL and its alt are in the block's `markdown`, which is its identity.
      if (node.type === 'image') return OBJECT_REPLACEMENT;
      if (node.type === 'html') return /^<\/?(u|span)\b/.test(node.value.trim()) ? '' : node.value;
      return 'children' in node ? plain(node.children as PhrasingContent[]) : '';
    })
    .join('');
}
