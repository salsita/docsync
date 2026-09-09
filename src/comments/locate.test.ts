import { describe, expect, it } from 'vitest';
import { headingsOf, locate } from './locate.js';

const body = [
  'Intro before any heading.',
  '',
  '# One',
  '',
  '## Two',
  '',
  'A paragraph under two headings, with **bold** in it.',
  '',
  '- a list item holding a needle',
  '  and a second line of the same item',
  '- another item',
  '',
  '| Name | Value |',
  '| ---- | ----- |',
  '| a cell holding a pin | plain |',
  '',
  '### Three',
  '',
  'The word twice: once here.',
  '',
  'The word twice: and once there.',
  '',
].join('\n');

describe('locate', () => {
  it('quotes the paragraph and names the nearest heading above it', () => {
    const found = locate(body, 'bold');

    expect(found?.quote).toBe('A paragraph under two headings, with **bold** in it.');
    expect(found?.heading).toBe('Two');
  });

  it('marks the quoted text where it sits in the paragraph', () => {
    const found = locate(body, 'under two headings');
    const [start, end] = found?.mark ?? [0, 0];

    expect(found?.quote.slice(start, end)).toBe('under two headings');
  });

  it('has no heading for an anchor above the first one', () => {
    const found = locate(body, 'Intro before');

    expect(found?.quote).toBe('Intro before any heading.');
    expect(found?.heading).toBeUndefined();
  });

  it('answers nothing when the text is nowhere in the body', () => {
    expect(locate(body, 'a sentence that is not there')).toBeUndefined();
  });

  it('takes the first paragraph when the text is in two of them', () => {
    const found = locate(body, 'The word twice');

    expect(found?.quote).toBe('The word twice: once here.');
    expect(found?.offset).toBe(body.indexOf('The word twice: once here.'));
  });

  it('quotes the whole list item, both its lines', () => {
    const found = locate(body, 'a needle');

    expect(found?.quote).toBe(
      '- a list item holding a needle\n  and a second line of the same item',
    );
    expect(found?.heading).toBe('Two');
  });

  it('quotes the whole table cell', () => {
    const found = locate(body, 'a pin');

    expect(found?.quote).toBe('a cell holding a pin');
  });

  it('matches across the line break inside one paragraph', () => {
    const wrapped = 'A sentence that runs\nover two lines.\n';

    expect(locate(wrapped, 'runs over two')?.quote).toBe('A sentence that runs\nover two lines.');
  });

  it('answers one block, not a run, when one block holds the quote', () => {
    expect(locate(body, 'bold')?.blocks).toBe(1);
  });

  it('matches a heading itself, and names the heading above it', () => {
    const found = locate(body, 'Three');

    expect(found?.quote).toBe('### Three');
    expect(found?.heading).toBe('Two');
  });
});

describe('headingsOf', () => {
  it('answers the nearest heading above an offset, and nothing above the first', () => {
    const headings = headingsOf(body);

    expect(headings(0)).toBeUndefined();
    expect(headings(body.indexOf('A paragraph under'))).toBe('Two');
    expect(headings(body.length)).toBe('Three');
  });
});

/**
 * A selection can run over a block boundary, and then the quote is in no single
 * block (MANUAL §6, ticket 34).
 */
describe('locate over a run of blocks', () => {
  const two = ['# Head', '', 'The end of one paragraph.', '', 'The start of the next.', ''].join(
    '\n',
  );

  it('quotes both blocks, joined by a blank line, and marks across them', () => {
    const found = locate(two, 'of one paragraph. The start of');

    expect(found?.quote).toBe('The end of one paragraph.\n\nThe start of the next.');
    expect(found?.blocks).toBe(2);
    expect(found?.offset).toBe(two.indexOf('The end'));
    expect(found?.heading).toBe('Head');
    const [start, end] = found?.mark ?? [0, 0];
    expect(found?.quote.slice(start, end)).toBe('of one paragraph.\n\nThe start of');
  });

  it('runs from a list item into the paragraph after it', () => {
    const mixed = ['- an item that ends here', '', 'and a paragraph after it', ''].join('\n');
    const found = locate(mixed, 'ends here and a paragraph');

    expect(found?.quote).toBe('- an item that ends here\n\nand a paragraph after it');
    expect(found?.blocks).toBe(2);
  });

  it('takes the shortest run: a third block it does not need is not quoted', () => {
    const three = ['One here.', '', 'Two there.', '', 'Three everywhere.', ''].join('\n');

    expect(locate(three, 'here. Two there.')?.quote).toBe('One here.\n\nTwo there.');
  });

  it('stays fast on a long body with many quotes that are nowhere in it', () => {
    // A push that suggested left a contract with 900 blocks and a hundred
    // threads; the run search must be one pass per quote, not one per block.
    const body = Array.from(
      { length: 900 },
      (_, i) => `Paragraph number ${i} says a few words.`,
    ).join('\n\n');
    const started = Date.now();
    for (let i = 0; i < 100; i += 1) {
      expect(locate(body, `nothing like this ${i} is in the document at all`)).toBeUndefined();
    }
    expect(locate(body, 'words. Paragraph number 500 says')).toMatchObject({ blocks: 2 });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('answers nothing when even a run of blocks does not hold the quote', () => {
    expect(locate(two, 'of one paragraph. Something else')).toBeUndefined();
  });

  it('does not span blocks when the caller says a quote is one block', () => {
    expect(locate(two, 'of one paragraph. The start of', { spans: false })).toBeUndefined();
    // And a quote that does fit in one block is still found with spans off.
    expect(locate(two, 'The start of the next.', { spans: false })?.quote).toBe(
      'The start of the next.',
    );
  });
});
