/**
 * One block's rich text, patched rather than rewritten (MANUAL §7).
 *
 * Notion has no partial update: a block is written with the whole `rich_text`
 * array it will have. Doing that from the Markdown alone throws away
 * everything the dialect cannot say — and everything it can say but the writer
 * did not touch. So the array we send is built from the **live** one: the
 * characters that survived keep the runs they were in, deleted spans are cut
 * out, inserted text takes the formatting of the text before it, and a
 * formatting change in the Markdown sets only the annotation keys the dialect
 * owns, on only the characters it covers.
 *
 * A mention and an equation are atomic: an edit that runs across one replaces
 * it with its text, because half a mention is not a mention.
 */
import type { PhrasingContent } from 'mdast';
import { diffInline, type StyleChange } from '../diff/text.js';
import type { RawObject } from './api.js';
import { type FromMarkdownOptions, inline } from './from-markdown.js';
import { plain, type RichText } from './to-markdown.js';

/** The annotations Notion puts on every run, with its defaults. */
interface Annotations extends RawObject {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

const DEFAULT_ANNOTATIONS: Annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

const FLAGS = ['bold', 'italic', 'strikethrough', 'underline', 'code'] as const;

/** A run under construction, with the text it holds. */
interface Piece {
  text: string;
  run: RawObject;
}

/**
 * The live block's runs, with the edit between `base` and `next` applied.
 *
 * `base` is the inline content of the block as the pushed commit started from;
 * it must be what the live runs say, which push has already checked for the
 * document as a whole. When it is not — a block the check could not speak for
 * — the new content is written whole, which is what phase 1 did for everything.
 */
export function mergeRichText(
  live: readonly RichText[],
  base: readonly PhrasingContent[],
  next: readonly PhrasingContent[],
  options: FromMarkdownOptions = {},
): RawObject[] {
  const fresh = inline(next, options) as unknown as RichText[];
  if (plain(live) !== plain(inline(base, options) as unknown as RichText[])) {
    return output(sliceRuns(fresh, 0, plain(fresh).length));
  }

  const { spans, styles } = diffInline(base, next);
  const pieces: Piece[] = [];

  for (const span of spans) {
    if (span.kind === 'delete') continue;
    if (span.kind === 'keep') {
      pieces.push(...sliceRuns(live, span.base, span.base + span.text.length));
      continue;
    }
    // Inserted text comes from the new version — mentions and all — wearing
    // the formatting of the text before it (the text after it, at the start).
    const before = pieces.at(-1)?.run ?? live[0];
    for (const piece of sliceRuns(fresh, span.next, span.next + span.text.length)) {
      piece.run.annotations = inherit(annotationsOf(before), annotationsOf(piece.run));
      pieces.push(piece);
    }
  }

  return output(applyStyles(pieces, styles));
}

/**
 * The runs covering `[from, to)` of a run array's text. A run the range covers
 * whole is copied as it is; one it covers in part is cut, and a mention or an
 * equation cut in part becomes the plain text of the part that survived —
 * half a mention is not a mention (MANUAL §7).
 */
function sliceRuns(runs: readonly RichText[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const run of runs) {
    const text = run.plain_text ?? '';
    const start = Math.max(from, at);
    const end = Math.min(to, at + text.length);
    const part = end <= start ? '' : text.slice(start - at, end - at);
    at += text.length;
    if (part === '') continue;

    if (part === text && run.type !== 'text') {
      out.push({ text: part, run: { ...(run as RawObject) } });
      continue;
    }
    const link =
      run.type === 'text'
        ? ((run.text as { link?: { url: string } | null } | undefined)?.link ?? null)
        : null;
    out.push({ text: part, run: textRun(part, annotationsOf(run as RawObject), link) });
  }
  return out;
}

function textRun(
  content: string,
  annotations: Annotations,
  link: { url: string } | null,
): RawObject {
  return {
    type: 'text',
    text: { content, link },
    annotations,
    plain_text: content,
    href: link?.url ?? null,
  };
}

function annotationsOf(run: RawObject | RichText | undefined): Annotations {
  const found = (run as RawObject | undefined)?.annotations;
  return { ...DEFAULT_ANNOTATIONS, ...(typeof found === 'object' && found !== null ? found : {}) };
}

/**
 * What inserted text wears: the emphasis it carries in the new Markdown *and*
 * the emphasis the text before it had, plus that text's colour when the new
 * Markdown does not name one. A link is not inherited — the Markdown says
 * where a link is, and text typed after one is not part of it.
 */
function inherit(before: Annotations, own: Annotations): Annotations {
  const merged: Annotations = { ...own };
  for (const flag of FLAGS) merged[flag] = own[flag] === true || before[flag] === true;
  merged.color = own.color === 'default' ? before.color : own.color;
  return merged;
}

/** The style changes of the new version, applied to the pieces they cover. */
function applyStyles(pieces: readonly Piece[], styles: readonly StyleChange[]): Piece[] {
  if (styles.length === 0) return [...pieces];
  let out = [...pieces];
  for (const change of styles) out = applyOne(out, change);
  return out;
}

function applyOne(pieces: readonly Piece[], change: StyleChange): Piece[] {
  const out: Piece[] = [];
  const to = change.at + change.length;
  let at = 0;

  for (const piece of pieces) {
    const start = at;
    const end = at + piece.text.length;
    at = end;
    if (end <= change.at || start >= to) {
      out.push(piece);
      continue;
    }
    const cut = (from: number, until: number, styled: boolean): void => {
      if (until <= from) return;
      const text = piece.text.slice(from - start, until - start);
      const run = styled ? withStyle(piece, text, change) : sliceOf(piece, text);
      out.push({ text, run });
    };
    cut(start, Math.max(start, change.at), false);
    cut(Math.max(start, change.at), Math.min(end, to), true);
    cut(Math.min(end, to), end, false);
  }
  return out;
}

/** The same run over less text. A mention cut in part becomes its text. */
function sliceOf(piece: Piece, text: string): RawObject {
  if (text === piece.text) return piece.run;
  if (piece.run.type === 'text') {
    const link = (piece.run.text as { link?: { url: string } | null } | undefined)?.link ?? null;
    return textRun(text, annotationsOf(piece.run), link);
  }
  return textRun(text, annotationsOf(piece.run), null);
}

/** One piece with the changed attributes on it, and nothing else touched. */
function withStyle(piece: Piece, text: string, change: StyleChange): RawObject {
  const run = { ...sliceOf(piece, text) };
  const annotations: Annotations = { ...annotationsOf(run) };
  for (const flag of FLAGS) {
    const value = change.style[flag];
    if (typeof value === 'boolean') annotations[flag] = value;
  }
  if (typeof change.style.color === 'string') annotations.color = change.style.color;
  run.annotations = annotations;

  if ('link' in change.style) {
    const url = change.style.link ?? null;
    if (run.type === 'text') {
      run.text = { ...(run.text as RawObject), link: url === null ? null : { url } };
      run.href = url;
    }
  }
  return run;
}

/** The runs to send, with adjacent runs that agree on everything joined. */
function output(pieces: readonly Piece[]): RawObject[] {
  const out: RawObject[] = [];
  for (const piece of pieces) {
    if (piece.text === '' && piece.run.type === 'text') continue;
    const last = out.at(-1);
    if (last !== undefined && joinable(last, piece.run)) {
      const content = String((last.text as RawObject).content ?? '') + piece.text;
      last.text = { ...(last.text as RawObject), content };
      last.plain_text = content;
      continue;
    }
    out.push(piece.run);
  }
  return out;
}

function joinable(last: RawObject, run: RawObject): boolean {
  if (last.type !== 'text' || run.type !== 'text') return false;
  const link = (one: RawObject) =>
    (one.text as { link?: { url: string } | null }).link?.url ?? null;
  if (link(last) !== link(run)) return false;
  const a = annotationsOf(last);
  const b = annotationsOf(run);
  return FLAGS.every((flag) => a[flag] === b[flag]) && a.color === b.color;
}
