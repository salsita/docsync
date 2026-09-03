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
import { markdownToRequests } from './from-markdown.js';
import { planPatch } from './patch.js';
import { readLive } from './ranges.js';
import { documentToMarkdown } from './to-markdown.js';
import { footnoteRequests } from './write.js';

/** A live document holding exactly what the Markdown says. */
function document(markdown: string): DocsDocument {
  const model = createDocsModel('doc', 'Doc');
  const plan = markdownToRequests(markdown);
  const replies = model.apply(plan.requests);
  model.apply(footnoteRequests(plan.footnotes, replies, 0, model.document()));
  // The fixture of the test is the round trip: if the document does not say
  // what the base says, the test is measuring the generator, not the patch.
  expect(documentToMarkdown(model.document())).toBe(markdown);
  return model.document();
}

function plan(base: string, next: string, doc = document(base)) {
  const live = readLive(doc);
  expect(live.markdown).toBe(base);
  return planPatch(live, diffBlocks(parseMarkdown(base), parseMarkdown(next)), {
    path: 'drive/Doc.md',
  });
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

/** The document the plan leaves behind, as Markdown. */
function applied(markdown: string, next: string): string {
  const model = createDocsModel('doc', 'Doc');
  const first = markdownToRequests(markdown);
  const replies = model.apply(first.requests);
  model.apply(footnoteRequests(first.footnotes, replies, 0, model.document()));

  const patch = plan(markdown, next, model.document());
  const answers = model.apply(patch.requests);
  model.apply(footnoteRequests(patch.footnotes, answers, 0, model.document()));
  return documentToMarkdown(model.document());
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
