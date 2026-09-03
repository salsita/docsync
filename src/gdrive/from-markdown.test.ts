/**
 * One test per element, against the exact request JSON, with the indices
 * checked by hand. The round trip in `round-trip.test.ts` proves the requests
 * add up to the right document; these prove they are the requests we meant.
 */
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../markdown.js';
import { markdownToRequests, mdastToSegments } from './from-markdown.js';

const FIELDS = 'bold,italic,underline,strikethrough,weightedFontFamily,link';

/** The plain style every run carries when nothing is turned on. */
const PLAIN = { bold: false, italic: false, underline: false, strikethrough: false };

function requests(markdown: string) {
  return markdownToRequests(markdown).requests;
}

describe('a paragraph', () => {
  it('is inserted at index 1 with its style and no bullet', () => {
    expect(requests('Hello\n')).toEqual([
      { insertText: { location: { index: 1 }, text: 'Hello\n' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 7 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 7 } } },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 6 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
    ]);
  });

  it('counts an emoji as the two code units the Docs API counts', () => {
    const [insert, , , style] = requests('😀ok\n');
    expect(insert).toEqual({ insertText: { location: { index: 1 }, text: '😀ok\n' } });
    // '😀' is a surrogate pair, so the run ends at 1 + 2 + 2.
    expect(style).toMatchObject({ updateTextStyle: { range: { startIndex: 1, endIndex: 5 } } });
  });

  it('is empty when the Markdown block is empty, and produces nothing', () => {
    expect(requests('<!-- docsync:block gdocs:x#1 type=table -->\n')).toEqual([]);
  });
});

describe('a heading', () => {
  it('takes the named style of its level', () => {
    expect(requests('### Three\n')[1]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'HEADING_3' } },
    });
    expect(requests('###### Six\n')[1]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'HEADING_6' } },
    });
  });

  it('takes Title and Subtitle from the attribute comment above it', () => {
    expect(requests('<!-- docsync: style=title -->\n\n# Elements\n')[1]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'TITLE' } },
    });
    expect(requests('<!-- docsync: style=subtitle -->\n\n## Sub\n')[1]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'SUBTITLE' } },
    });
  });

  it('is a heading again once the comment has been used up', () => {
    const plan = requests('<!-- docsync: style=title -->\n\n# One\n\n# Two\n');
    // Reversed: the second heading is written first.
    expect(plan[1]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'HEADING_1' } },
    });
    expect(plan[5]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'TITLE' } },
    });
  });
});

describe('inline styles', () => {
  it('are one request per run, always with the whole mask', () => {
    const styles = requests('a **b** *c* ~~d~~ <u>e</u> `f` [g](h)\n').filter(
      (request) => 'updateTextStyle' in request,
    );
    expect(styles).toEqual([
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 3 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 3, endIndex: 4 },
          textStyle: { ...PLAIN, bold: true },
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 4, endIndex: 5 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 5, endIndex: 6 },
          textStyle: { ...PLAIN, italic: true },
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 6, endIndex: 7 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 7, endIndex: 8 },
          textStyle: { ...PLAIN, strikethrough: true },
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 8, endIndex: 9 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 9, endIndex: 10 },
          textStyle: { ...PLAIN, underline: true },
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 10, endIndex: 11 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 11, endIndex: 12 },
          textStyle: { ...PLAIN, weightedFontFamily: { fontFamily: 'Courier New', weight: 400 } },
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 12, endIndex: 13 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 13, endIndex: 14 },
          textStyle: { ...PLAIN, link: { url: 'h' } },
          fields: FIELDS,
        },
      },
    ]);
  });

  it('writes a hard break as the vertical tab Docs stores', () => {
    expect(requests('one  \ntwo\n')[0]).toEqual({
      insertText: { location: { index: 1 }, text: 'onetwo\n' },
    });
  });

  it('drops an image, which a push cannot create', () => {
    expect(markdownToRequests('![a](b.png)\n').dropped).toEqual(['image']);
  });
});

describe('a list', () => {
  it('nests with tabs and bullets the whole run at once', () => {
    expect(requests('- one\n  - two\n- three\n')).toEqual([
      { insertText: { location: { index: 1 }, text: 'one\n\ttwo\nthree\n' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 16 },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 4 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 6, endIndex: 9 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 10, endIndex: 15 },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 16 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ]);
  });

  it('numbers an ordered list and checks a checklist', () => {
    expect(requests('1. one\n').at(-1)).toEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 5 },
        bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
      },
    });
    // A tick cannot be written: the API has no request for one and the read
    // side cannot see one either (ticket 07 Outcome).
    expect(requests('- [x] done\n').at(-1)).toEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 6 },
        bulletPreset: 'BULLET_CHECKBOX',
      },
    });
  });

  it('bullets each run of one kind on its own, last run first', () => {
    const bullets = requests('- one\n  - [ ] two\n- three\n').filter(
      (request) => 'createParagraphBullets' in request,
    );
    expect(bullets).toEqual([
      {
        createParagraphBullets: {
          range: { startIndex: 10, endIndex: 16 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
      {
        createParagraphBullets: {
          range: { startIndex: 5, endIndex: 10 },
          bulletPreset: 'BULLET_CHECKBOX',
        },
      },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 5 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ]);
  });
});

describe('a table', () => {
  it('inserts the grid, then fills it from the last cell backwards', () => {
    const table = requests('| a | b |\n|---|---|\n| c | d |\n| e | f |\n');
    expect(table[0]).toEqual({
      insertTable: { rows: 3, columns: 2, location: { index: 1 } },
    });
    expect(table[1]).toEqual({
      deleteParagraphBullets: { range: { startIndex: 1, endIndex: 2 } },
    });
    // The table starts at 2 (a newline goes in first), a row one past that, a
    // cell one past the row, its paragraph one past the cell: 1 + 4 = 5. Each
    // further cell is two on (an empty paragraph and the cell), each further
    // row is 2 * columns + 1.
    expect(table.filter((request) => 'insertText' in request)).toEqual([
      { insertText: { location: { index: 17 }, text: 'f' } },
      { insertText: { location: { index: 15 }, text: 'e' } },
      { insertText: { location: { index: 12 }, text: 'd' } },
      { insertText: { location: { index: 10 }, text: 'c' } },
      { insertText: { location: { index: 7 }, text: 'b' } },
      { insertText: { location: { index: 5 }, text: 'a' } },
    ]);
  });

  it('styles a cell where the cell is', () => {
    const table = requests('| **a** |\n|---|\n| b |\n');
    expect(table.at(-1)).toEqual({
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 6 },
        textStyle: { ...PLAIN, bold: true },
        fields: FIELDS,
      },
    });
  });
});

describe('a page break', () => {
  it('is one request and no text', () => {
    expect(requests('<!-- docsync:pagebreak -->\n')).toEqual([
      { insertPageBreak: { location: { index: 1 } } },
    ]);
  });
});

describe('a horizontal rule', () => {
  it('is dropped, because the Docs API cannot create one', () => {
    const plan = markdownToRequests('a\n\n---\n\nb\n');
    expect(plan.dropped).toEqual(['horizontal rule']);
    expect(plan.requests.filter((request) => 'insertText' in request)).toEqual([
      { insertText: { location: { index: 1 }, text: 'b\n' } },
      { insertText: { location: { index: 1 }, text: 'a\n' } },
    ]);
  });
});

describe('a footnote', () => {
  it('creates the reference in the body and the body in a second batch', () => {
    const plan = markdownToRequests('A[^1] end.\n\n[^1]: The note.\n');
    expect(plan.requests.at(-1)).toEqual({ createFootnote: { location: { index: 2 } } });
    expect(plan.footnotes).toHaveLength(1);
    expect(plan.footnotes[0]?.requestIndex).toBe(plan.requests.length - 1);
    expect(plan.footnotes[0]?.requests('kix.fn1')).toEqual([
      { insertText: { location: { index: 0, segmentId: 'kix.fn1' }, text: 'The note.\n' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 0, endIndex: 10, segmentId: 'kix.fn1' },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      {
        deleteParagraphBullets: { range: { startIndex: 0, endIndex: 10, segmentId: 'kix.fn1' } },
      },
      {
        updateTextStyle: {
          range: { startIndex: 0, endIndex: 9, segmentId: 'kix.fn1' },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
    ]);
  });

  it('makes the references of one paragraph in descending order', () => {
    const plan = markdownToRequests('A[^1]B[^2]\n\n[^1]: one\n\n[^2]: two\n');
    expect(plan.requests.slice(-2)).toEqual([
      { createFootnote: { location: { index: 3 } } },
      { createFootnote: { location: { index: 2 } } },
    ]);
  });

  it('has nowhere to go inside a table cell or inside another footnote', () => {
    expect(markdownToRequests('| a[^1] |\n|---|\n| b |\n\n[^1]: x\n').dropped).toEqual([
      'footnote',
    ]);
    expect(markdownToRequests('A[^1]\n\n[^1]: see [^2]\n\n[^2]: x\n').dropped).toEqual([
      'footnote',
    ]);
  });
});

describe('the order of the whole batch', () => {
  it('is reversed, so that every block is inserted at index 1', () => {
    const { segments } = mdastToSegments(parseMarkdown('one\n\ntwo\n\nthree\n'));
    expect(segments.map((segment) => segment.text)).toEqual(['one\n', 'two\n', 'three\n']);
    expect(requests('one\n\ntwo\n\nthree\n').filter((request) => 'insertText' in request)).toEqual([
      { insertText: { location: { index: 1 }, text: 'three\n' } },
      { insertText: { location: { index: 1 }, text: 'two\n' } },
      { insertText: { location: { index: 1 }, text: 'one\n' } },
    ]);
  });

  it('keeps blocks whose indices would collide apart', () => {
    // A table, a page break and a paragraph all insert at 1: in forward order
    // the table's cell indices would move under the page break.
    const kinds = requests('| a |\n|---|\n| b |\n\n<!-- docsync:pagebreak -->\n\ntail\n').map(
      (request) => Object.keys(request)[0],
    );
    expect(kinds[0]).toBe('insertText');
    expect(kinds).toContain('insertPageBreak');
    expect(kinds.lastIndexOf('insertTable')).toBeGreaterThan(kinds.indexOf('insertPageBreak'));
  });
});

describe('blocks the dialect does not write for Docs', () => {
  it('flattens a blockquote and writes a code block in the code font', () => {
    expect(requests('> quoted\n')[0]).toEqual({
      insertText: { location: { index: 1 }, text: 'quoted\n' },
    });
    const code = requests('```\nx = 1\ny = 2\n```\n');
    expect(code[0]).toEqual({ insertText: { location: { index: 1 }, text: 'x = 1\ny = 2\n' } });
    expect(code[3]).toMatchObject({
      updateTextStyle: {
        textStyle: { weightedFontFamily: { fontFamily: 'Courier New', weight: 400 } },
      },
    });
  });
});

describe('what the Docs dialect has no place for', () => {
  it('produces nothing for a block or an inline construct it cannot say', () => {
    // A link definition, an inline placeholder, inline maths: all of them go.
    expect(requests('[ref]: https://example.com\n')).toEqual([]);
    expect(requests('a <!-- docsync:object gdocs:k type=image --> b\n')[0]).toEqual({
      insertText: { location: { index: 1 }, text: 'a  b\n' },
    });
    expect(requests('a $x$ b\n')[0]).toEqual({
      insertText: { location: { index: 1 }, text: 'a  b\n' },
    });
  });
});
