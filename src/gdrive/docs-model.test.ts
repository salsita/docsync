/**
 * The model on its own, so that the round trip is testing `from-markdown.ts`
 * and not two mistakes cancelling out. Every assertion here is a claim about
 * what the real Docs API does, taken from the recorded fixtures (the index
 * arithmetic, the checklist glyphs) or from the request reference.
 */
import { describe, expect, it } from 'vitest';
import { createDocsModel } from './docs-model.mock.js';
import { documentToMarkdown } from './to-markdown.js';

/** The body's structural elements, without the section break. */
function content(model: ReturnType<typeof createDocsModel>) {
  return (model.document().body?.content ?? []).slice(1);
}

describe('an empty document', () => {
  it('is a section break and one empty paragraph', () => {
    const model = createDocsModel();
    expect(model.document().body?.content).toEqual([
      { endIndex: 1, sectionBreak: {} },
      {
        startIndex: 1,
        endIndex: 2,
        paragraph: {
          elements: [{ startIndex: 1, endIndex: 2, textRun: { content: '\n', textStyle: {} } }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
    ]);
    expect(model.endIndex()).toBe(2);
  });
});

describe('insertText', () => {
  it('splits the paragraph it lands in at every newline', () => {
    const model = createDocsModel();
    model.apply([{ insertText: { location: { index: 1 }, text: 'one\ntwo\n' } }]);
    expect(content(model).map((element) => element.startIndex)).toEqual([1, 5, 9]);
    expect(documentToMarkdown(model.document())).toBe('one\n\ntwo\n');
  });

  it('inherits the style and the bullet of the paragraph it lands in', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'bold\n' } },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 5 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 6 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
      // This is the trap: an unstyled insert in front of a styled list item.
      { insertText: { location: { index: 1 }, text: 'plain\n' } },
    ]);
    expect(documentToMarkdown(model.document())).toBe('- **plain**\n- **bold**\n');
  });

  it('goes into a footnote segment when the location names one', () => {
    const model = createDocsModel();
    const [reply] = model.apply([{ createFootnote: { location: { index: 1 } } }]);
    const segmentId = reply?.createFootnote?.footnoteId ?? '';
    // Docs seeds a new footnote with a space, so a body replaces the segment.
    expect(model.document().footnotes?.[segmentId]?.content?.at(-1)?.endIndex).toBe(2);
    model.apply([
      { deleteContentRange: { range: { segmentId, startIndex: 0, endIndex: 1 } } },
      { insertText: { location: { index: 0, segmentId }, text: 'A note\n' } },
    ]);
    expect(documentToMarkdown(model.document())).toBe('[^1]\n\n[^1]: A note\n');
  });
});

describe('updateTextStyle', () => {
  it('cuts a run in three and clears what the mask does not set', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'abcde\n' } },
      {
        updateTextStyle: {
          range: { startIndex: 2, endIndex: 4 },
          textStyle: { bold: true },
          fields: 'bold,italic',
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 3, endIndex: 4 },
          textStyle: {},
          fields: 'bold,italic',
        },
      },
    ]);
    expect(documentToMarkdown(model.document())).toBe('a**b**cde\n');
  });
});

describe('createParagraphBullets', () => {
  it('reads the leading tabs as the level and takes them out', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'one\n\ttwo\n' } },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 10 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ]);
    expect(documentToMarkdown(model.document())).toBe('- one\n  - two\n');
  });

  it('draws each preset the way `documents.get` reports it', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'a\nb\nc\n' } },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 3 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
      {
        createParagraphBullets: {
          range: { startIndex: 3, endIndex: 5 },
          bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN',
        },
      },
      {
        createParagraphBullets: {
          range: { startIndex: 5, endIndex: 7 },
          bulletPreset: 'BULLET_CHECKBOX',
        },
      },
    ]);
    const levels = Object.values(model.document().lists ?? {}).map(
      (list) => list.listProperties?.nestingLevels?.[0],
    );
    expect(levels).toEqual([
      { glyphSymbol: '●', glyphFormat: '%0' },
      { glyphType: 'DECIMAL', glyphFormat: '%0.', startNumber: 1 },
      // A checklist is the odd one out: no symbol, no type, a bare `%0`.
      { glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphFormat: '%0' },
    ]);
    expect(documentToMarkdown(model.document())).toBe('- a\n\n1. b\n\n- [ ] c\n');
  });

  it('is undone for one paragraph by deleteParagraphBullets', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'a\nb\n' } },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 5 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 2 } } },
    ]);
    expect(documentToMarkdown(model.document())).toBe('a\n\n- b\n');
  });
});

describe('insertTable', () => {
  it('puts a newline before it and lays the cells out as Docs does', () => {
    const model = createDocsModel();
    model.apply([
      { insertTable: { rows: 2, columns: 2, location: { index: 1 } } },
      { insertText: { location: { index: 12 }, text: 'd' } },
      { insertText: { location: { index: 10 }, text: 'c' } },
      { insertText: { location: { index: 7 }, text: 'b' } },
      { insertText: { location: { index: 5 }, text: 'a' } },
    ]);
    const [, table] = content(model);
    expect(table?.startIndex).toBe(2);
    expect(documentToMarkdown(model.document())).toBe('| a | b |\n| - | - |\n| c | d |\n');
  });
});

describe('a table row', () => {
  /** A two-by-two table with a letter in every cell, as `insertTable` lays it. */
  function table() {
    const model = createDocsModel();
    model.apply([
      { insertTable: { rows: 2, columns: 2, location: { index: 1 } } },
      { insertText: { location: { index: 12 }, text: 'd' } },
      { insertText: { location: { index: 10 }, text: 'c' } },
      { insertText: { location: { index: 7 }, text: 'b' } },
      { insertText: { location: { index: 5 }, text: 'a' } },
    ]);
    return model;
  }

  it('reports where every row and cell starts, as documents.get does', () => {
    const [, element] = content(table());
    const [first] = element?.table?.tableRows ?? [];
    expect(first?.startIndex).toBe(3);
    expect(first?.tableCells?.[0]?.startIndex).toBe(4);
    expect(first?.tableCells?.[1]?.startIndex).toBe(7);
  });

  it('is inserted below the row named, with a cell to fill per column', () => {
    const model = table();
    model.apply([
      {
        insertTableRow: {
          tableCellLocation: { tableStartLocation: { index: 2 }, rowIndex: 1, columnIndex: 0 },
          insertBelow: true,
        },
      },
      // The new row starts where the last one ended, at 17: a cell of its own
      // is one unit, its empty paragraph another, so the cells are two apart.
      { insertText: { location: { index: 21 }, text: 'f' } },
      { insertText: { location: { index: 19 }, text: 'e' } },
    ]);
    expect(documentToMarkdown(model.document())).toBe(
      '| a | b |\n| - | - |\n| c | d |\n| e | f |\n',
    );
  });

  it('is deleted whole by the row it names', () => {
    const model = table();
    model.apply([
      {
        deleteTableRow: {
          tableCellLocation: { tableStartLocation: { index: 2 }, rowIndex: 1, columnIndex: 0 },
        },
      },
    ]);
    expect(documentToMarkdown(model.document())).toBe('| a | b |\n| - | - |\n');
  });

  it('has a range deleted inside one cell without losing the table', () => {
    const model = table();
    // "c" is the paragraph of the first cell of the second row.
    model.apply([{ deleteContentRange: { range: { startIndex: 12, endIndex: 13 } } }]);
    expect(documentToMarkdown(model.document())).toBe('| a | b |\n| - | - |\n|   | d |\n');
  });
});

describe('insertPageBreak', () => {
  it('is a page break and a newline, so the paragraph is cut in two', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'after\n' } },
      { insertPageBreak: { location: { index: 1 } } },
      { insertText: { location: { index: 1 }, text: 'before\n' } },
    ]);
    expect(documentToMarkdown(model.document())).toBe(
      'before\n\n<!-- docsync:pagebreak -->\n\nafter\n',
    );
  });
});

describe('deleteContentRange', () => {
  it('empties a body and merges what is left into one paragraph', () => {
    const model = createDocsModel();
    model.apply([{ insertText: { location: { index: 1 }, text: 'one\ntwo\nthree\n' } }]);
    model.apply([{ insertTable: { rows: 1, columns: 1, location: { index: 1 } } }]);
    model.apply([
      { deleteContentRange: { range: { startIndex: 1, endIndex: model.endIndex() - 1 } } },
    ]);
    expect(content(model)).toHaveLength(1);
    expect(model.endIndex()).toBe(2);
    expect(documentToMarkdown(model.document())).toBe('');
  });

  it('leaves a paragraph the range does not reach alone', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'one\ntwo\n' } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 4 } } },
    ]);
    expect(documentToMarkdown(model.document())).toBe('two\n');
  });

  // A paragraph's style and its bullet hang off its newline, so deleting whole
  // paragraphs leaves the *following* paragraph's newline standing, and with it
  // that paragraph's style. Getting this backwards is what made the fake say a
  // deleted list item hands its bullet to the paragraph after it (ticket 32);
  // `scripts/smoke-gdrive-patch.ts` is where the real API said otherwise.
  it('gives the merged paragraph the style of the newline that survived', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'item\nplain\n' } },
      {
        createParagraphBullets: {
          range: { startIndex: 1, endIndex: 6 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ]);
    expect(documentToMarkdown(model.document())).toBe('- item\n\nplain\n');

    // The whole bulleted paragraph goes, newline included.
    model.apply([{ deleteContentRange: { range: { startIndex: 1, endIndex: 6 } } }]);
    expect(documentToMarkdown(model.document())).toBe('plain\n');
  });

  it('keeps the bullet of the paragraph a deletion merged into', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'gone\nitem\n' } },
      {
        createParagraphBullets: {
          range: { startIndex: 6, endIndex: 11 },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      },
    ]);
    expect(documentToMarkdown(model.document())).toBe('gone\n\n- item\n');

    model.apply([{ deleteContentRange: { range: { startIndex: 1, endIndex: 6 } } }]);
    expect(documentToMarkdown(model.document())).toBe('- item\n');
  });
});

describe('insertInlineImage', () => {
  it('puts one object in the paragraph and reports it as an inline object', () => {
    const model = createDocsModel();
    model.apply([
      { insertText: { location: { index: 1 }, text: 'before after\n' } },
      { insertInlineImage: { location: { index: 7 }, uri: 'https://drive/uc?id=x' } },
    ]);

    const doc = model.document();
    const elements = doc.body?.content?.[1]?.paragraph?.elements ?? [];
    const object = elements.find((one) => one.inlineObjectElement !== undefined);
    expect(object?.inlineObjectElement?.inlineObjectId).toBe('kix.img1');
    // One code unit, as Docs counts it.
    expect((object?.endIndex ?? 0) - (object?.startIndex ?? 0)).toBe(1);
    expect(
      doc.inlineObjects?.['kix.img1']?.inlineObjectProperties?.embeddedObject?.imageProperties,
    ).toEqual({ contentUri: 'https://drive/uc?id=x' });
  });
});

describe('a request the model does not know', () => {
  it('fails loudly rather than being ignored', () => {
    expect(() => createDocsModel().apply([{ replaceImage: {} }])).toThrow(
      'the model does not know replaceImage',
    );
  });
});

/**
 * A `SUGGEST` batch gives every request one suggestion id, and the id lands on
 * every run the request touched — which is what makes one suggestion one thread
 * however many paragraphs it reaches into (MANUAL §6, ticket 34).
 */
describe('a suggesting batch across a paragraph break', () => {
  /** Every run of the inline view, as `content` and the ids it carries. */
  function runs(model: ReturnType<typeof createDocsModel>) {
    return content(model).flatMap((element) =>
      (element.paragraph?.elements ?? []).map((one) => ({
        content: one.textRun?.content,
        ins: one.textRun?.suggestedInsertionIds,
        del: one.textRun?.suggestedDeletionIds,
      })),
    );
  }

  /** Three paragraphs, written plainly. */
  function seeded() {
    const model = createDocsModel();
    model.apply([{ insertText: { location: { index: 1 }, text: 'One.\nTwo.\nThree.' } }]);
    return model;
  }

  it('tags every run an insertion of several paragraphs made', () => {
    const model = seeded();
    model.apply([{ insertText: { location: { index: 3 }, text: 'A\nB\nC' } }], { suggest: true });

    const inserted = runs(model).filter((run) => run.ins !== undefined);
    expect(inserted.map((run) => run.content)).toEqual(['A\n', 'B\n', 'C']);
    expect(inserted.every((run) => run.ins?.[0] === 'suggest.s1')).toBe(true);
    // And the body still reads as it did: a suggestion writes nothing.
    expect(documentToMarkdown(model.document('preview'))).toBe('One.\n\nTwo.\n\nThree.\n');
  });

  it('tags every run a deletion across a break covers', () => {
    const model = seeded();
    model.apply([{ deleteContentRange: { range: { startIndex: 3, endIndex: 13 } } }], {
      suggest: true,
    });

    const deleted = runs(model).filter((run) => run.del !== undefined);
    expect(deleted.map((run) => run.content)).toEqual(['e.\n', 'Two.\n', 'Th']);
    expect(deleted.every((run) => run.del?.[0] === 'suggest.s1')).toBe(true);
    expect(documentToMarkdown(model.document('preview'))).toBe('One.\n\nTwo.\n\nThree.\n');
  });
});
