import { describe, expect, it } from 'vitest';
import {
  formatSidecar,
  isSidecarPath,
  sameButForFetched,
  sidecarPathOf,
  type Thread,
} from './format.js';

const later: Thread = {
  id: 'AAACFLfYEtk',
  kind: 'comment',
  offset: 300,
  created: '2026-09-03T07:55:12.165Z',
  quote: 'Paragraph before a page break.',
  mark: [19, 29],
  heading: 'Heading six',
  entries: [
    {
      author: 'Jiří Staniševský',
      time: '2026-09-03T07:55:12.165Z',
      text: 'Makes the page break.',
    },
    { author: 'Jane Client', time: '2026-09-03T09:12:44.000Z', text: 'Agreed, leave it.' },
  ],
};

const earlier: Thread = {
  id: 'AAACGgFBsWQ',
  kind: 'comment',
  offset: 100,
  created: '2026-09-03T16:20:01.600Z',
  quote: '###### Heading six',
  mark: [15, 18],
  heading: 'Heading five',
  entries: [{ author: 'Jiří Staniševský', time: '2026-09-03T16:20:01.600Z', text: 'seven?' }],
};

const suggestion: Thread = {
  id: 'suggest.r73ve12ed25a',
  kind: 'suggestion',
  offset: 400,
  created: '',
  heading: 'Heading six',
  before: "Let's us collaborate on this text.",
  after: "Let's us collaborate on the paragraph.",
  entries: [],
};

/** Two threads on one paragraph: the same offset, so creation time decides. */
const alsoAt400: Thread = {
  id: 'suggest.4kz5rsdhutcs',
  kind: 'suggestion',
  offset: 400,
  created: '',
  heading: 'Heading six',
  before: "Let's us collaborate on this text.",
  after: "Let's collaborate on this text.",
  entries: [],
};

const formatting: Thread = {
  id: 'suggest.formatting',
  kind: 'suggestion',
  offset: 500,
  created: '',
  heading: 'Heading six',
  quote: 'Final paragraph.',
  entries: [],
};

/** Its anchor is nowhere in the body, so it sorts to the end (MANUAL §6). */
const lost: Thread = {
  id: 'AAAClost',
  kind: 'comment',
  created: '2026-09-01T08:00:00.000Z',
  quote: 'text that used to be there',
  entries: [{ author: 'Jane Client', time: '2026-09-01T08:00:00.000Z', text: 'Still relevant?' }],
};

const document = { source: 'gdocs', id: '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4' } as const;
const fetched = '2026-09-03T16:31:07Z';

describe('formatSidecar', () => {
  it('sorts by anchor, then by creation time, and puts the unlocatable last', () => {
    const text = formatSidecar({
      document,
      fetched,
      threads: [lost, formatting, suggestion, later, alsoAt400, earlier],
    });

    expect(text).toMatchSnapshot();
  });

  it('names every thread in document order under a `## ` heading', () => {
    const text = formatSidecar({
      document,
      fetched,
      threads: [lost, formatting, suggestion, later, alsoAt400, earlier],
    });

    expect(text.split('\n').filter((line) => line.startsWith('## '))).toEqual([
      '## AAACGgFBsWQ — comment',
      '## AAACFLfYEtk — comment',
      '## suggest.4kz5rsdhutcs — suggestion',
      '## suggest.r73ve12ed25a — suggestion',
      '## suggest.formatting — suggestion',
      '## AAAClost — comment',
    ]);
  });

  it('marks the quoted words and says which heading the anchor is under', () => {
    const text = formatSidecar({ document, fetched, threads: [later] });

    expect(text).toContain('> Paragraph before a ==page break==.\n\nin: Heading six\n');
  });

  it('says `(not found)` when the anchor is nowhere in the body', () => {
    expect(formatSidecar({ document, fetched, threads: [lost] })).toContain('in: (not found)');
  });

  it('says `(top)` when there is no heading above the anchor', () => {
    const top: Thread = { ...later, heading: undefined };

    expect(formatSidecar({ document, fetched, threads: [top] })).toContain('in: (top)');
  });

  it('renders a suggestion as a diff of the paragraph', () => {
    const text = formatSidecar({ document, fetched, threads: [suggestion] });

    expect(text).toContain(
      "```diff\n- Let's us collaborate on this text.\n+ Let's us collaborate on the paragraph.\n```\n",
    );
  });

  it('renders a formatting-only suggestion as the quoted paragraph', () => {
    const text = formatSidecar({ document, fetched, threads: [formatting] });

    expect(text).toContain('> Final paragraph.\n\nin: Heading six\n\nformatting only\n');
  });

  it('prints an entry as author, minute and body', () => {
    expect(formatSidecar({ document, fetched, threads: [earlier] })).toContain(
      '**Jiří Staniševský** · 2026-09-03 16:20\nseven?\n',
    );
  });

  it('opens with the document ref and the time of the fetch', () => {
    expect(
      formatSidecar({ document, fetched, threads: [earlier] })
        .split('\n')
        .slice(0, 4),
    ).toEqual([
      '---',
      'document: gdocs:1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4',
      'fetched: 2026-09-03T16:31:07Z',
      '---',
    ]);
  });

  it('ends in exactly one newline', () => {
    const text = formatSidecar({ document, fetched, threads: [earlier, later] });

    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});

describe('sidecarPathOf', () => {
  it('puts the sidecar beside the document', () => {
    expect(sidecarPathOf('drive/Elements.md')).toBe('drive/Elements.comments.md');
    expect(sidecarPathOf('a/b/Notes (2).md')).toBe('a/b/Notes (2).comments.md');
  });

  it('recognises one by its suffix', () => {
    expect(isSidecarPath('drive/Elements.comments.md')).toBe(true);
    expect(isSidecarPath('drive/Elements.md')).toBe(false);
    expect(isSidecarPath('drive/comments.md')).toBe(false);
  });
});

describe('sameButForFetched', () => {
  const one = formatSidecar({ document, fetched, threads: [earlier] });

  it('is true when only the time of the fetch moved', () => {
    const two = formatSidecar({ document, fetched: '2026-09-04T09:00:00Z', threads: [earlier] });

    expect(two).not.toBe(one);
    expect(sameButForFetched(one, two)).toBe(true);
  });

  it('is false when a thread changed', () => {
    const two = formatSidecar({ document, fetched, threads: [earlier, later] });

    expect(sameButForFetched(one, two)).toBe(false);
  });
});
