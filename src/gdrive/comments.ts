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
 * Asked with `commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED` as well (ticket
 * 40), that same response answers three things Drive cannot: the comment
 * threads under the ids Drive gives them, the *discussion* on each suggestion —
 * the replies under its card, which `comments.list` does not return at all —
 * and, per tab, where each comment is anchored, to the character. It is a
 * Developer Preview parameter, so every one of them is optional here and the
 * Drive threads are what a checkout without the preview is built from.
 *
 * Pure: recorded JSON and a body in, threads out. No requests, no clock.
 */
import type { Entry, Thread } from '../comments/format.js';
import { type Anchor, locate, occurrencesBefore, placeOf } from '../comments/locate.js';
import type {
  CommentAnchor,
  CommentPost,
  CommentThread,
  DocsDocument,
  DriveComment,
  DriveCommentAuthor,
  Paragraph,
  StructuralElement,
  SuggestionThread,
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

/* ------------------------------------------- the Docs API's own discussions */

/**
 * What one read with `commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED` adds
 * (MANUAL §6, ticket 40).
 *
 * A `DocsDocument` is one of these; the fields are absent when the read did not
 * ask for them, and absent when the document has none — which is why every
 * caller falls back per field rather than on a flag.
 */
export interface Discussions {
  comments?: readonly CommentThread[];
  suggestions?: readonly SuggestionThread[];
}

/** A discussion's posts as sidecar entries: the ones that say something. */
function postsOf(posts: readonly (CommentPost | undefined)[]): Entry[] {
  return posts
    .filter((post): post is CommentPost => post !== undefined)
    .filter((post) => post.deleted !== true && (post.content ?? '').trim() !== '')
    .map((post) => ({
      author:
        post.author?.displayName === undefined || post.author.displayName === ''
          ? 'Someone'
          : post.author.displayName,
      time: post.createTime ?? '',
      // `content` is plain text and `contentHtml` is the escaped one, so a
      // literal `&amp;` somebody typed stays what they typed (probed
      // 2026-09-16). Only the quote is escaped, as Drive escapes it.
      text: (post.content ?? '').trim(),
    }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/**
 * One tab's text as the Markdown body has it, with the live indices kept
 * (MANUAL §6, ticket 40).
 *
 * A comment anchor's ranges are indices into the tab as the API answers it,
 * suggested insertions and all; the body on disk is the same text *without*
 * them (ticket 16). So the inserted runs are left out here and the runs that
 * remain carry where they start in the document and where they land in this
 * string, which is what turns a range into a piece of the body.
 */
interface TabText {
  text: string;
  runs: { start: number; at: number; text: string }[];
}

function tabTextOf(doc: DocsDocument): TabText {
  const runs: TabText['runs'] = [];
  let text = '';
  for (const paragraph of paragraphsOf(doc.body?.content)) {
    for (const element of paragraph.elements ?? []) {
      const run = element.textRun;
      if (run === undefined || (run.suggestedInsertionIds ?? []).length > 0) continue;
      const content = run.content ?? '';
      runs.push({ start: element.startIndex ?? 0, at: text.length, text: content });
      text += content;
    }
  }
  return { text, runs };
}

/** The text an anchor's ranges cover, and where it starts in the tab's text. */
function anchoredText(
  tab: TabText,
  anchor: CommentAnchor,
): { quote: string; at: number } | undefined {
  const ranges = [...(anchor.ranges ?? [])].sort(
    (a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0),
  );
  let quote = '';
  let at: number | undefined;
  for (const range of ranges) {
    const from = range.startIndex ?? 0;
    const to = range.endIndex ?? from;
    for (const run of tab.runs) {
      const end = run.start + run.text.length;
      if (end <= from || run.start >= to) continue;
      const start = Math.max(from, run.start);
      if (at === undefined) at = run.at + (start - run.start);
      quote += run.text.slice(start - run.start, Math.min(to, end) - run.start);
    }
  }
  // A selection entirely inside text a suggestion proposes is on nothing the
  // body holds, and the quote search is what such a thread falls back to.
  return at === undefined || quote.trim() === '' ? undefined : { quote, at };
}

/** Where one anchored thread sits: which tab, and where in that tab's body. */
function byAnchor(
  anchorId: string | undefined,
  tabs: readonly TabBody[],
  texts: readonly TabText[],
): { at: number; place: ReturnType<typeof placeOf> } | undefined {
  if (anchorId === undefined || anchorId === '') return undefined;
  const at = tabs.findIndex((tab) => tab.doc.commentAnchors?.[anchorId] !== undefined);
  const anchor = tabs[at]?.doc.commentAnchors?.[anchorId];
  const text = texts[at];
  if (anchor === undefined || text === undefined) return undefined;
  const found = anchoredText(text, anchor);
  if (found === undefined) return undefined;
  // The ranges are exact and the body is the same text in another spelling, so
  // what carries the exactness across is which occurrence of it this is.
  const skip = occurrencesBefore(text.text, found.quote, found.at);
  const located = locate(tabs[at]?.body ?? '', found.quote, { skip });
  return located === undefined ? undefined : { at, place: placeOf(located) };
}

/** Where a thread goes when no anchor placed it: the first tab holding its quote. */
function byQuote(
  quoted: string,
  tabs: readonly TabBody[],
): { at: number; place: ReturnType<typeof placeOf> | { quote?: string } } {
  if (quoted === '') return { at: 0, place: {} };
  for (const [at, tab] of tabs.entries()) {
    const found = locate(tab.body, quoted);
    if (found !== undefined) return { at, place: placeOf(found) };
  }
  // Nowhere in any tab: the bare text is quoted and the thread sorts to the end
  // of the first tab's sidecar (MANUAL §6).
  return { at: 0, place: { quote: quoted } };
}

/** One comment thread of the Docs reply, placed in the tab its anchor names. */
function docsCommentThreads(
  threads: readonly CommentThread[],
  tabs: readonly TabBody[],
  texts: readonly TabText[],
): Thread[][] {
  const out: Thread[][] = tabs.map(() => []);
  for (const comment of threads) {
    // `status` is what says a thread is open; a resolved one is not in the
    // sidecar at all, and neither is one nobody said anything in (MANUAL §6).
    if ((comment.status ?? 'OPEN') !== 'OPEN') continue;
    const entries = postsOf([comment.headPost, ...(comment.replies ?? [])]);
    if (entries.length === 0) continue;

    const quoted = decodeEntities(comment.plainTextQuote ?? '').trim();
    const found = byAnchor(comment.anchorId, tabs, texts) ?? byQuote(quoted, tabs);
    out[found.at]?.push({
      id: comment.commentId ?? '',
      kind: 'comment',
      created: comment.headPost?.createTime ?? '',
      ...found.place,
      entries,
    });
  }
  return out;
}

/** A suggestion thread with what the Docs API says about its discussion. */
function discussed(thread: Thread, discussion: SuggestionThread | undefined): Thread {
  if (discussion === undefined) return thread;
  // `summaryText` is the plain half of `summaryHtml`, as `content` is of
  // `contentHtml`: nothing to decode.
  const summary = (discussion.summaryText ?? '').trim();
  const entries = postsOf([discussion.headPost, ...(discussion.replies ?? [])]);
  return {
    ...thread,
    ...(summary === '' ? {} : { summary }),
    ...(entries.length === 0 ? {} : { entries }),
  };
}

/** One tab of a Doc, as a sidecar is built for it (MANUAL §6, ticket 37). */
export interface TabBody {
  doc: DocsDocument;
  body: string;
}

/**
 * The threads of a Doc, split across its tabs (MANUAL §6, tickets 37 and 40).
 *
 * With the preview's `comments[]` in hand, a thread is placed by its anchor:
 * the tab whose `commentAnchors` holds the id, and inside it the exact
 * characters the ranges cover — which is what tells two identical sentences
 * apart where the quoted text alone cannot. A thread whose anchor is gone,
 * because the text it was on has been deleted since, falls back to the search
 * by quote, and so does every thread when the preview is not there: Drive holds
 * a comment against the *file*, with an opaque anchor that names no tab, so the
 * thread goes to the first tab, in tab order, whose body holds its quote, and a
 * thread placed nowhere goes to the first tab's sidecar.
 *
 * Suggestions need no such rule: each one is in the tab whose body carries it.
 * What the preview adds to them is their discussion and their summary line.
 */
export function placeThreads(
  tabs: readonly TabBody[],
  comments: readonly DriveComment[],
  discussions: Discussions = {},
): Thread[][] {
  // One source for both, when there is one: `comments[]` is the same thread
  // under the same id Drive answers, so the headings and the index do not move.
  // Without it nothing walks the tabs' runs at all.
  const placed =
    discussions.comments === undefined
      ? driveCommentThreads(tabs, comments)
      : docsCommentThreads(
          discussions.comments,
          tabs,
          tabs.map((tab) => tabTextOf(tab.doc)),
        );

  const byId = new Map(
    (discussions.suggestions ?? []).map((one): [string, SuggestionThread] => [
      one.suggestionId ?? '',
      one,
    ]),
  );
  return tabs.map((tab, at) => [
    ...(placed[at] ?? []),
    ...suggestionThreads(tab.doc, tab.body).map((thread) => discussed(thread, byId.get(thread.id))),
  ]);
}

/** The Drive threads of a Doc, placed per tab by the text each one quotes. */
function driveCommentThreads(
  tabs: readonly TabBody[],
  comments: readonly DriveComment[],
): Thread[][] {
  const mine: DriveComment[][] = tabs.map(() => []);
  for (const comment of comments) {
    const quoted = decodeEntities(comment.quotedFileContent?.value ?? '').trim();
    const at = quoted === '' ? 0 : tabs.findIndex((tab) => locate(tab.body, quoted) !== undefined);
    mine[at === -1 ? 0 : at]?.push(comment);
  }
  return tabs.map((tab, at) => commentThreads(mine[at] ?? [], tab.body));
}
