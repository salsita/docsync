import { describe, expect, it } from 'vitest';
import type { CommentAnchor, CommentThread, DocsDocument } from './api.js';
import {
  commentThreads,
  type DriveComment,
  placeThreads,
  suggestionThreads,
  threadsOf,
} from './comments.js';
import { fixtureComments, fixtureInlineDocument } from './fixtures.mock.js';
import { documentToMarkdown } from './to-markdown.js';

const ELEMENTS = '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4';
const body = documentToMarkdown(fixtureInlineDocument(ELEMENTS));

/** One run of a paragraph, spelled as the suggestions view answers it. */
interface Run {
  content: string;
  ins?: string[];
  del?: string[];
}

/** A document of as many paragraphs as it is given runs for. */
function document(paragraphs: readonly (readonly Run[])[]): DocsDocument {
  return {
    body: {
      content: paragraphs.map((runs, at) => ({
        startIndex: at + 1,
        endIndex: at + 2,
        paragraph: {
          elements: runs.map((run) => ({
            textRun: {
              content: run.content,
              ...(run.ins === undefined ? {} : { suggestedInsertionIds: run.ins }),
              ...(run.del === undefined ? {} : { suggestedDeletionIds: run.del }),
            },
          })),
        },
      })),
    },
  };
}

/** A document of one paragraph. */
function paragraph(runs: readonly Run[]): DocsDocument {
  return document([runs]);
}

describe('commentThreads', () => {
  const comments = fixtureComments(ELEMENTS);

  it('leaves out the resolved thread', () => {
    expect(comments.some((comment) => comment.resolved === true)).toBe(true);
    expect(commentThreads(comments, body).map((thread) => thread.id)).toEqual([
      'AAACGgFBsWQ',
      'AAACFLfYEtk',
    ]);
  });

  it('anchors a comment on the paragraph its quoted text is in', () => {
    const thread = commentThreads(comments, body).find((one) => one.id === 'AAACFLfYEtk');

    expect(thread?.quote).toBe('Paragraph before a page break.');
    expect(thread?.heading).toBe('Heading six');
    const [start, end] = thread?.mark ?? [0, 0];
    expect(thread?.quote?.slice(start, end)).toBe('page break');
  });

  it('reads the thread and its replies as entries in creation order', () => {
    const thread = commentThreads(comments, body).find((one) => one.id === 'AAACGgFBsWQ');

    expect(thread?.entries).toEqual([
      { author: 'Jiří Staniševský', time: '2026-09-03T16:20:01.600Z', text: 'seven?' },
      { author: 'Jiří Staniševský', time: '2026-09-03T16:20:07.440Z', text: 'How childish...' },
    ]);
  });

  it('quotes the bare text of a comment whose anchor is gone from the body', () => {
    const gone: DriveComment = {
      id: 'AAAgone',
      createdTime: '2026-01-01T00:00:00.000Z',
      author: { displayName: 'Jane Client' },
      content: 'Still relevant?',
      quotedFileContent: { value: 'a sentence that was deleted' },
    };

    const [thread] = commentThreads([gone], body);
    expect(thread?.quote).toBe('a sentence that was deleted');
    expect(thread?.offset).toBeUndefined();
    expect(thread?.mark).toBeUndefined();
  });

  it('leaves out a deleted entry and one that only resolved the thread', () => {
    const comment: DriveComment = {
      id: 'AAAmixed',
      createdTime: '2026-01-01T00:00:00.000Z',
      author: { displayName: 'Jane Client' },
      content: 'First',
      quotedFileContent: { value: 'Final paragraph.' },
      replies: [
        { createdTime: '2026-01-02T00:00:00.000Z', content: 'gone', deleted: true },
        { createdTime: '2026-01-03T00:00:00.000Z', content: '', action: 'resolve' },
        {
          createdTime: '2026-01-04T00:00:00.000Z',
          author: { displayName: 'Jo' },
          content: 'Second',
        },
      ],
    };

    expect(commentThreads([comment], body)[0]?.entries.map((entry) => entry.text)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('anchors a comment whose selection ran over a paragraph break (ticket 34)', () => {
    const across: DriveComment = {
      id: 'AAAacross',
      createdTime: '2026-01-01T00:00:00.000Z',
      author: { displayName: 'Jane Client' },
      content: 'Both of these.',
      quotedFileContent: { value: 'before a page break. Paragraph after a page break' },
    };

    const [thread] = commentThreads([across], body);
    expect(thread?.quote).toBe('Paragraph before a page break.\n\nParagraph after a page break.');
    const [start, end] = thread?.mark ?? [0, 0];
    expect(thread?.quote?.slice(start, end)).toBe(
      'before a page break.\n\nParagraph after a page break',
    );
    expect(thread?.heading).toBe('Heading six');
  });

  it('decodes the entities Drive puts in quoted content', () => {
    const comment: DriveComment = {
      id: 'AAAentity',
      createdTime: '2026-01-01T00:00:00.000Z',
      content: 'x',
      quotedFileContent: { value: '{braces} &amp; &lt;angle&gt;' },
    };

    expect(commentThreads([comment], body)[0]?.quote).toContain('{braces} & <angle>');
  });
});

describe('suggestionThreads', () => {
  it('reads the two suggestions of the Elements document, in document order', () => {
    const threads = suggestionThreads(fixtureInlineDocument(ELEMENTS), body);

    expect(threads.map((thread) => thread.id)).toEqual([
      'suggest.4kz5rsdhutcs',
      'suggest.r73ve12ed25a',
    ]);
    expect(threads.map((thread) => thread.before)).toEqual([
      ["Let's us collaborate on this text."],
      ["Let's us collaborate on this text."],
    ]);
    expect(threads.map((thread) => thread.after)).toEqual([
      ["Let's collaborate on this text."],
      ["Let's us collaborate on the paragraph."],
    ]);
    expect(threads.map((thread) => thread.heading)).toEqual(['Heading six', 'Heading six']);
  });

  it('drops an inserted run from the paragraph as it stands and keeps a deleted one', () => {
    const threads = suggestionThreads(
      paragraph([
        { content: 'A ' },
        { content: 'new ', ins: ['suggest.x'] },
        { content: 'old ', del: ['suggest.x'] },
        { content: 'word.\n' },
      ]),
      'A old word.\n',
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.before).toEqual(['A old word.']);
    expect(threads[0]?.after).toEqual(['A new word.']);
  });

  it('reads a run that two suggestions touch as two threads', () => {
    const threads = suggestionThreads(
      paragraph([
        { content: 'One ' },
        { content: 'two ', del: ['suggest.a'] },
        { content: 'three', del: ['suggest.b'] },
        { content: '.\n' },
      ]),
      'One two three.\n',
    );

    expect(threads.map((thread) => thread.after)).toEqual([['One three.'], ['One two .']]);
  });

  it('calls a suggestion that changes no text formatting only', () => {
    const document = paragraph([{ content: 'Restyled.\n' }]);
    const run = document.body?.content?.[0]?.paragraph?.elements?.[0]?.textRun;
    if (run !== undefined) {
      (run as Record<string, unknown>).suggestedTextStyleChanges = { 'suggest.style': {} };
    }

    const [thread] = suggestionThreads(document, 'Restyled.\n');
    expect(thread?.id).toBe('suggest.style');
    expect(thread?.before).toBeUndefined();
    expect(thread?.quote).toBe('Restyled.');
  });

  it('answers nothing for a document with no pending suggestion', () => {
    expect(suggestionThreads(paragraph([{ content: 'Plain.\n' }]), 'Plain.\n')).toEqual([]);
  });
});

/**
 * A suggestion is one id over however many paragraphs its runs sit in, and one
 * thread over the span of them (MANUAL §6, ticket 34).
 */
describe('a suggestion that spans paragraphs', () => {
  it('is one thread whose `+` side has a line per paragraph it made', () => {
    // What an `insertText` of two new paragraphs leaves behind: the run that
    // was split, the new paragraph, and the tail, all under the one id.
    const threads = suggestionThreads(
      document([
        [{ content: 'One.\n' }],
        [{ content: 'Two. ' }, { content: 'Added.\n', ins: ['suggest.s1'] }],
        [{ content: 'And more.\n', ins: ['suggest.s1'] }],
        [{ content: 'Rest.', ins: ['suggest.s1'] }, { content: 'Three.\n' }],
      ]),
      'One.\n\nTwo. Three.\n',
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('suggest.s1');
    expect(threads[0]?.before).toEqual(['Two. ', '', 'Three.']);
    expect(threads[0]?.after).toEqual(['Two. Added.', 'And more.', 'Rest.Three.']);
    // Anchored on the first block it touches, which is what `in:` names.
    expect(threads[0]?.offset).toBe('One.\n\n'.length);
  });

  it('is one thread when it deletes across a paragraph break', () => {
    const threads = suggestionThreads(
      document([
        [{ content: 'Keep. ' }, { content: 'Gone.\n', del: ['suggest.s1'] }],
        [{ content: 'Also gone.\n', del: ['suggest.s1'] }],
        [{ content: 'End.', del: ['suggest.s1'] }, { content: ' Stay.\n' }],
      ]),
      'Keep. Gone.\n\nAlso gone.\n\nEnd. Stay.\n',
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.before).toEqual(['Keep. Gone.', 'Also gone.', 'End. Stay.']);
    expect(threads[0]?.after).toEqual(['Keep. ', '', ' Stay.']);
  });

  it('prints a paragraph in between that the suggestion does not touch', () => {
    const threads = suggestionThreads(
      document([
        [{ content: 'First. ' }, { content: 'cut', del: ['suggest.s1'] }, { content: '\n' }],
        [{ content: 'Untouched.\n' }],
        [{ content: 'Last. ' }, { content: 'also cut', del: ['suggest.s1'] }, { content: '\n' }],
      ]),
      'First. cut\n\nUntouched.\n\nLast. also cut\n',
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]?.before).toEqual(['First. cut', 'Untouched.', 'Last. also cut']);
    expect(threads[0]?.after).toEqual(['First. ', 'Untouched.', 'Last. ']);
  });

  it('keeps two ids in one paragraph two threads, each with only its own change', () => {
    const threads = suggestionThreads(
      document([
        [
          { content: 'One ' },
          { content: 'two ', del: ['suggest.a'] },
          { content: 'three', del: ['suggest.b'] },
          { content: '.\n' },
        ],
        [{ content: 'Next ' }, { content: 'word', del: ['suggest.b'] }, { content: '.\n' }],
      ]),
      'One two three.\n\nNext word.\n',
    );

    expect(threads.map((thread) => thread.id)).toEqual(['suggest.a', 'suggest.b']);
    expect(threads[0]?.before).toEqual(['One two three.']);
    expect(threads[1]?.before).toEqual(['One two three.', 'Next word.']);
    expect(threads[1]?.after).toEqual(['One two .', 'Next .']);
  });

  it('quotes every block a formatting-only suggestion touches, joined by a blank line', () => {
    const doc = document([[{ content: 'First.\n' }], [{ content: 'Second.\n' }]]);
    for (const element of doc.body?.content ?? []) {
      const run = element.paragraph?.elements?.[0]?.textRun;
      if (run !== undefined) {
        (run as Record<string, unknown>).suggestedTextStyleChanges = { 'suggest.style': {} };
      }
    }

    const [thread] = suggestionThreads(doc, 'First.\n\nSecond.\n');
    expect(thread?.id).toBe('suggest.style');
    expect(thread?.before).toBeUndefined();
    expect(thread?.quote).toBe('First.\n\nSecond.');
  });
});

describe('placeThreads (MANUAL §6, ticket 37)', () => {
  /** Two tabs, each one paragraph, as a Doc with several tabs answers. */
  const tabs = [
    {
      doc: paragraph([{ content: 'The first tab says this.\n' }]),
      body: 'The first tab says this.',
    },
    {
      doc: paragraph([{ content: 'The second tab says that.\n' }]),
      body: 'The second tab says that.',
    },
  ];

  const comment = (id: string, quoted: string): DriveComment => ({
    id,
    createdTime: '2026-09-03T07:55:00Z',
    author: { displayName: 'Jane' },
    content: 'A word about this.',
    quotedFileContent: { mimeType: 'text/html', value: quoted },
  });

  it('puts a thread in the first tab whose body holds its quote', () => {
    // Drive comments are per file and their anchors carry no tab, so the
    // quoted text is what says which tab a thread belongs to (ticket 37).
    const placed = placeThreads(tabs, [comment('c1', 'says that'), comment('c2', 'says this')]);

    expect(placed[0]?.map((one) => one.id)).toEqual(['c2']);
    expect(placed[1]?.map((one) => one.id)).toEqual(['c1']);
  });

  it('puts a thread that is placed nowhere in the first tab', () => {
    const placed = placeThreads(tabs, [comment('c3', 'nothing like this text')]);

    expect(placed[0]?.map((one) => one.id)).toEqual(['c3']);
    expect(placed[1]).toEqual([]);
    // And it is still the unplaceable thread it was: the bare text, no anchor.
    expect(placed[0]?.[0]?.quote).toBe('nothing like this text');
    expect(placed[0]?.[0]?.offset).toBeUndefined();
  });

  it('keeps the suggestions of a tab in that tab', () => {
    const suggesting = [
      {
        doc: paragraph([{ content: 'One.' }, { content: ' Added.', ins: ['s.1'] }]),
        body: 'One.',
      },
      {
        doc: paragraph([{ content: 'Two.' }, { content: ' Also.', ins: ['s.2'] }]),
        body: 'Two.',
      },
    ];

    const placed = placeThreads(suggesting, []);

    // A suggestion belongs to the tab whose body carries it, by construction.
    expect(placed[0]?.map((one) => one.id)).toEqual(['s.1']);
    expect(placed[1]?.map((one) => one.id)).toEqual(['s.2']);
  });

  it('is the threads of the one document when there is one tab', () => {
    const one = [{ doc: fixtureInlineDocument(ELEMENTS), body }];

    expect(placeThreads(one, fixtureComments(ELEMENTS))[0]).toEqual(
      threadsOf(fixtureInlineDocument(ELEMENTS), fixtureComments(ELEMENTS), body),
    );
  });
});

/**
 * The Docs API answers the discussions the Drive comments API has no idea
 * about, and exact anchors with them (MANUAL §6, ticket 40).
 */
describe('threads from the Docs reply (ticket 40)', () => {
  /** A tab body of whole paragraphs, with the indices the API counts in. */
  function tabDocument(
    paragraphs: readonly string[],
    anchors: Record<string, CommentAnchor> = {},
  ): DocsDocument {
    let index = 1;
    const content = paragraphs.map((text) => {
      const start = index;
      const run = `${text}\n`;
      index += run.length;
      return {
        startIndex: start,
        endIndex: index,
        paragraph: {
          elements: [{ startIndex: start, endIndex: index, textRun: { content: run } }],
        },
      };
    });
    return {
      documentId: 'doc1',
      body: { content },
      ...(Object.keys(anchors).length === 0 ? {} : { commentAnchors: anchors }),
    };
  }

  /** The anchor covering the `nth` occurrence of `text` in those paragraphs. */
  function anchorOn(
    id: string,
    paragraphs: readonly string[],
    text: string,
    nth = 0,
  ): CommentAnchor {
    let index = 1;
    let seen = 0;
    for (const paragraph of paragraphs) {
      for (let at = paragraph.indexOf(text); at >= 0; at = paragraph.indexOf(text, at + 1)) {
        if (seen === nth) {
          return {
            anchorId: id,
            ranges: [{ startIndex: index + at, endIndex: index + at + text.length }],
          };
        }
        seen += 1;
      }
      index += paragraph.length + 1;
    }
    throw new Error(`no occurrence ${nth} of ${text}`);
  }

  /** One thread of the Docs reply, in the shape a recorded reply has. */
  function docsComment(over: Partial<CommentThread> = {}): CommentThread {
    return {
      commentId: 'AAACHGuq504',
      status: 'OPEN',
      headPost: {
        postId: 'p1',
        content: 'Is three right?',
        contentHtml: '<p>Is three right?</p>',
        author: { displayName: 'Jane Client', user: 'users/1' },
        createTime: '2026-09-14T08:51:14.902Z',
        updateTime: '2026-09-14T08:51:14.902Z',
        commentAction: 'NO_COMMENT_ACTION_CHANGE',
      },
      replies: [],
      ...over,
    };
  }

  const rate = 'The rate is three hundred.';
  const first = ['Intro.', rate, 'Filler.'];
  const second = ['A heading of sorts.', rate, rate];
  const tabs = [
    { doc: tabDocument(first), body: documentToMarkdown(tabDocument(first)) },
    { doc: tabDocument(second), body: documentToMarkdown(tabDocument(second)) },
  ];

  /** The same two tabs, with the anchor of `kix.a` where the test puts it. */
  function anchored(tab: 0 | 1, nth: number): typeof tabs {
    const paragraphs = tab === 0 ? first : second;
    const anchor = anchorOn('kix.a', paragraphs, rate, nth);
    const doc = tabDocument(paragraphs, { 'kix.a': anchor });
    return tabs.map((one, at) => (at === tab ? { ...one, doc } : one)) as typeof tabs;
  }

  it('reads a thread, its status, its quote and its posts', () => {
    const placed = placeThreads(tabs, [], {
      comments: [
        docsComment({
          plainTextQuote: rate,
          replies: [
            {
              postId: 'p2',
              content: 'Three it is.',
              author: { displayName: 'Jiří Staniševský', user: 'users/2' },
              createTime: '2026-09-14T09:02:00.000Z',
            },
          ],
        }),
      ],
    });

    expect(placed[0]?.[0]).toMatchObject({
      id: 'AAACHGuq504',
      kind: 'comment',
      created: '2026-09-14T08:51:14.902Z',
      quote: rate,
      entries: [
        { author: 'Jane Client', time: '2026-09-14T08:51:14.902Z', text: 'Is three right?' },
        { author: 'Jiří Staniševský', time: '2026-09-14T09:02:00.000Z', text: 'Three it is.' },
      ],
    });
  });

  it('is the same thread the Drive comments API gave (MANUAL §6)', () => {
    // `comments[].commentId` is the id Drive answers, so a sidecar written from
    // the Docs reply keeps the headings and the order it already had.
    const one = [{ doc: fixtureInlineDocument(ELEMENTS), body }];
    const drive = fixtureComments(ELEMENTS).filter((thread) => thread.resolved !== true);
    const docs: CommentThread[] = drive.map((thread) => ({
      commentId: thread.id ?? '',
      status: 'OPEN',
      plainTextQuote: thread.quotedFileContent?.value ?? '',
      headPost: {
        content: thread.content ?? '',
        author: { displayName: thread.author?.displayName ?? '' },
        createTime: thread.createdTime ?? '',
      },
      replies: (thread.replies ?? [])
        .filter((reply) => (reply.content ?? '') !== '')
        .map((reply) => ({
          content: reply.content ?? '',
          author: { displayName: reply.author?.displayName ?? '' },
          createTime: reply.createdTime ?? '',
        })),
    }));

    expect(placeThreads(one, [], { comments: docs })[0]).toEqual(
      placeThreads(one, fixtureComments(ELEMENTS))[0],
    );
  });

  it('leaves a resolved thread and an empty one out', () => {
    const placed = placeThreads(tabs, [], {
      comments: [
        docsComment({ commentId: 'closed', status: 'RESOLVED', plainTextQuote: rate }),
        docsComment({
          commentId: 'silent',
          plainTextQuote: rate,
          headPost: { postId: 'p', createTime: '2026-09-14T08:00:00Z' },
        }),
      ],
    });

    expect(placed.flat()).toEqual([]);
  });

  it('places an anchored thread in the tab its anchor sits in', () => {
    // The quote alone would put it in the first tab, which is where the first
    // copy of that sentence is; the anchor says otherwise (MANUAL §6).
    const placed = placeThreads(anchored(1, 0), [], {
      comments: [docsComment({ anchorId: 'kix.a', plainTextQuote: rate })],
    });

    expect(placed[0]).toEqual([]);
    expect(placed[1]?.[0]?.offset).toBe(tabs[1]?.body.indexOf(rate));
  });

  it('places it at the occurrence the ranges cover, not at the first one', () => {
    const placed = placeThreads(anchored(1, 1), [], {
      comments: [docsComment({ anchorId: 'kix.a', plainTextQuote: rate })],
    });

    // Two identical paragraphs, and the anchor is on the second of them.
    expect(placed[1]?.[0]?.offset).toBe(tabs[1]?.body.lastIndexOf(rate));
  });

  it('marks exactly the words the ranges cover', () => {
    const anchor = anchorOn('kix.a', first, 'three hundred');
    const doc = tabDocument(first, { 'kix.a': anchor });
    const placed = placeThreads([{ doc, body: tabs[0]?.body ?? '' }], [], {
      comments: [docsComment({ anchorId: 'kix.a', plainTextQuote: 'three hundred' })],
    });
    const thread = placed[0]?.[0];
    const [start, end] = thread?.mark ?? [0, 0];

    expect(thread?.quote?.slice(start, end)).toBe('three hundred');
  });

  it('falls back to the quote when the thread has no anchor', () => {
    // The text the comment was on has been deleted since, so the tab has no
    // `commentAnchors` entry for it (MANUAL §6).
    const placed = placeThreads(anchored(1, 0), [], {
      comments: [docsComment({ anchorId: 'kix.gone', plainTextQuote: rate })],
    });

    expect(placed[0]?.[0]?.offset).toBe(tabs[0]?.body.indexOf(rate));
    expect(placed[1]).toEqual([]);
  });

  it('falls back to the quote when the anchored text is not in the body', () => {
    // The anchor is on text a suggestion proposes, which the body does not hold.
    const doc = tabDocument(first, {
      'kix.a': { anchorId: 'kix.a', ranges: [{ startIndex: 9000, endIndex: 9010 }] },
    });
    const placed = placeThreads([{ doc, body: tabs[0]?.body ?? '' }], [], {
      comments: [docsComment({ anchorId: 'kix.a', plainTextQuote: rate })],
    });

    expect(placed[0]?.[0]?.offset).toBe(tabs[0]?.body.indexOf(rate));
  });

  it('gives a suggestion its summary line and its discussion', () => {
    const doc = paragraph([
      { content: 'The rate is ' },
      { content: 'one', del: ['suggest.frjnz76h4q08'] },
      { content: 'three', ins: ['suggest.frjnz76h4q08'] },
      { content: ' hundred.' },
    ]);
    const placed = placeThreads([{ doc, body: 'The rate is one hundred.' }], [], {
      suggestions: [
        {
          suggestionId: 'suggest.frjnz76h4q08',
          status: 'OPEN',
          summaryText: 'Replace: “one” with “three”',
          summaryHtml: '<p>Replace: “one” with “three”</p>',
          // The head post is the suggestion itself and carries no text.
          headPost: {
            postId: 'h',
            author: { displayName: 'Nazarii Makhovyk' },
            createTime: '2026-09-14T08:51:14.902Z',
            suggestionAction: 'NO_SUGGESTION_ACTION_CHANGE',
          },
          replies: [
            {
              postId: 'r1',
              content: 'The price lock stays.',
              author: { displayName: 'Jane Client' },
              createTime: '2026-09-14T09:00:00.000Z',
            },
            {
              postId: 'r2',
              content: 'Agreed.',
              author: { displayName: 'Jiří Staniševský' },
              createTime: '2026-09-14T09:05:00.000Z',
            },
          ],
        },
      ],
    });

    expect(placed[0]?.[0]).toMatchObject({
      id: 'suggest.frjnz76h4q08',
      kind: 'suggestion',
      summary: 'Replace: “one” with “three”',
      before: ['The rate is one hundred.'],
      after: ['The rate is three hundred.'],
      entries: [
        { author: 'Jane Client', time: '2026-09-14T09:00:00.000Z', text: 'The price lock stays.' },
        { author: 'Jiří Staniševský', time: '2026-09-14T09:05:00.000Z', text: 'Agreed.' },
      ],
    });
  });

  it('leaves a suggestion the reply says nothing about as it was', () => {
    const doc = paragraph([{ content: 'One.' }, { content: ' Added.', ins: ['suggest.s1'] }]);
    const plain = placeThreads([{ doc, body: 'One.' }], []);

    expect(placeThreads([{ doc, body: 'One.' }], [], { suggestions: [] })).toEqual(plain);
    expect(plain[0]?.[0]?.summary).toBeUndefined();
    expect(plain[0]?.[0]?.entries).toEqual([]);
  });
});
