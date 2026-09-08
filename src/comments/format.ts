/**
 * The comment sidecar as text (MANUAL §6 "Comments and suggestions").
 *
 * `<title>.comments.md` beside `<title>.md`, written on every fetch that finds
 * an open thread or a pending suggestion and removed when the last one goes.
 * This module is the whole of its format and pure: threads in — from Drive
 * (`src/gdrive/comments.ts`) or from Notion (`src/notion/comments.ts`), already
 * anchored by `locate.ts` — Markdown out. Nothing here knows a source.
 *
 * The file is read by a person or an agent and diffed by git, so the order is
 * the body's own — a document read top to bottom has its threads in the same
 * order — and every line is stable across fetches, which is what keeps a new
 * comment a small diff.
 */
import { formatSourceRef, type SourceRef } from '../source-ref.js';

/** What one person wrote in a thread, once. */
export interface Entry {
  author: string;
  /** ISO 8601, as the source reported it. Printed to the minute. */
  time: string;
  text: string;
}

/** One open comment thread or one pending suggestion. */
export interface Thread {
  /** The source's own id: a Drive comment id, a Notion discussion, a suggestion. */
  id: string;
  kind: 'comment' | 'suggestion';
  /**
   * Where the anchor is in the body. Absent when the anchored text is nowhere
   * in it, which sorts the thread to the end and prints `in: (not found)`.
   */
  offset?: number;
  /**
   * Where inside the anchor the thread sits, for the one case where two of them
   * share a block and creation time says nothing: two suggestions in one
   * paragraph, which Docs does not date.
   */
  within?: number;
  /** Creation time, which breaks ties between two threads on one paragraph. */
  created: string;
  /** The anchor block as written, without the marks. */
  quote?: string;
  /** The range inside `quote` the comment is attached to. */
  mark?: [number, number];
  /** The nearest heading above the anchor. Absent when there is none. */
  heading?: string;
  /**
   * A suggestion's blocks as they stand, one entry per block: the first and the
   * last block it touches and everything between them (ticket 34).
   */
  before?: readonly string[];
  /**
   * The same blocks with this one suggestion accepted. As long as `before`, and
   * equal to it at every block the suggestion does not change, which is what
   * makes those blocks print as context.
   */
  after?: readonly string[];
  /** The comments of the thread, in creation order. A suggestion has none. */
  entries: Entry[];
}

export interface Sidecar {
  document: SourceRef;
  /** When the fetch ran, ISO 8601 to the second. */
  fetched: string;
  threads: readonly Thread[];
}

/** The suffix that makes a path a sidecar and nothing else (MANUAL §6). */
export const SIDECAR_SUFFIX = '.comments.md';

/** `drive/Elements.md` → `drive/Elements.comments.md`. */
export function sidecarPathOf(path: string): string {
  return `${path.slice(0, -'.md'.length)}${SIDECAR_SUFFIX}`;
}

/** Whether a path is a sidecar. `comments.md` alone is a document named that. */
export function isSidecarPath(path: string | undefined): boolean {
  if (path === undefined || path.length <= SIDECAR_SUFFIX.length) return false;
  return path.endsWith(SIDECAR_SUFFIX);
}

/**
 * Whether two sidecars say the same thing and differ only in when they were
 * fetched.
 *
 * A comment does not move a document's last-edit time, so the sidecars are
 * rebuilt on every fetch; `fetched:` would then make every fetch a commit. The
 * helper compares with this and keeps the blob it already has.
 */
export function sameButForFetched(one: string, two: string): boolean {
  const strip = (text: string): string => text.replace(/^fetched: .*$/m, 'fetched:');
  return strip(one) === strip(two);
}

/** `2026-09-03T07:55:12.165Z` → `2026-09-03 07:55`. Notion says no more. */
function minute(time: string): string {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return time;
  return at.toISOString().replace('T', ' ').slice(0, 16);
}

/** A block quoted, every line of it, the way Markdown quotes one. */
function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** The anchor with `==` around the words the comment is attached to. */
function marked(thread: Thread): string {
  const { quote = '', mark } = thread;
  if (mark === undefined) return quote;
  const [start, end] = mark;
  return `${quote.slice(0, start)}==${quote.slice(start, end)}==${quote.slice(end)}`;
}

/**
 * Every line of a diff side, prefixed. A paragraph can hold a line break, and a
 * whole paragraph suggested or struck out has nothing on the other side.
 */
function sided(sign: '-' | '+' | ' ', text: string): string[] {
  return text === '' ? [] : text.split('\n').map((line) => `${sign} ${line}`);
}

/**
 * A suggestion's diff, block by block (MANUAL §6). A block the suggestion
 * changes is a `-` line and a `+` line — a run of them is one hunk, the whole
 * `-` side then the whole `+` side. A block it only spans is printed once,
 * unchanged and without a sign, so the reader sees the text between the two
 * ends of the suggestion without being told it changed.
 */
function diff(before: readonly string[], after: readonly string[]): string[] {
  const lines: string[] = ['```diff'];
  let at = 0;
  while (at < before.length) {
    if (before[at] === after[at]) {
      lines.push(...sided(' ', before[at] ?? ''));
      at += 1;
      continue;
    }
    let to = at;
    while (to < before.length && before[to] !== after[to]) to += 1;
    for (const text of before.slice(at, to)) lines.push(...sided('-', text));
    for (const text of after.slice(at, to)) lines.push(...sided('+', text));
    at = to;
  }
  return [...lines, '```'];
}

/** `in:` — the heading, or why there is none (MANUAL §6). */
function whereIn(thread: Thread): string {
  if (thread.offset === undefined) return 'in: (not found)';
  return `in: ${thread.heading ?? '(top)'}`;
}

/**
 * Threads in the order the sidecar lists them: by where the anchor is in the
 * body, ties and unlocatable anchors by creation time, the unlocatable last.
 */
export function sortThreads(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((a, b) => {
    if (a.offset !== b.offset) {
      if (a.offset === undefined) return 1;
      if (b.offset === undefined) return -1;
      return a.offset - b.offset;
    }
    if ((a.within ?? -1) !== (b.within ?? -1)) return (a.within ?? -1) - (b.within ?? -1);
    if (a.created !== b.created) return a.created < b.created ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** One thread as its `## ` section, as a list of lines. */
function section(thread: Thread): string[] {
  const lines = [`## ${thread.id} — ${thread.kind}`, ''];

  if (thread.quote !== undefined) lines.push(quoted(marked(thread)), '');
  lines.push(whereIn(thread), '');

  if (thread.before !== undefined && thread.after !== undefined) {
    lines.push(...diff(thread.before, thread.after), '');
  } else if (thread.kind === 'suggestion') {
    // Nothing the dialect can show as a diff: the suggestion only restyles the
    // paragraph it is on (MANUAL §6).
    lines.push('formatting only', '');
  }

  for (const entry of thread.entries) {
    lines.push(`**${entry.author}** · ${minute(entry.time)}`, entry.text, '');
  }
  return lines;
}

/** The whole sidecar file, frontmatter and all. */
export function formatSidecar(sidecar: Sidecar): string {
  const lines = [
    '---',
    `document: ${formatSourceRef(sidecar.document)}`,
    `fetched: ${sidecar.fetched}`,
    '---',
    '',
  ];
  for (const thread of sortThreads(sidecar.threads)) lines.push(...section(thread));
  // Every section ends in a blank line; the file ends in one newline.
  return `${lines.slice(0, -1).join('\n')}\n`;
}
