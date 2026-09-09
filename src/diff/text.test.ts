import type { Paragraph, PhrasingContent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../markdown.js';
import { diffInline, diffText, inlineRuns, plainOf, type Span } from './text.js';

/** The phrasing content of a one-paragraph Markdown snippet. */
function phrasing(markdown: string): PhrasingContent[] {
  const first = parseMarkdown(markdown).children[0] as Paragraph | undefined;
  return first?.children ?? [];
}

/** The spans, as `keep:text` / `-text` / `+text`, which reads like a diff. */
function shape(spans: readonly Span[]): string[] {
  return spans.map(
    (span) => `${span.kind === 'keep' ? '=' : span.kind === 'delete' ? '-' : '+'}${span.text}`,
  );
}

describe('diffText', () => {
  it('replaces one word and keeps everything around it', () => {
    expect(shape(diffText('the quick brown fox', 'the quick red fox'))).toEqual([
      '=the quick ',
      '-brown',
      '+red',
      '= fox',
    ]);
  });

  it('inserts at the start and at the end', () => {
    expect(shape(diffText('body', 'A body'))).toEqual(['+A ', '=body']);
    expect(shape(diffText('body', 'body and more'))).toEqual(['=body', '+ and more']);
  });

  it('answers one deletion and one insertion for a rewritten sentence', () => {
    expect(shape(diffText('alpha beta gamma', 'nothing alike here'))).toEqual([
      '-alpha beta gamma',
      '+nothing alike here',
    ]);
  });

  it('rewrites short kept islands with the edits around them when asked', () => {
    const base =
      'If we suspend our Services for any reason as per the License Agreement, this is not deemed as unavailability.';
    const next =
      'A suspension of our Services does not count as unavailability only if it is permitted under the License Agreement.';
    // Word by word, "our Services" and "the License Agreement" survive as
    // islands and cut the edit into pieces.
    expect(diffText(base, next).filter((span) => span.kind === 'keep').length).toBeGreaterThan(2);
    // Under four words each, they are rewritten with the edit: one stretch.
    // Only the shared final period is kept, at the end, outside the edit.
    const joined = diffText(base, next, { joinKeptUnder: 4 });
    expect(joined.map((span) => span.kind)).toEqual(['delete', 'insert', 'keep']);
    expect(joined[1]?.text).toBe(next.slice(0, -1));
    expect(joined[2]?.text).toBe('.');
  });

  it('keeps an island of four words or more between two edits', () => {
    const base = 'One two three four five six seven eight nine ten.';
    const next = 'Uno two three four five six seven eight nine diez.';
    const joined = diffText(base, next, { joinKeptUnder: 4 });
    expect(joined.map((span) => span.kind).slice(0, 5)).toEqual([
      'delete',
      'insert',
      'keep',
      'delete',
      'insert',
    ]);
    expect(joined[2]?.text).toBe(' two three four five six seven eight nine ');
  });

  it('answers a single kept span when nothing changed', () => {
    expect(shape(diffText('same', 'same'))).toEqual(['=same']);
  });

  it('reports the offsets in both texts', () => {
    const spans = diffText('one two three', 'one four three');
    expect(spans.map((span) => [span.kind, span.base, span.next])).toEqual([
      ['keep', 0, 0],
      ['delete', 4, 4],
      ['insert', 7, 4],
      ['keep', 7, 8],
    ]);
  });

  it('edits CJK by word and not by the whole run', () => {
    const spans = diffText('中文字符很好', '中文字符很棒');
    expect(spans.some((span) => span.kind === 'keep' && span.text.includes('中文'))).toBe(true);
    expect(spans.filter((span) => span.kind !== 'keep').every((span) => span.text.length < 6)).toBe(
      true,
    );
  });

  it('keeps a multi-codepoint emoji whole', () => {
    expect(shape(diffText('hi 👨‍👩‍👦 there', 'hi 👨‍👩‍👦 friend'))).toEqual([
      '=hi 👨‍👩‍👦 ',
      '-there',
      '+friend',
    ]);
  });
});

describe('inlineRuns', () => {
  it('carries the dialect’s annotations, nesting and all', () => {
    expect(inlineRuns(phrasing('plain **bold _both_** `code`'))).toEqual([
      { text: 'plain ', style: style({}) },
      { text: 'bold ', style: style({ bold: true }) },
      { text: 'both', style: style({ bold: true, italic: true }) },
      { text: ' ', style: style({}) },
      { text: 'code', style: style({ code: true }) },
    ]);
  });

  it('reads underline and colour out of the dialect’s HTML', () => {
    expect(inlineRuns(phrasing('<u>u</u> and <span data-color="red">r</span>'))).toEqual([
      { text: 'u', style: style({ underline: true }) },
      { text: ' and ', style: style({}) },
      { text: 'r', style: style({ color: 'red' }) },
    ]);
  });

  it('carries a link target and reads a line break as a newline', () => {
    expect(inlineRuns(phrasing('a [b](https://x/) c\\\nd'))).toEqual([
      { text: 'a ', style: style({}) },
      { text: 'b', style: style({ link: 'https://x/' }) },
      { text: ' c', style: style({}) },
      { text: '\n', style: style({}) },
      { text: 'd', style: style({}) },
    ]);
  });
});

describe('plainOf', () => {
  it('is the text a reader sees, with no markup at all', () => {
    expect(plainOf(phrasing('**bold** and [a link](https://x/)'))).toBe('bold and a link');
  });
});

describe('an inline image', () => {
  const IMAGE = 'See the chart. ![](X.assets/chart.png)';

  it('is one object replacement character, whatever its alt says', () => {
    expect(plainOf(phrasing(IMAGE))).toBe('See the chart. ￼');
    expect(plainOf(phrasing('See the chart. ![a chart](X.assets/chart.png)'))).toBe(
      'See the chart. ￼',
    );
  });

  it('carries the URL of the image it stands for, for the adapter', () => {
    expect(inlineRuns(phrasing(IMAGE)).at(-1)).toEqual({
      text: '￼',
      style: style({}),
      image: 'X.assets/chart.png',
    });
  });

  it('is one inserted character when an empty-alt image is added', () => {
    const { spans } = diffInline(phrasing('See the chart.'), phrasing(IMAGE));
    expect(shape(spans)).toEqual(['=See the chart.', '+ ￼']);
  });

  it('is one deleted character when an empty-alt image goes', () => {
    const { spans } = diffInline(phrasing(IMAGE), phrasing('See the chart.'));
    expect(shape(spans)).toEqual(['=See the chart.', '- ￼']);
  });

  it('is unchanged text when only the alt changed, which no API can write', () => {
    const { spans, styles } = diffInline(
      phrasing(IMAGE),
      phrasing('See the chart. ![a chart](X.assets/chart.png)'),
    );
    expect(shape(spans)).toEqual(['=See the chart. ￼']);
    expect(styles).toEqual([]);
  });
});

describe('diffInline', () => {
  it('says nothing changed when only the formatting did', () => {
    const { spans, styles } = diffInline(phrasing('one two three'), phrasing('one **two** three'));
    expect(shape(spans)).toEqual(['=one two three']);
    expect(styles).toEqual([{ at: 4, length: 3, style: { bold: true } }]);
  });

  it('reports a changed link target over the text it covers', () => {
    const { styles } = diffInline(
      phrasing('see [here](https://old/) now'),
      phrasing('see [here](https://new/) now'),
    );
    expect(styles).toEqual([{ at: 4, length: 4, style: { link: 'https://new/' } }]);
  });

  it('turns formatting off as readily as on', () => {
    const { styles } = diffInline(phrasing('a **b** c'), phrasing('a b c'));
    expect(styles).toEqual([{ at: 2, length: 1, style: { bold: false } }]);
  });

  it('reports the text edit and the style change together', () => {
    const { spans, styles } = diffInline(phrasing('one two three'), phrasing('one **four** three'));
    expect(shape(spans)).toEqual(['=one ', '-two', '+four', '= three']);
    // The style of inserted text is not a change to kept text: the merge takes
    // it from the inserted run itself (MANUAL §7).
    expect(styles).toEqual([]);
  });

  it('sees a deleted mention as deleted text', () => {
    const { spans } = diffInline(
      phrasing('hi [@Ada](notion://user/abc) there'),
      phrasing('hi there'),
    );
    expect(shape(spans)).toEqual(['=hi ', '-@Ada ', '=there']);
  });

  it('says nothing at all when the block did not change', () => {
    const nodes = phrasing('unchanged **text**');
    const { spans, styles } = diffInline(nodes, phrasing('unchanged **text**'));
    expect(shape(spans)).toEqual(['=unchanged text']);
    expect(styles).toEqual([]);
    expect(spans).toHaveLength(1);
  });
});

/** The default style with the named keys turned on. */
function style(over: Record<string, unknown>) {
  return {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
    link: null,
    ...over,
  };
}
