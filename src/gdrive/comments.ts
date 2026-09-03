/**
 * A Google Doc's open comment threads and pending suggestions (MANUAL §6).
 *
 * Two sources, one shape. Drive's `comments.list` answers the threads: an
 * author, a time, a body and the text the comment is attached to, which this
 * module anchors in the Markdown a fetch produced (`../comments/locate.ts`).
 * The Docs response asked for with `suggestionsViewMode=SUGGESTIONS_INLINE`
 * answers the suggestions, and it carries both sides of every one of them at
 * once — so a suggestion becomes the paragraph as it stands and the paragraph
 * as it would read accepted, which is the diff the sidecar prints.
 *
 * Pure: recorded JSON and a body in, threads out. No requests, no clock.
 */
import type { Entry, Thread } from '../comments/format.js';
import { locate } from '../comments/locate.js';
import type {
  DocsDocument,
  DriveComment,
  DriveCommentAuthor,
  Paragraph,
  StructuralElement,
  TextRun,
} from './api.js';

export type { DriveComment, DriveCommentAuthor, DriveReply } from './api.js';

/** A soft line break inside a paragraph, which Docs stores as a vertical tab. */
const VERTICAL_TAB = '\u000B';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

/**
 * Drive answers quoted content as `text/html`, so `&amp;` in the file is
 * `&amp;amp;` in the quote. The body it is searched in has neither.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    const known = ENTITIES[name];
    if (known !== undefined) return known;
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return whole;
  });
}

function authorOf(author: DriveCommentAuthor | undefined): string {
  const name = author?.displayName ?? author?.emailAddress ?? '';
  return name === '' ? 'Someone' : name;
}

/** A thread's comments in creation order, without the deleted and the empty. */
function entriesOf(comment: DriveComment): Entry[] {
  const all = [comment, ...(comment.replies ?? [])];
  return all
    .filter((one) => one.deleted !== true && (one.content ?? '').trim() !== '')
    .map((one) => ({
      author: authorOf(one.author),
      time: one.createdTime ?? '',
      text: (one.content ?? '').trim(),
    }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/**
 * The open threads of a Doc, anchored in `body`. Resolved and deleted threads
 * are not in the sidecar at all (MANUAL §6), and neither is a thread every one
 * of whose entries is gone.
 */
export function commentThreads(comments: readonly DriveComment[], body: string): Thread[] {
  const threads: Thread[] = [];
  for (const comment of comments) {
    if (comment.resolved === true || comment.deleted === true) continue;
    const entries = entriesOf(comment);
    if (entries.length === 0) continue;

    const quoted = decodeEntities(comment.quotedFileContent?.value ?? '').trim();
    const anchor = quoted === '' ? undefined : locate(body, quoted);
    threads.push({
      id: comment.id ?? '',
      kind: 'comment',
      created: comment.createdTime ?? '',
      // A comment whose text is nowhere in the body quotes the bare text and
      // sorts to the end (MANUAL §6).
      ...(anchor ?? (quoted === '' ? {} : { quote: quoted })),
      entries,
    });
  }
  return threads;
}

/** Every paragraph of a document, table cells included, in document order. */
function paragraphsOf(content: readonly StructuralElement[] | undefined): Paragraph[] {
  const out: Paragraph[] = [];
  for (const element of content ?? []) {
    if (element.paragraph !== undefined) out.push(element.paragraph);
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) out.push(...paragraphsOf(cell.content));
    }
  }
  return out;
}

/** The suggestion ids a value carries as `suggested…Changes`, in key order. */
function changeIds(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: string[] = [];
  for (const [key, changes] of Object.entries(value)) {
    if (!key.startsWith('suggested') || !key.endsWith('Changes')) continue;
    if (typeof changes === 'object' && changes !== null) out.push(...Object.keys(changes));
  }
  return out;
}

/** A paragraph's text as it reads with a set of runs kept. */
function textOf(runs: readonly TextRun[]): string {
  return runs
    .map((run) => run.content ?? '')
    .join('')
    .replaceAll(VERTICAL_TAB, '\n')
    .replace(/\n$/, '');
}

/**
 * The pending suggestions of a document, one thread each (MANUAL §6): two
 * suggestions in one paragraph are two threads, and each is rendered against
 * the paragraph as it stands — every suggested insertion dropped, every
 * suggested deletion kept — which is the same version the body is derived from.
 */
export function suggestionThreads(doc: DocsDocument, body: string): Thread[] {
  const threads: Thread[] = [];

  for (const paragraph of paragraphsOf(doc.body?.content)) {
    const runs = (paragraph.elements ?? [])
      .map((element) => element.textRun)
      .filter((run): run is TextRun => run !== undefined);

    // First appearance decides the order of two suggestions on one paragraph.
    const order = new Map<string, number>();
    const note = (id: string, at: number): void => {
      if (!order.has(id)) order.set(id, at);
    };
    for (const id of changeIds(paragraph)) note(id, -1);
    for (const [at, run] of runs.entries()) {
      for (const id of run.suggestedInsertionIds ?? []) note(id, at);
      for (const id of run.suggestedDeletionIds ?? []) note(id, at);
      for (const id of changeIds(run)) note(id, at);
    }
    if (order.size === 0) continue;

    const before = textOf(runs.filter((run) => (run.suggestedInsertionIds ?? []).length === 0));
    // A diff carries its own text, so only a formatting suggestion quotes the
    // anchor; the rest of what `locate` found places the thread either way.
    const { quote, ...place } = before === '' ? {} : (locate(body, before) ?? {});

    for (const [id, within] of [...order].sort((a, b) => a[1] - b[1])) {
      const after = textOf(
        runs.filter((run) => {
          const inserted = run.suggestedInsertionIds ?? [];
          if (inserted.length > 0 && !inserted.includes(id)) return false;
          return !(run.suggestedDeletionIds ?? []).includes(id);
        }),
      );
      const common: Thread = { id, kind: 'suggestion', created: '', within, ...place, entries: [] };
      // A suggestion that changes no text only restyles what is there, and a
      // diff of one line against itself says nothing (MANUAL §6).
      threads.push(
        before === after ? { ...common, quote: quote ?? before } : { ...common, before, after },
      );
    }
  }
  return threads;
}

/** Everything one Doc puts in its sidecar: the threads and the suggestions. */
export function threadsOf(
  doc: DocsDocument,
  comments: readonly DriveComment[],
  body: string,
): Thread[] {
  return [...commentThreads(comments, body), ...suggestionThreads(doc, body)];
}
