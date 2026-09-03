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
