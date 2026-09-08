import { describe, expect, it } from 'vitest';
import type { DocsDocument } from './api.js';
import { commentThreads, type DriveComment, suggestionThreads } from './comments.js';
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
