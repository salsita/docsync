/**
 * The map from the base blocks to the live document's index ranges.
 *
 * Everything here is checked against the *document*: a block's text is read
 * back out of the runs its ranges name, so a range that is one code unit out
 * fails rather than merely looking plausible.
 */
import { describe, expect, it } from 'vitest';
import { flattenBlocks } from '../diff/blocks.js';
import { plainOf } from '../diff/text.js';
import { parseMarkdown } from '../markdown.js';
import type { DocsDocument, StructuralElement } from './api.js';
import { DOC_IDS, fixtureDocument } from './fixtures.mock.js';
import { blockRanges, type Ranged, readLive } from './ranges.js';
import { documentToMarkdown } from './to-markdown.js';

/**
 * The document as one string, indexed the way the API indexes it: every
 * element contributes exactly as many code units as its range is wide, and one
 * that is not text contributes object replacement characters.
 */
function characters(doc: DocsDocument, segmentId?: string): string {
  const out: string[] = [];
  const put = (start: number, end: number, text: string): void => {
    while (out.length < start) out.push('�');
    for (let at = start; at < end; at += 1) out[at] = text[at - start] ?? '￼';
  };

  const content = (elements: readonly StructuralElement[]): void => {
    for (const element of elements) {
      for (const one of element.paragraph?.elements ?? []) {
        put(one.startIndex ?? 0, one.endIndex ?? 0, one.textRun?.content ?? '');
      }
      for (const row of element.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) content(cell.content ?? []);
      }
    }
  };

  content(
    segmentId === undefined
      ? (doc.body?.content ?? [])
      : (doc.footnotes?.[segmentId]?.content ?? []),
  );
  // A soft line break is a vertical tab in the document and a newline in the
  // text the dialect reads out of it (MANUAL §6). One code unit either way.
  return out.join('').replaceAll('', '\n');
}

/** Every block of a tree, parents first. */
function all(blocks: readonly Ranged[]): Ranged[] {
  return blocks.flatMap((block) => [block, ...all(block.children)]);
}

/** The type and Markdown of every block, for comparing two flattenings. */
function shape(
  blocks: readonly { type: string; markdown: string; children: unknown[] }[],
): unknown {
  return blocks.map((block) => ({
    type: block.type,
    markdown: block.markdown,
    children: shape(block.children as never),
  }));
}

/**
 * The block's own text, read out of the document at the indices its pieces
 * name. An atomic piece — a footnote reference, an image — is not text in the
 * document at all, so what it stands for in the Markdown is taken as read; the
 * point of the check is every other character.
 */
function textOf(doc: DocsDocument, ranged: Ranged): string {
  const text = characters(doc, ranged.segmentId);
  const own = plainOf(ranged.block.inline ?? []);
  return ranged.pieces
    .map((piece) =>
      piece.atomic === true
        ? own.slice(piece.at, piece.at + (piece.text ?? 0))
        : text.slice(piece.start, piece.start + (piece.text ?? 0)),
    )
    .join('');
}

describe('every recorded Doc', () => {
  for (const id of DOC_IDS) {
    it(`maps ${id} block by block`, () => {
      const doc = fixtureDocument(id);
      const live = readLive(doc);

      // The derived body is the body the fetch writes: no suggestions in these.
      expect(live.markdown).toBe(documentToMarkdown(doc));
      expect(shape(live.blocks.map((one) => one.block))).toEqual(
        shape(flattenBlocks(parseMarkdown(live.markdown))),
      );

      for (const ranged of all(live.blocks)) {
        expect(textOf(doc, ranged)).toBe(plainOf(ranged.block.inline ?? []));
        expect(ranged.end).toBeGreaterThan(ranged.start);
      }
    });
  }

  it('reads a table cell back out of the cell it names', () => {
    const doc = fixtureDocument('1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4');
    const live = readLive(doc);
    const table = live.blocks.find((one) => one.block.type === 'table');
    const row = table?.children[0];
    const text = characters(doc);

    expect(row?.cells).toBeDefined();
    expect(
      (row?.cells ?? []).map((cell) =>
        cell.pieces
          .map((piece) => text.slice(piece.start, piece.start + (piece.text ?? 0)))
          .join(''),
      ),
    ).toEqual(['Name', 'Value']);
  });
});

/** A document built by hand, for the cases no fixture holds. */
function paragraphs(...content: string[][]): DocsDocument {
  let index = 1;
  const body: StructuralElement[] = [{ endIndex: 1, sectionBreak: {} }];
  for (const runs of content) {
    const elements = runs.map((text) => {
      const one = { startIndex: index, endIndex: index + text.length, textRun: { content: text } };
      index += text.length;
      return one;
    });
    body.push({
      startIndex: elements[0]?.startIndex ?? index,
      endIndex: index,
      paragraph: { elements, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } },
    });
  }
  return { documentId: 'hand', title: 'Hand', body: { content: body } };
}

describe('a paragraph', () => {
  it('split by a page break maps to two blocks inside one element', () => {
    const doc = paragraphs(['Before\n']);
    const element = doc.body?.content?.[1];
    const paragraph = element?.paragraph;
    if (paragraph === undefined || element === undefined) throw new Error('no paragraph');
    // Before | page break | After, all in the one structural element.
    paragraph.elements = [
      { startIndex: 1, endIndex: 7, textRun: { content: 'Before' } },
      { startIndex: 7, endIndex: 8, pageBreak: {} },
      { startIndex: 8, endIndex: 14, textRun: { content: 'After\n' } },
    ];
    element.endIndex = 14;

    const live = readLive(doc);
    expect(live.markdown).toBe('Before\n\n<!-- docsync:pagebreak -->\n\nAfter\n');
    const [before, after] = live.blocks;
    expect(before?.start).toBe(1);
    expect(before?.end).toBe(7);
    expect(after?.start).toBe(8);
    expect(after?.end).toBe(14);
  });

  it('counts an emoji as the two code units the API counts', () => {
    const doc = paragraphs(['A 🎈 balloon\n']);
    const [block] = readLive(doc).blocks;
    const piece = block?.pieces[0];

    expect(plainOf(block?.block.inline ?? []).length).toBe(12);
    expect(piece?.start).toBe(1);
    expect(piece?.text).toBe(12);
    expect(block?.end).toBe(14);
  });

  it('carries a suggested deletion and drops a suggested insertion', () => {
    const doc = paragraphs(['Kept ', 'gone ', 'new ', 'tail\n']);
    const elements = doc.body?.content?.[1]?.paragraph?.elements ?? [];
    const gone = elements[1]?.textRun;
    const fresh = elements[2]?.textRun;
    if (gone === undefined || fresh === undefined) throw new Error('no runs');
    gone.suggestedDeletionIds = ['suggest.1'];
    fresh.suggestedInsertionIds = ['suggest.2'];

    const live = readLive(doc);
    // The base is the document without the suggestions applied: what was there
    // before anyone suggested anything.
    expect(live.markdown).toBe('Kept gone tail\n');
    expect(live.suggestions).toEqual(['suggest.1', 'suggest.2']);
    expect(live.blocks[0]?.suggestions).toEqual(['suggest.1', 'suggest.2']);
    // The piece after the dropped run still starts where the document has it.
    expect(live.blocks[0]?.pieces.at(-1)?.start).toBe(15);
  });
});

describe('a footnote body', () => {
  it('is ranged inside its own segment', () => {
    const doc = fixtureDocument('1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4');
    const live = readLive(doc);
    const definition = live.blocks.find((one) => one.block.type === 'footnoteDefinition');
    const node = definition?.block.source[0];
    if (node?.type !== 'footnoteDefinition') throw new Error('no footnote definition');
    const inside = blockRanges(node.children);

    expect(definition?.segmentId).toBeDefined();
    expect(inside[0]?.segmentId).toBe(definition?.segmentId);
    expect(textOf(doc, inside[0] as Ranged)).toBe(plainOf(inside[0]?.block.inline ?? []));
  });
});
