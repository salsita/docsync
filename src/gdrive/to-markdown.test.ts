import { describe, expect, it } from 'vitest';
import type {
  DocsDocument,
  NestingLevel,
  Paragraph,
  ParagraphElement,
  StructuralElement,
  TextStyle,
} from './api.js';
import { DOC_IDS, fixtureDocument } from './fixtures.mock.js';
import { CODE_FONTS, documentToMarkdown } from './to-markdown.js';

/** A text run, the way every test below spells one. */
function run(content: string, textStyle: TextStyle = {}): ParagraphElement {
  return { textRun: { content, textStyle } };
}

/** One paragraph, its content ending in the newline Docs always stores. */
function para(
  elements: ParagraphElement[],
  paragraph: Omit<Paragraph, 'elements'> = {},
): StructuralElement {
  return {
    paragraph: { elements, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, ...paragraph },
  };
}

/** A whole document around some body content. */
function doc(content: StructuralElement[], rest: Partial<DocsDocument> = {}): DocsDocument {
  return { documentId: 'DOC1', title: 'Test', body: { content }, ...rest };
}

/** A paragraph of plain text, newline included. */
function text(content: string, paragraph: Omit<Paragraph, 'elements'> = {}): StructuralElement {
  return para([run(`${content}\n`)], paragraph);
}

/** A list definition with one glyph shape repeated over three levels. */
function list(
  level: NestingLevel,
): Record<string, { listProperties: { nestingLevels: NestingLevel[] } }> {
  return { L: { listProperties: { nestingLevels: [level, level, level] } } };
}

const BULLET: NestingLevel = { glyphSymbol: '●', glyphType: 'GLYPH_TYPE_UNSPECIFIED' };
const ORDERED: NestingLevel = { glyphType: 'DECIMAL', glyphFormat: '%0.', startNumber: 1 };
const CHECKLIST: NestingLevel = { glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphFormat: '%0' };

/** A list item paragraph on list `L`. */
function item(content: string, nestingLevel = 0): StructuralElement {
  return text(content, { bullet: { listId: 'L', nestingLevel } });
}

describe('paragraphs and headings', () => {
  it('converts a paragraph', () => {
    expect(documentToMarkdown(doc([text('Hello.')]))).toBe('Hello.\n');
  });

  it('drops the section break and empty paragraphs', () => {
    const document = doc([
      { sectionBreak: { sectionStyle: {} } },
      para([run('\n')]),
      text('Only this.'),
      { paragraph: {} },
    ]);
    expect(documentToMarkdown(document)).toBe('Only this.\n');
  });

  it('converts headings one to six', () => {
    const document = doc(
      [1, 2, 3, 4, 5, 6].map((depth) =>
        text(`H${depth}`, { paragraphStyle: { namedStyleType: `HEADING_${depth}` } }),
      ),
    );
    expect(documentToMarkdown(document)).toBe(
      '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n',
    );
  });

  it('marks Title and Subtitle with the block attribute comment', () => {
    const document = doc([
      text('The title', { paragraphStyle: { namedStyleType: 'TITLE' } }),
      text('The subtitle', { paragraphStyle: { namedStyleType: 'SUBTITLE' } }),
    ]);
    expect(documentToMarkdown(document)).toBe(
      '<!-- docsync: style=title -->\n\n# The title\n\n<!-- docsync: style=subtitle -->\n\n## The subtitle\n',
    );
  });

  it('treats an unknown named style as an ordinary paragraph', () => {
    const document = doc([text('Odd', { paragraphStyle: { namedStyleType: 'SOMETHING_NEW' } })]);
    expect(documentToMarkdown(document)).toBe('Odd\n');
  });
});

describe('text runs', () => {
  const styled = (style: TextStyle) =>
    documentToMarkdown(doc([para([run('x', style), run('\n')])]));

  it('converts each style on its own', () => {
    expect(styled({ bold: true })).toBe('**x**\n');
    expect(styled({ italic: true })).toBe('_x_\n');
    expect(styled({ strikethrough: true })).toBe('~~x~~\n');
    expect(styled({ underline: true })).toBe('<u>x</u>\n');
  });

  it('nests combined styles from the inside out', () => {
    expect(styled({ bold: true, italic: true, strikethrough: true, underline: true })).toBe(
      '**_~~<u>x</u>~~_**\n',
    );
  });

  it('wraps a styled run in its link', () => {
    expect(styled({ bold: true, link: { url: 'https://example.com/' } })).toBe(
      '[**x**](https://example.com/)\n',
    );
  });

  it('ignores a link with no url of its own', () => {
    expect(styled({ link: { headingId: 'h.1' } })).toBe('x\n');
  });

  it('makes a run in a code font inline code', () => {
    for (const font of CODE_FONTS) {
      expect(styled({ weightedFontFamily: { fontFamily: font.toUpperCase() } })).toBe('`x`\n');
    }
  });

  it('leaves a run in an ordinary font alone', () => {
    expect(styled({ weightedFontFamily: { fontFamily: 'Georgia' } })).toBe('x\n');
  });

  it('drops colour, highlight and size, keeping the text', () => {
    expect(
      styled({
        foregroundColor: { color: { rgbColor: { red: 1 } } },
        backgroundColor: { color: { rgbColor: { red: 1, green: 1 } } },
        fontSize: { magnitude: 14, unit: 'PT' },
      }),
    ).toBe('x\n');
  });

  it('turns a vertical tab into a hard break', () => {
    const document = doc([para([run('one\u000Btwo\n')])]);
    expect(documentToMarkdown(document)).toBe('one\\\ntwo\n');
  });

  it('escapes Markdown punctuation', () => {
    expect(documentToMarkdown(doc([text('* not a list [x] _e_')]))).toBe(
      '\\* not a list \\[x] \\_e\\_\n',
    );
  });

  it('does not style the newline a paragraph ends in', () => {
    // Enter at the end of bold text leaves the paragraph's newline run bold;
    // an empty heading in a bold style is nothing but that run, and an empty
    // heading is what it was before the style: nothing.
    expect(
      documentToMarkdown(doc([para([run('x', { bold: true }), run('\n', { bold: true })])])),
    ).toBe('**x**\n');
    expect(
      documentToMarkdown(
        doc([
          para([run('\n', { bold: true })], { paragraphStyle: { namedStyleType: 'HEADING_3' } }),
        ]),
      ),
    ).toBe('');
    expect(documentToMarkdown(doc([para([run('\n', { italic: true, underline: true })])]))).toBe(
      '',
    );
  });

  it('moves the spaces at the edges of a styled run outside it', () => {
    expect(
      documentToMarkdown(doc([para([run('Created by: ', { bold: true }), run('me\n')])])),
    ).toBe('**Created by:** me\n');
    expect(
      documentToMarkdown(doc([para([run('a'), run(' b ', { italic: true }), run('c\n')])])),
    ).toBe('a _b_ c\n');
    // Leading spaces are the paragraph's, encoded as any leading space is.
    expect(documentToMarkdown(doc([para([run('   ', { bold: true }), run('x\n')])]))).toBe(
      '&#x20;  x\n',
    );
    expect(
      documentToMarkdown(
        doc([para([run(' x ', { bold: true, link: { url: 'https://example.com/' } }), run('\n')])]),
      ),
    ).toBe('[ **x** ](https://example.com/)\n');
  });

  it('survives a run with no content at all', () => {
    expect(documentToMarkdown(doc([para([{ textRun: {} }, run('after\n')])]))).toBe('after\n');
  });
});

describe('lists', () => {
  it('converts a bulleted list, nested', () => {
    const document = doc([item('One'), item('Nested', 1), item('Deeper', 2), item('Two')], {
      lists: list(BULLET),
    });
    expect(documentToMarkdown(document)).toBe('- One\n  - Nested\n    - Deeper\n- Two\n');
  });

  it('numbers an ordered list and restarts it after a paragraph', () => {
    const document = doc([item('One'), item('Two'), text('Between.'), item('Again')], {
      lists: list(ORDERED),
    });
    expect(documentToMarkdown(document)).toBe('1. One\n2. Two\n\nBetween.\n\n1. Again\n');
  });

  it('starts a new list when the kind changes at the same level', () => {
    const document = doc(
      [text('a', { bullet: { listId: 'B' } }), text('b', { bullet: { listId: 'O' } })],
      {
        lists: {
          B: { listProperties: { nestingLevels: [BULLET] } },
          O: { listProperties: { nestingLevels: [ORDERED] } },
        },
      },
    );
    expect(documentToMarkdown(document)).toBe('- a\n\n1. b\n');
  });

  it('writes a checklist as unchecked task items', () => {
    const document = doc([item('Unchecked'), item('Checked')], { lists: list(CHECKLIST) });
    // The Docs API does not report which box is ticked (ticket 07 Outcome), so
    // every checklist item comes back unchecked.
    expect(documentToMarkdown(document)).toBe('- [ ] Unchecked\n- [ ] Checked\n');
  });

  it('falls back to a bullet when the list says nothing about its glyph', () => {
    const document = doc([item('One')], { lists: list({}) });
    expect(documentToMarkdown(document)).toBe('- One\n');
  });

  it('falls back to a bullet when the list is not in the document at all', () => {
    const document = doc([item('Orphan')]);
    expect(documentToMarkdown(document)).toBe('- Orphan\n');
  });

  it('treats an alphabetic glyph as ordered', () => {
    const document = doc([item('One')], {
      lists: list({ glyphType: 'UPPER_ALPHA', glyphFormat: '%0.' }),
    });
    expect(documentToMarkdown(document)).toBe('1. One\n');
  });

  it('starts a list at a deeper nesting level than its first item', () => {
    const document = doc([item('Deep', 1), item('Shallow')], { lists: list(BULLET) });
    expect(documentToMarkdown(document)).toBe('- Deep\n\n* Shallow\n');
  });
});

describe('tables', () => {
  const cell = (content: string) => ({ content: [text(content)] });

  it('converts a table, with the first row as the header', () => {
    const document = doc([
      {
        table: {
          rows: 2,
          columns: 2,
          tableRows: [
            { tableCells: [cell('Name'), cell('Value')] },
            { tableCells: [cell('a | pipe'), cell('b')] },
          ],
        },
      },
    ]);
    expect(documentToMarkdown(document)).toBe(
      '| Name      | Value |\n| --------- | ----- |\n| a \\| pipe | b     |\n',
    );
  });

  it('makes a table with merged cells a placeholder', () => {
    const document = doc([
      {
        startIndex: 42,
        table: {
          rows: 1,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                { ...cell('wide'), tableCellStyle: { columnSpan: 2, rowSpan: 1 } },
                cell('b'),
              ],
            },
          ],
        },
      },
    ]);
    expect(documentToMarkdown(document)).toBe('<!-- docsync:block gdocs:DOC1#42 type=table -->\n');
  });

  it('makes an empty table a placeholder', () => {
    expect(documentToMarkdown(doc([{ startIndex: 7, table: {} }]))).toBe(
      '<!-- docsync:block gdocs:DOC1#7 type=table -->\n',
    );
  });

  it('pads a short row out to the width of the table', () => {
    const document = doc([
      {
        table: {
          rows: 2,
          columns: 2,
          tableRows: [{ tableCells: [cell('a'), cell('b')] }, { tableCells: [cell('c')] }],
        },
      },
    ]);
    expect(documentToMarkdown(document)).toBe('| a | b |\n| - | - |\n| c |   |\n');
  });
});

describe('the rest of the elements', () => {
  it('converts a horizontal rule', () => {
    const document = doc([para([{ horizontalRule: {} }, run('\n')])]);
    expect(documentToMarkdown(document)).toBe('---\n');
  });

  it('splits a paragraph at a page break', () => {
    const document = doc([para([run('before'), { pageBreak: {} }, run('after\n')])]);
    expect(documentToMarkdown(document)).toBe('before\n\n<!-- docsync:pagebreak -->\n\nafter\n');
  });

  it('places an image as an object placeholder', () => {
    const document = doc(
      [para([{ inlineObjectElement: { inlineObjectId: 'kix.1' } }, run('\n')])],
      {
        inlineObjects: {
          'kix.1': {
            objectId: 'kix.1',
            inlineObjectProperties: { embeddedObject: { imageProperties: {} } },
          },
        },
      },
    );
    expect(documentToMarkdown(document)).toBe('<!-- docsync:object gdocs:kix.1 type=image -->\n');
  });

  it('names a drawing and an unknown embedded object by what it is', () => {
    const document = doc(
      [
        para([{ inlineObjectElement: { inlineObjectId: 'd' } }, run('\n')]),
        para([{ inlineObjectElement: { inlineObjectId: 'u' } }, run('\n')]),
        para([{ inlineObjectElement: {} }, run('\n')]),
      ],
      {
        inlineObjects: {
          d: { inlineObjectProperties: { embeddedObject: { embeddedDrawingProperties: {} } } },
          u: { inlineObjectProperties: { embeddedObject: {} } },
        },
      },
    );
    expect(documentToMarkdown(document)).toBe(
      '<!-- docsync:object gdocs:d type=drawing -->\n\n<!-- docsync:object gdocs:u type=object -->\n\n<!-- docsync:object gdocs: type=object -->\n',
    );
  });

  it('keeps an image that sits inside a line of text inside it', () => {
    const document = doc([
      para([run('a '), { inlineObjectElement: { inlineObjectId: 'i' } }, run(' b\n')]),
    ]);
    expect(documentToMarkdown(document)).toBe('a <!-- docsync:object gdocs:i type=object --> b\n');
  });

  it('converts a footnote reference and puts its definition at the end', () => {
    const document = doc(
      [
        para([
          run('Text'),
          { footnoteReference: { footnoteId: 'f1', footnoteNumber: '1' } },
          run('.\n'),
        ]),
        text('After.'),
      ],
      { footnotes: { f1: { footnoteId: 'f1', content: [text(' The note')] } } },
    );
    expect(documentToMarkdown(document)).toBe('Text[^1].\n\nAfter.\n\n[^1]: The note\n');
  });

  it('numbers a footnote whose reference says nothing', () => {
    const document = doc([para([{ footnoteReference: { footnoteId: 'f1' } }, run('\n')])], {
      footnotes: { f1: { content: [text('Body')] } },
    });
    expect(documentToMarkdown(document)).toBe('[^1]\n\n[^1]: Body\n');
  });

  it('writes no definition for a reference the document does not carry', () => {
    const document = doc([
      para([{ footnoteReference: { footnoteId: 'gone', footnoteNumber: '3' } }, run('\n')]),
    ]);
    expect(documentToMarkdown(document)).toBe('[^3]\n');
  });

  it('makes a table of contents a placeholder', () => {
    expect(documentToMarkdown(doc([{ startIndex: 3, tableOfContents: {} }]))).toBe(
      '<!-- docsync:block gdocs:DOC1#3 type=table-of-contents -->\n',
    );
  });

  it('makes an element it does not know an object placeholder', () => {
    const document = doc([para([run('a'), { equation: {} }, run('\n')])]);
    expect(documentToMarkdown(document)).toBe(
      'a<!-- docsync:object gdocs:DOC1# type=equation -->\n',
    );
  });

  it('names an element with nothing in it at all', () => {
    const document = doc([para([run('a'), { startIndex: 5, endIndex: 6 }, run('\n')])]);
    expect(documentToMarkdown(document)).toBe(
      'a<!-- docsync:object gdocs:DOC1#5 type=unknown -->\n',
    );
  });

  it('converts a document with no body at all', () => {
    expect(documentToMarkdown({ documentId: 'D' })).toBe('');
  });
});

describe('the recorded documents', () => {
  // Reviewed by eye once and locked. A change to any of these is a change to
  // every checked-out Google Doc in the world, so it must be deliberate.
  for (const id of DOC_IDS) {
    it(`converts ${id}`, () => {
      expect(documentToMarkdown(fixtureDocument(id))).toMatchSnapshot();
    });
  }
});
