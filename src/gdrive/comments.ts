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
import { type Anchor, locate, placeOf } from '../comments/locate.js';
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
      ...(anchor === undefined ? (quoted === '' ? {} : { quote: quoted }) : placeOf(anchor)),
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

/** One paragraph of the document, as the suggestions view answers it. */
interface Block {
  runs: TextRun[];
  /** The suggestion ids this paragraph carries, and where each first appears. */
  ids: Map<string, number>;
  /** The paragraph as it stands: every suggested insertion dropped. */
  before: string;
}

/** The paragraphs of a document, with the suggestions each one carries. */
function blocksOf(doc: DocsDocument): Block[] {
  const out: Block[] = [];
  // A position that only grows, so that ids order by where they first appear in
  // the document rather than inside one paragraph (MANUAL §6).
  let seen = 0;

  for (const paragraph of paragraphsOf(doc.body?.content)) {
    const runs = (paragraph.elements ?? [])
      .map((element) => element.textRun)
      .filter((run): run is TextRun => run !== undefined);

    const ids = new Map<string, number>();
    const note = (id: string, at: number): void => {
      if (!ids.has(id)) ids.set(id, at);
    };
    for (const id of changeIds(paragraph)) note(id, seen);
    for (const run of runs) {
      seen += 1;
      for (const id of run.suggestedInsertionIds ?? []) note(id, seen);
      for (const id of run.suggestedDeletionIds ?? []) note(id, seen);
      for (const id of changeIds(run)) note(id, seen);
    }
    out.push({
      runs,
      ids,
      before: textOf(runs.filter((run) => (run.suggestedInsertionIds ?? []).length === 0)),
    });
  }
  return out;
}

/** A block as it would read with exactly one suggestion accepted. */
function acceptedIn(block: Block, id: string): string {
  return textOf(
    block.runs.filter((run) => {
      const inserted = run.suggestedInsertionIds ?? [];
      if (inserted.length > 0 && !inserted.includes(id)) return false;
      return !(run.suggestedDeletionIds ?? []).includes(id);
    }),
  );
}

/**
 * The pending suggestions of a document, one thread per suggestion id
 * (MANUAL §6, ticket 34).
 *
 * A suggestion is one id in the Docs API and one card in Docs, tagged on every
 * run it inserted or deleted — and those runs can sit in several paragraphs.
 * So the thread is the id, and its diff is the span of blocks the id touches,
 * first to last: each of them as it stands and as it would read with this one
 * suggestion accepted, and any block in between that the id does not touch
 * printed unchanged. Two ids in one paragraph are still two threads, each
 * rendered with only its own changes applied.
 *
 * The thread is anchored on the first block it touches: that is what `in:`
 * names and what the sidecar orders by.
 */
export function suggestionThreads(doc: DocsDocument, body: string): Thread[] {
  const blocks = blocksOf(doc);

  // Every id, with the blocks it touches and where it first appears.
  const spans = new Map<string, { first: number; last: number; within: number }>();
  for (const [at, block] of blocks.entries()) {
    for (const [id, within] of block.ids) {
      const span = spans.get(id);
      if (span === undefined) spans.set(id, { first: at, last: at, within });
      else span.last = at;
    }
  }

  const threads: Thread[] = [];
  for (const [id, { first, last, within }] of [...spans].sort(
    (a, b) => a[1].within - b[1].within,
  )) {
    const span = blocks.slice(first, last + 1);
    const before = span.map((block) => block.before);
    const after = span.map((block) => (block.ids.has(id) ? acceptedIn(block, id) : block.before));

    // A diff carries its own text, so only a formatting suggestion quotes the
    // blocks; where the first of them sits is what places the thread either way.
    const anchor = anchorOf(body, before);
    const place =
      anchor === undefined
        ? {}
        : {
            offset: anchor.offset,
            ...(anchor.heading === undefined ? {} : { heading: anchor.heading }),
          };
    const common: Thread = { id, kind: 'suggestion', created: '', within, ...place, entries: [] };

    // A suggestion that changes no text only restyles what is there, and a diff
    // of a block against itself says nothing (MANUAL §6): it is quoted instead,
    // every block it touches, joined by a blank line.
    threads.push(
      before.every((text, at) => text === after[at])
        ? { ...common, quote: quoteOf(body, span, id, anchor) }
        : { ...common, before, after },
    );
  }
  return threads;
}

/**
 * Where a suggestion's span sits in the body: the first block of it that has
 * text to search for. A block a suggestion invented whole is not in the body at
 * all, so it cannot be the one that is looked up.
 */
function anchorOf(body: string, before: readonly string[]): Anchor | undefined {
  for (const text of before) {
    if (text === '') continue;
    return locate(body, text);
  }
  return undefined;
}

/**
 * A formatting-only suggestion's quote: every block it touches, as the body
 * writes it, joined by a blank line (MANUAL §6).
 */
function quoteOf(
  body: string,
  span: readonly Block[],
  id: string,
  anchor: Anchor | undefined,
): string {
  const touched = span.filter((block) => block.ids.has(id));
  if (touched.length === 1) return anchor?.quote ?? touched[0]?.before ?? '';
  return touched.map((block) => locate(body, block.before)?.quote ?? block.before).join('\n\n');
}

/** Everything one Doc puts in its sidecar: the threads and the suggestions. */
export function threadsOf(
  doc: DocsDocument,
  comments: readonly DriveComment[],
  body: string,
): Thread[] {
  return [...commentThreads(comments, body), ...suggestionThreads(doc, body)];
}
