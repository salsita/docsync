/**
 * What changed inside one block: which characters, and which formatting.
 *
 * Pure and source-agnostic, over the dialect's inline Markdown (MANUAL §6).
 * Two answers, and a source adapter needs both to patch a block in place
 * (MANUAL §7):
 *
 * 1. **Spans.** The text of the block before and after, diffed on word
 *    boundaries, as a run of kept, deleted and inserted spans with the offsets
 *    they have in both texts. An adapter walks them to decide which characters
 *    of the live block to cut and where to put new ones.
 * 2. **Style changes.** For the characters that were *kept*, the inline
 *    attributes the dialect owns — bold, italic, strikethrough, underline,
 *    code, colour and the link target — wherever the new version disagrees
 *    with the old one. Only the keys that differ are named, so an attribute
 *    the dialect cannot express is never mentioned and therefore never
 *    overwritten.
 *
 * Inserted text has no style change of its own here: it is new, so there is
 * nothing to compare it against. The adapter gives it the formatting of the
 * text before it (MANUAL §7) and reads its own emphasis off `inlineRuns`.
 */
import type { PhrasingContent } from 'mdast';
import { tokens } from './similarity.js';

/** One piece of the character diff. `text` is the piece itself. */
export interface Span {
  kind: 'keep' | 'delete' | 'insert';
  text: string;
  /** Offset in the base text. For an insertion, where it goes. */
  base: number;
  /** Offset in the new text. For a deletion, where it was. */
  next: number;
}

/** The inline attributes the dialect owns, and nothing else. */
export interface InlineStyle {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  /** Notion's own colour names; `default` is the one the dialect omits. */
  color: string;
  /** The link target, or `null` for text that is not a link. */
  link: string | null;
}

/** A stretch of text that carries one style. */
export interface StyledRun {
  text: string;
  style: InlineStyle;
}

/** A style disagreement over kept text, at an offset in the **new** text. */
export interface StyleChange {
  at: number;
  length: number;
  /** Only the keys that differ, with the values the new version wants. */
  style: Partial<InlineStyle>;
}

export const DEFAULT_STYLE: InlineStyle = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
  link: null,
};

/** The style keys, in the order a change lists them. */
const KEYS = ['bold', 'italic', 'strikethrough', 'underline', 'code', 'color', 'link'] as const;

/**
 * Tokens the diff will not look inside. A paragraph of a few hundred words is
 * nothing; a code block of a hundred thousand is, and quadratic is quadratic.
 * Past this the changed middle is one deletion and one insertion, which is
 * what a whole-block rewrite would have done anyway.
 */
const MAX_CELLS = 4_000_000;

/** The character diff of two texts, on word boundaries. */
export function diffText(base: string, next: string): Span[] {
  const a = tokens(base);
  const b = tokens(next);

  // Most edits touch the middle of a block, so the shared ends come off first:
  // it is what keeps the quadratic part small on a long paragraph.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  const out = new Spans();
  for (let index = 0; index < head; index += 1) out.push('keep', a[index] ?? '');
  walkMiddle(middleA, middleB, out);
  for (let index = a.length - tail; index < a.length; index += 1) out.push('keep', a[index] ?? '');
  return coalesce(out.done());
}

/**
 * One rewritten sentence is one edit, not one per word.
 *
 * A token diff of two unrelated sentences keeps the spaces between the words,
 * which is true and useless: it would cut and re-insert around every space and
 * leave the block's formatting shredded. A kept span that is only whitespace
 * and has an edit on both sides joins those edits, and each stretch of change
 * is then written as one deletion followed by one insertion.
 */
function coalesce(spans: readonly Span[]): Span[] {
  const joins = spans.map(
    (span, index) =>
      span.kind === 'keep' &&
      span.text.trim() === '' &&
      spans[index - 1] !== undefined &&
      spans[index - 1]?.kind !== 'keep' &&
      spans[index + 1] !== undefined &&
      spans[index + 1]?.kind !== 'keep',
  );

  const out = new Spans();
  for (let at = 0; at < spans.length; at += 1) {
    const span = spans[at];
    if (span === undefined) continue;
    if (span.kind === 'keep' && joins[at] !== true) {
      out.push('keep', span.text);
      continue;
    }
    let deleted = '';
    let inserted = '';
    while (at < spans.length) {
      const one = spans[at];
      if (one === undefined || (one.kind === 'keep' && joins[at] !== true)) break;
      if (one.kind !== 'insert') deleted += one.text;
      if (one.kind !== 'delete') inserted += one.text;
      at += 1;
    }
    at -= 1;
    out.push('delete', deleted);
    out.push('insert', inserted);
  }
  return out.done();
}

/** The changed middle, as a longest common subsequence over its tokens. */
function walkMiddle(a: readonly string[], b: readonly string[], out: Spans): void {
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) {
    for (const token of a) out.push('delete', token);
    for (const token of b) out.push('insert', token);
    return;
  }

  // `table[i * width + j]` is the length of the longest common subsequence of
  // `a[i:]` and `b[j:]`, so the walk below can go forwards.
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

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push('keep', a[i] ?? '');
      i += 1;
      j += 1;
    } else if (
      j >= b.length ||
      (i < a.length && (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      // A deletion before an insertion, so that a replacement reads the way a
      // diff does: the old text, then the new one.
      out.push('delete', a[i] ?? '');
      i += 1;
    } else {
      out.push('insert', b[j] ?? '');
      j += 1;
    }
  }
}

/** Spans under construction: adjacent pieces of one kind are one span. */
class Spans {
  private readonly spans: Span[] = [];
  private base = 0;
  private next = 0;

  push(kind: Span['kind'], text: string): void {
    if (text === '') return;
    const last = this.spans.at(-1);
    if (last !== undefined && last.kind === kind) last.text += text;
    else this.spans.push({ kind, text, base: this.base, next: this.next });
    if (kind !== 'insert') this.base += text.length;
    if (kind !== 'delete') this.next += text.length;
  }

  done(): Span[] {
    return this.spans;
  }
}

/** The dialect's inline Markdown as runs of text that each carry one style. */
export function inlineRuns(nodes: readonly PhrasingContent[]): StyledRun[] {
  const out: StyledRun[] = [];
  walk(nodes, DEFAULT_STYLE, out);
  return out;
}

/** The text a reader sees, with no markup at all. */
export function plainOf(nodes: readonly PhrasingContent[]): string {
  return inlineRuns(nodes)
    .map((run) => run.text)
    .join('');
}

const COLOR_SPAN = /^<span\s+data-color="([^"]*)"\s*>$/;

/**
 * Phrasing content, carrying the style in force. `<u>` and the colour span are
 * HTML nodes rather than mdast marks, so they are a stack over the sibling
 * list — the same shape `from-markdown.ts` uses to read them.
 */
function walk(nodes: readonly PhrasingContent[], style: InlineStyle, out: StyledRun[]): void {
  let current = style;
  const stack: InlineStyle[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push({ text: node.value, style: current });
        break;
      case 'inlineCode':
        out.push({ text: node.value, style: { ...current, code: true } });
        break;
      case 'inlineMath':
        // An equation's own text is what the block says at that offset; the
        // adapter treats the run it lives in as atomic when an edit reaches it.
        out.push({ text: node.value, style: current });
        break;
      case 'break':
        out.push({ text: '\n', style: current });
        break;
      case 'strong':
        walk(node.children, { ...current, bold: true }, out);
        break;
      case 'emphasis':
        walk(node.children, { ...current, italic: true }, out);
        break;
      case 'delete':
        walk(node.children, { ...current, strikethrough: true }, out);
        break;
      case 'link':
        walk(node.children, { ...current, link: node.url }, out);
        break;
      case 'image':
        out.push({ text: node.alt ?? node.url, style: { ...current, link: node.url } });
        break;
      case 'html': {
        const tag = node.value.trim();
        const color = COLOR_SPAN.exec(tag);
        if (tag === '<u>') {
          stack.push(current);
          current = { ...current, underline: true };
        } else if (color?.[1] !== undefined) {
          stack.push(current);
          current = { ...current, color: color[1] };
        } else if (/^<\/(u|span)>$/.test(tag)) {
          current = stack.pop() ?? style;
        } else {
          // The callout marker, and any HTML the dialect does not write.
          out.push({ text: tag, style: current });
        }
        break;
      }
      default:
        break;
    }
  }
}

/** The style of every character, so that two versions can be compared. */
function styleByCharacter(runs: readonly StyledRun[]): InlineStyle[] {
  const out: InlineStyle[] = [];
  for (const run of runs) for (const _ of run.text) out.push(run.style);
  return out;
}

/** What changed inside one block: its characters, and the style of the kept ones. */
export function diffInline(
  base: readonly PhrasingContent[],
  next: readonly PhrasingContent[],
): { spans: Span[]; styles: StyleChange[] } {
  const baseRuns = inlineRuns(base);
  const nextRuns = inlineRuns(next);
  const spans = diffText(
    baseRuns.map((run) => run.text).join(''),
    nextRuns.map((run) => run.text).join(''),
  );

  const baseStyles = styleByCharacter(baseRuns);
  const nextStyles = styleByCharacter(nextRuns);
  const styles: StyleChange[] = [];

  for (const span of spans) {
    if (span.kind !== 'keep') continue;
    // `[...text]` and not `text.length`: the style arrays are per code point,
    // which is what keeps an emoji from splitting a change in two.
    const length = [...span.text].length;
    let at = 0;
    while (at < length) {
      const change = difference(baseStyles[span.base + at], nextStyles[span.next + at]);
      if (change === undefined) {
        at += 1;
        continue;
      }
      const key = JSON.stringify(change);
      let end = at + 1;
      while (
        end < length &&
        JSON.stringify(difference(baseStyles[span.base + end], nextStyles[span.next + end])) === key
      ) {
        end += 1;
      }
      styles.push({ at: span.next + at, length: end - at, style: change });
      at = end;
    }
  }

  return { spans, styles };
}

/** The keys the new style disagrees on, or `undefined` when it agrees. */
function difference(
  base: InlineStyle | undefined,
  next: InlineStyle | undefined,
): Partial<InlineStyle> | undefined {
  if (base === undefined || next === undefined || base === next) return undefined;
  const change: Partial<InlineStyle> = {};
  let changed = false;
  for (const key of KEYS) {
    if (base[key] === next[key]) continue;
    Object.assign(change, { [key]: next[key] });
    changed = true;
  }
  return changed ? change : undefined;
}
