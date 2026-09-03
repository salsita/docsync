import { describe, expect, it } from 'vitest';
import type { DocsDocument } from './api.js';
import { commentThreads, type DriveComment, suggestionThreads } from './comments.js';
import { fixtureComments, fixtureInlineDocument } from './fixtures.mock.js';
import { documentToMarkdown } from './to-markdown.js';

const ELEMENTS = '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4';
const body = documentToMarkdown(fixtureInlineDocument(ELEMENTS));

/** A document of one paragraph, spelled as the suggestions view answers it. */
function paragraph(
  runs: readonly { content: string; ins?: string[]; del?: string[] }[],
): DocsDocument {
  return {
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 2,
          paragraph: {
            elements: runs.map((run) => ({
              textRun: {
                content: run.content,
                ...(run.ins === undefined ? {} : { suggestedInsertionIds: run.ins }),
                ...(run.del === undefined ? {} : { suggestedDeletionIds: run.del }),
              },
            })),
          },
        },
      ],
    },
  };
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
      "Let's us collaborate on this text.",
      "Let's us collaborate on this text.",
    ]);
    expect(threads.map((thread) => thread.after)).toEqual([
      "Let's collaborate on this text.",
      "Let's us collaborate on the paragraph.",
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
    expect(threads[0]?.before).toBe('A old word.');
    expect(threads[0]?.after).toBe('A new word.');
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

    expect(threads.map((thread) => thread.after)).toEqual(['One three.', 'One two .']);
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
