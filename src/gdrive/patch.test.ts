/**
 * The block diff, turned into `batchUpdate` requests.
 *
 * Every test here starts from a document the *generator* wrote (the model in
 * `docs-model.mock.ts` applying `from-markdown.ts`), so the indices the patch
 * addresses are the indices a real document would have, and ends at the
 * requests themselves: what is sent, in what order, and — the point of the
 * whole ticket — what is not.
 */
import { describe, expect, it } from 'vitest';
import { diffBlocks } from '../diff/blocks.js';
import { parseMarkdown } from '../markdown.js';
import type { DocsDocument, DocsWriteRequest } from './api.js';
import { createDocsModel } from './docs-model.mock.js';
import { mdastToRequests } from './from-markdown.js';
import { planPatch } from './patch.js';
import { readLive } from './ranges.js';
import { documentToMarkdown } from './to-markdown.js';
import { footnoteRequests } from './write.js';

const PATH = 'drive/Doc.md';

/** What a document with an inline image needs on both sides of the trip. */
interface Media {
  /** The public URI of each asset, which is what creates an image (§12). */
  images?: ReadonlyMap<string, string>;
  /** The file each inline object was downloaded to, which is what reads one. */
  assets?: ReadonlyMap<string, string>;
}

function convertOptions(media: Media) {
  return { from: PATH, ...(media.assets === undefined ? {} : { assets: media.assets }) };
}

function patchOptions(media: Media) {
  return { path: PATH, ...(media.images === undefined ? {} : { images: media.images }) };
}

/** A live document holding exactly what the Markdown says. */
function document(markdown: string, media: Media = {}): DocsDocument {
  const model = createDocsModel('doc', 'Doc');
  const plan = mdastToRequests(parseMarkdown(markdown), {
    from: PATH,
    ...(media.images === undefined ? {} : { images: media.images }),
  });
  const replies = model.apply(plan.requests);
  model.apply(footnoteRequests(plan.footnotes, replies, 0, model.document()));
  // The fixture of the test is the round trip: if the document does not say
  // what the base says, the test is measuring the generator, not the patch.
  expect(documentToMarkdown(model.document(), convertOptions(media))).toBe(markdown);
  return model.document();
}

function plan(base: string, next: string, doc = document(base), media: Media = {}) {
  const live = readLive(doc, convertOptions(media));
  expect(live.markdown).toBe(base);
  return planPatch(live, diffBlocks(parseMarkdown(base), parseMarkdown(next)), patchOptions(media));
}

/** The kind of each request, in the order the batch sends them. */
function kinds(requests: readonly DocsWriteRequest[]): string[] {
  return requests.map((request) => Object.keys(request)[0] ?? '');
}

/** The index every request addresses, for the descending-order check. */
function indices(requests: readonly DocsWriteRequest[]): number[] {
  return requests.map((request) => {
    const value = Object.values(request)[0] as {
      location?: { index?: number };
      range?: { startIndex?: number };
      tableCellLocation?: { tableStartLocation?: { index?: number } };
    };
    return (
      value.location?.index ??
      value.range?.startIndex ??
      value.tableCellLocation?.tableStartLocation?.index ??
      0
    );
  });
}

/** The document the plan leaves behind. */
function patched(markdown: string, next: string, media: Media = {}): DocsDocument {
  const model = createDocsModel('doc', 'Doc');
  const first = mdastToRequests(parseMarkdown(markdown), {
    from: PATH,
    ...(media.images === undefined ? {} : { images: media.images }),
  });
  const replies = model.apply(first.requests);
  model.apply(footnoteRequests(first.footnotes, replies, 0, model.document()));

  const patch = plan(markdown, next, model.document(), media);
  const answers = model.apply(patch.requests);
  model.apply(footnoteRequests(patch.footnotes, answers, 0, model.document()));
  return model.document();
}

/** The document the plan leaves behind, as Markdown. */
function applied(markdown: string, next: string, media: Media = {}): string {
  return documentToMarkdown(patched(markdown, next, media), convertOptions(media));
}

/**
 * How many paragraphs the body holds, tables' cells not counted. Markdown
 * cannot show an empty paragraph, so a stray one is only visible here.
 */
function paragraphs(doc: DocsDocument): number {
  return (doc.body?.content ?? []).filter((element) => element.paragraph !== undefined).length;
}

describe('an edited paragraph', () => {
  it('inserts only the characters that were added', () => {
    // "One." is 1..6, so the second paragraph starts at 6 and the word goes in
    // four characters into it. Nothing else is addressed at all.
    const patch = plan('One.\n\nTwo words here.\n', 'One.\n\nTwo other words here.\n');

    expect(kinds(patch.requests)).toEqual(['insertText']);
    expect(patch.requests[0]?.insertText).toEqual({ location: { index: 10 }, text: 'other ' });
    expect(patch.counts).toEqual({ kept: 1, updated: 1, inserted: 0, deleted: 0 });
  });

  it('replaces a word with the new text first and the old range after', () => {
    // A replacement is an insertion at the end of what goes and a deletion of
    // it: higher index first, which is what descending order means here.
    const patch = plan('One.\n\nTwo words here.\n', 'One.\n\nTwo lines here.\n');

    expect(kinds(patch.requests)).toEqual(['insertText', 'deleteContentRange']);
    expect(patch.requests[0]?.insertText).toEqual({ location: { index: 15 }, text: 'lines' });
    expect(patch.requests[1]?.deleteContentRange).toEqual({
      range: { startIndex: 10, endIndex: 15 },
    });
    expect(applied('One.\n\nTwo words here.\n', 'One.\n\nTwo lines here.\n')).toBe(
      'One.\n\nTwo lines here.\n',
    );
  });

  it('never names a colour in the fields it sets', () => {
    const doc = document('A red paragraph here.\n');
    const run = doc.body?.content?.[1]?.paragraph?.elements?.[0]?.textRun;
    if (run === undefined) throw new Error('no run');
    run.textStyle = { foregroundColor: { color: { rgbColor: { red: 1 } } } };

    const patch = plan('A red paragraph here.\n', 'A **red** paragraph there.\n', doc);
    const fields = patch.requests
      .map((request) => (request.updateTextStyle as { fields?: string } | undefined)?.fields)
      .filter((one) => one !== undefined);

    expect(fields).toEqual(['bold']);
    expect(JSON.stringify(patch.requests)).not.toContain('foregroundColor');
  });

  it('leaves a footnote reference standing when the edit is before it', () => {
    const base = 'Text before the marker.[^1]\n\n[^1]: The note.\n';
    const patch = plan(base, 'Text after the marker.[^1]\n\n[^1]: The note.\n');

    expect(kinds(patch.requests)).toEqual(['insertText', 'deleteContentRange']);
    expect(applied(base, 'Text after the marker.[^1]\n\n[^1]: The note.\n')).toBe(
      'Text after the marker.[^1]\n\n[^1]: The note.\n',
    );
  });

  it('writes a soft line break as the vertical tab Docs keeps it as', () => {
    const patch = plan('One line.\n', 'One line.\\\nAnd another.\n');
    const insert = patch.requests.find((request) => 'insertText' in request) as {
      insertText: { text: string };
    };

    expect(insert.insertText.text).toBe('And another.');
  });
});

describe('the requests of one batch', () => {
  it('are in descending index order, so an earlier range stays valid', () => {
    const base = 'One.\n\nTwo.\n\nThree.\n\nFour.\n';
    const patch = plan(base, 'One edited.\n\nTwo.\n\nInserted.\n\nThree edited.\n');

    expect(indices(patch.requests)).toEqual([...indices(patch.requests)].sort((a, b) => b - a));
    expect(applied(base, 'One edited.\n\nTwo.\n\nInserted.\n\nThree edited.\n')).toBe(
      'One edited.\n\nTwo.\n\nInserted.\n\nThree edited.\n',
    );
  });

  it('deletes a block over the whole of its range, its newline included', () => {
    const patch = plan('One.\n\nTwo.\n\nThree.\n', 'One.\n\nThree.\n');

    expect(kinds(patch.requests)).toEqual(['deleteContentRange']);
    expect(patch.requests[0]?.deleteContentRange).toEqual({
      range: { startIndex: 6, endIndex: 11 },
    });
    expect(patch.counts).toEqual({ kept: 2, updated: 0, inserted: 0, deleted: 1 });
  });

  it('appends at the end of the body without touching the last paragraph', () => {
    const base = 'One.\n\nTwo.\n';
    expect(applied(base, 'One.\n\nTwo.\n\nThree.\n')).toBe('One.\n\nTwo.\n\nThree.\n');

    const patch = plan(base, 'One.\n\nTwo.\n\nThree.\n');
    expect(patch.counts).toEqual({ kept: 2, updated: 0, inserted: 1, deleted: 0 });
    // Nothing addresses an index inside "Two.", which is what keeps its
    // formatting, its comments and its bullet where they are.
    expect(indices(patch.requests).every((index) => index >= 9)).toBe(true);
    // The paragraph the split leaves behind is the one the new block goes
    // into, not one more empty paragraph at the end.
    expect(paragraphs(patched(base, 'One.\n\nTwo.\n\nThree.\n'))).toBe(
      paragraphs(document(base)) + 1,
    );
  });

  it('inserts two new blocks in the order they were written', () => {
    expect(applied('One.\n\nFour.\n', 'One.\n\nTwo.\n\nThree.\n\nFour.\n')).toBe(
      'One.\n\nTwo.\n\nThree.\n\nFour.\n',
    );
  });
});

describe('a block whose type changed', () => {
  it('is one paragraph style request, not a rewrite', () => {
    const patch = plan('A line of text.\n', '## A line of text.\n');

    expect(kinds(patch.requests)).toEqual(['updateParagraphStyle']);
    expect(patch.requests[0]?.updateParagraphStyle).toEqual({
      range: { startIndex: 1, endIndex: 17 },
      paragraphStyle: { namedStyleType: 'HEADING_2' },
      fields: 'namedStyleType',
    });
    expect(patch.counts).toEqual({ kept: 0, updated: 1, inserted: 0, deleted: 0 });
  });

  it('keeps the text it can and edits the rest in place', () => {
    expect(applied('# A heading here.\n', 'A paragraph here.\n')).toBe('A paragraph here.\n');
  });

  it('turns a list item into a paragraph by taking its bullet away', () => {
    expect(applied('- an item of a list\n', 'an item of a list\n')).toBe('an item of a list\n');
  });

  it('turns a paragraph into a list item by giving it one', () => {
    expect(applied('an item of a list\n', '- an item of a list\n')).toBe('- an item of a list\n');
  });
});

describe('a table', () => {
  const base = '| Name | Value |\n| ---- | ----- |\n| a    | b     |\n';

  it('has one cell patched in place', () => {
    const next = '| Name | Value |\n| ---- | ----- |\n| a    | c     |\n';
    const patch = plan(base, next);

    expect(kinds(patch.requests)).toEqual(['insertText', 'deleteContentRange']);
    expect(applied(base, next)).toBe(next);
  });

  it('gets a new block before it by splitting the paragraph before it', () => {
    // Docs inserts nothing at a table's own index: the paragraph before the
    // table lends its newline, as at the end of the body (ticket 33 follow-up).
    const before = `One.\n\n${base}`;
    const next = `One.\n\nTwo.\n\n${base}`;
    const patch = plan(before, next);

    expect(kinds(patch.requests).slice(0, 3)).toEqual([
      'insertText',
      'deleteParagraphBullets',
      'insertText',
    ]);
    // The newline goes in one index before the table, never at the table.
    const split = patch.requests[0]?.insertText as { location: { index: number }; text: string };
    const text = patch.requests[2]?.insertText as { location: { index: number } };
    expect(split.text).toBe('\n');
    expect(text.location.index).toBe(split.location.index + 1);
    expect(applied(before, next)).toBe(next);
    // One paragraph more, not two: the split's leftover holds the new block.
    expect(paragraphs(patched(before, next))).toBe(paragraphs(document(before)) + 1);
  });

  it('gets two new blocks before it in one split', () => {
    const before = `One.\n\n${base}`;
    const next = `One.\n\nTwo.\n\nThree.\n\n${base}`;
    expect(applied(before, next)).toBe(next);
    expect(paragraphs(patched(before, next))).toBe(paragraphs(document(before)) + 2);
  });

  it('keeps a nested insertion before a new list that lands at the same index', () => {
    // The real case: the children of a list item are replaced, and a new list
    // is added after that item, right before a table. Both insertions land at
    // the index where the table starts, and the later one must go in first.
    const before = `1. **Final**\n   1. Old one.\n   2. Old two.\n   3. Old three.\n\n${base}`;
    // Two lists in a row alternate their markers: that is a second list.
    const next = `1. **Final**\n   1. Replacement text.\n\n1) New one.\n2) New two.\n\n${base}`;
    expect(applied(before, next)).toBe(next);
  });

  it('gains a row without rewriting the rows it has', () => {
    const next = '| Name | Value |\n| ---- | ----- |\n| a    | b     |\n| c    | d     |\n';
    const patch = plan(base, next);

    expect(kinds(patch.requests)[0]).toBe('insertTableRow');
    expect(applied(base, next)).toBe(next);
  });

  it('loses a row by deleting the row', () => {
    const next = '| Name | Value |\n| ---- | ----- |\n';
    const patch = plan(base, next);

    expect(kinds(patch.requests)).toEqual(['deleteTableRow']);
    expect(applied(base, next)).toBe(next);
  });

  it('with a new column is rewritten whole, and says so', () => {
    const next = '| Name | Value | More |\n| ---- | ----- | ---- |\n| a    | b     | c    |\n';
    const patch = plan(base, next);

    expect(patch.rewritten).toEqual(['table']);
    expect(applied(base, next)).toBe(next);
  });
});

describe('what the API cannot write', () => {
  it('names a horizontal rule the push had to drop', () => {
    const patch = plan('One.\n', 'One.\n\n---\n');

    expect(patch.dropped).toEqual(['horizontal rule']);
  });

  it('overwrites a pending suggestion inside an edited paragraph, and names it', () => {
    const doc = document('A suggested paragraph.\n');
    const run = doc.body?.content?.[1]?.paragraph?.elements?.[0]?.textRun;
    if (run === undefined) throw new Error('no run');
    run.suggestedDeletionIds = ['suggest.1'];

    const patch = plan('A suggested paragraph.\n', 'A rewritten paragraph.\n', doc);

    expect(patch.suggestions).toEqual(['suggest.1']);
    // The whole run goes and comes back as plain text, which is the only way
    // this API has of resolving a suggestion (MANUAL §7).
    expect(kinds(patch.requests)).toEqual(['deleteContentRange', 'insertText', 'updateTextStyle']);
  });
});

describe('a placeholder', () => {
  /** A document holding what no request can create: a table of contents. */
  function withContents(): DocsDocument {
    return {
      documentId: 'doc',
      title: 'Doc',
      body: {
        content: [
          { endIndex: 1, sectionBreak: {} },
          { startIndex: 1, endIndex: 2, tableOfContents: {} },
          {
            startIndex: 2,
            endIndex: 12,
            paragraph: {
              elements: [{ startIndex: 2, endIndex: 12, textRun: { content: 'After it.\n' } }],
              paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
            },
          },
        ],
      },
    };
  }

  const base = '<!-- docsync:block gdocs:doc#1 type=table-of-contents -->\n\nAfter it.\n';

  it('is refused when it is edited, since nothing could write it back', () => {
    expect(() =>
      plan(
        base,
        '<!-- docsync:block gdocs:doc#9 type=table-of-contents -->\n\nAfter it.\n',
        withContents(),
      ),
    ).toThrow('a table-of-contents cannot be edited through docsync');
  });

  it('is deleted by deleting the block it stands for', () => {
    const patch = plan(base, 'After it.\n', withContents());

    expect(kinds(patch.requests)).toEqual(['deleteContentRange']);
    expect(patch.requests[0]?.deleteContentRange).toEqual({
      range: { startIndex: 1, endIndex: 2 },
    });
  });
});

describe('an image inside a paragraph of text', () => {
  const ASSET = 'drive/Doc.assets/chart.png';
  const URI = 'https://drive.test/chart.png';
  const media = {
    images: new Map([[ASSET, URI]]),
    assets: new Map([['kix.img1', ASSET]]),
  };
  const text = 'See the chart.\n';
  const withImage = 'See the chart. ![](Doc.assets/chart.png)\n';

  it('is inserted as the object it is, not as text', () => {
    const patch = plan(text, withImage, document(text, media), media);

    expect(kinds(patch.requests)).toEqual(['insertText', 'insertInlineImage']);
    expect(patch.requests[1]?.insertInlineImage).toEqual({ location: { index: 16 }, uri: URI });
    expect(patch.counts).toEqual({ kept: 0, updated: 1, inserted: 0, deleted: 0 });
    expect(applied(text, withImage, media)).toBe(withImage);
  });

  it('is deleted as one range covering the object', () => {
    const patch = plan(withImage, text, document(withImage, media), media);

    expect(kinds(patch.requests)).toEqual(['deleteContentRange']);
    expect(patch.requests[0]?.deleteContentRange).toEqual({
      range: { startIndex: 15, endIndex: 17 },
    });
    expect(applied(withImage, text, media)).toBe(text);
  });

  it('is left alone when only its alt changed, which the API cannot set', () => {
    const next = 'See the chart. ![a chart](Doc.assets/chart.png)\n';
    const patch = plan(withImage, next, document(withImage, media), media);

    expect(patch.requests).toEqual([]);
    expect(patch.counts).toEqual({ kept: 0, updated: 1, inserted: 0, deleted: 0 });
  });

  it('is dropped, not written as a character, when nothing staged the file', () => {
    const patch = plan(text, withImage, document(text, media), { assets: media.assets });

    expect(patch.dropped).toEqual(['image']);
    expect(JSON.stringify(patch.requests)).not.toContain('￼');
  });

  it('leaves an image on a line of its own the block it always was', () => {
    const base = `Text.\n\n![](Doc.assets/chart.png)\n`;
    const patch = plan(base, 'Text.\n', document(base, media), media);

    expect(kinds(patch.requests)).toEqual(['deleteContentRange']);
    expect(applied(base, 'Text.\n', media)).toBe('Text.\n');
    expect(applied('Text.\n', base, media)).toBe(base);
  });
});

describe('a footnote body', () => {
  it('is patched inside its own segment', () => {
    const base = 'Body.[^1]\n\n[^1]: The first note.\n';
    const next = 'Body.[^1]\n\n[^1]: The second note.\n';
    const patch = plan(base, next);

    expect(patch.requests.every((request) => JSON.stringify(request).includes('segmentId'))).toBe(
      true,
    );
    expect(applied(base, next)).toBe(next);
  });
});

describe('a page break', () => {
  const base = 'One.\n\n<!-- docsync:pagebreak -->\n\nTwo.\n';

  it('is a block of its own, so an insertion before it lands before it', () => {
    const next = 'One.\n\nNew.\n\n<!-- docsync:pagebreak -->\n\nTwo.\n';
    const patch = plan(base, next);

    // The new paragraph is written at the start of the break's own block, not
    // after it, because the break is a block and not a prefix of "Two.".
    expect(kinds(patch.requests)[0]).toBe('insertText');
    expect(patch.requests[0]?.insertText).toEqual({ location: { index: 6 }, text: 'New.\n' });
    expect(applied(base, next)).toBe(next);
  });

  it('is created where the dialect puts it', () => {
    const next =
      'One.\n\n<!-- docsync:pagebreak -->\n\nTwo.\n\n<!-- docsync:pagebreak -->\n\nThree.\n';
    const patch = plan(base, next);

    expect(kinds(patch.requests)).toContain('insertPageBreak');
    expect(applied(base, next)).toBe(next);
  });

  it('is deleted without the paragraph it splits', () => {
    const next = 'One.\n\nTwo.\n';
    const patch = plan(base, next);

    // The break is one code unit of its own, and only it is deleted: the two
    // paragraphs it split rejoin, and neither is rewritten.
    expect(kinds(patch.requests)).toEqual(['deleteContentRange']);
    expect(patch.requests[0]?.deleteContentRange).toEqual({
      range: { startIndex: 6, endIndex: 7 },
    });
    expect(applied(base, next)).toBe(next);
  });
});

describe('a deleted list item', () => {
  it('takes its nested items with it', () => {
    const base = '- one\n  - nested a\n  - nested b\n- two\n';
    const next = '- two\n';
    const patch = plan(base, next);

    // One deletion, over the item and everything under it: not the lead line
    // alone, which would leave the children hanging under what came before.
    expect(kinds(patch.requests)).toEqual(['deleteContentRange']);
    expect(applied(base, next)).toBe(next);
  });

  it('does not swallow text inserted where it was', () => {
    const base = '- one\n  - nested a\n- two\n';
    const next = '- two\n\nA new paragraph at the end.\n';

    expect(applied(base, next)).toBe(next);
  });
});
