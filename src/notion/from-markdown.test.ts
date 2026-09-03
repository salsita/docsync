import { describe, expect, it } from 'vitest';
import {
  type BlockInput,
  inline,
  markdownToBlocks,
  PushError,
  type RichTextInput,
  resolvePath,
} from './from-markdown.js';

/** The blocks one snippet of canonical Markdown produces. */
function blocks(text: string, options: Parameters<typeof markdownToBlocks>[1] = {}): BlockInput[] {
  return markdownToBlocks(text, options);
}

/** The single block one snippet produces, for the one-block-per-type tests. */
function one(text: string): BlockInput {
  const produced = blocks(text);
  expect(produced).toHaveLength(1);
  return produced[0] as BlockInput;
}

const NO_ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

/** A plain text run, the way the module writes one. */
function text(content: string, annotations: Record<string, unknown> = {}, link?: string) {
  return {
    type: 'text',
    text: { content, link: link === undefined ? null : { url: link } },
    annotations: { ...NO_ANNOTATIONS, ...annotations },
    plain_text: content,
    href: link ?? null,
  };
}

/** A mention run, the way the module writes one. */
function mentionRun(mention: Record<string, unknown>, plainText: string) {
  return {
    type: 'mention',
    mention,
    annotations: NO_ANNOTATIONS,
    plain_text: plainText,
    href: null,
  };
}

/** The rich text of a one-paragraph snippet. */
function richText(text: string, options: Parameters<typeof markdownToBlocks>[1] = {}) {
  const block = markdownToBlocks(text, options)[0] as BlockInput;
  return (block.paragraph as { rich_text: RichTextInput[] }).rich_text;
}

describe('blocks', () => {
  it('paragraph', () => {
    expect(one('Hello.\n')).toEqual({
      type: 'paragraph',
      paragraph: { rich_text: [text('Hello.')], color: 'default' },
    });
  });

  it('heading 1, 2 and 3', () => {
    for (const depth of [1, 2, 3]) {
      expect(one(`${'#'.repeat(depth)} Title\n`)).toEqual({
        type: `heading_${depth}`,
        [`heading_${depth}`]: {
          rich_text: [text('Title')],
          is_toggleable: false,
          color: 'default',
        },
      });
    }
  });

  it('refuses a heading Notion has no level for, naming the file and line', () => {
    const call = () => blocks('# One\n\n#### Too deep\n', { from: 'docs/Page.md' });
    expect(call).toThrow(PushError);
    expect(call).toThrow(/docs\/Page\.md:3/);
    try {
      call();
    } catch (error) {
      expect(error).toBeInstanceOf(PushError);
      expect((error as PushError).line).toBe(3);
      expect((error as PushError).path).toBe('docs/Page.md');
    }
  });

  it('names no place when it was given none', () => {
    expect(() => blocks('#### Too deep\n')).toThrow(/three heading levels/);
    expect(new PushError('boom', 'a.md').message).toBe('boom (a.md)');
  });

  it('bulleted list, nested', () => {
    expect(blocks('- Top\n  - Nested\n')).toEqual([
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [text('Top')], color: 'default' },
        children: [
          {
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [text('Nested')], color: 'default' },
          },
        ],
      },
    ]);
  });

  it('numbered list', () => {
    expect(blocks('1. One\n2. Two\n').map((block) => block.type)).toEqual([
      'numbered_list_item',
      'numbered_list_item',
    ]);
  });

  it('to-do, checked and not', () => {
    expect(blocks('- [ ] Open\n- [x] Done\n')).toEqual([
      {
        type: 'to_do',
        to_do: { rich_text: [text('Open')], checked: false, color: 'default' },
      },
      {
        type: 'to_do',
        to_do: { rich_text: [text('Done')], checked: true, color: 'default' },
      },
    ]);
  });

  it('a list item that opens with a nested list has no text of its own', () => {
    expect(blocks('- - Inner\n')).toEqual([
      {
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [], color: 'default' },
        children: [
          {
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [text('Inner')], color: 'default' },
          },
        ],
      },
    ]);
  });

  it('quote, with its extra paragraphs as children', () => {
    expect(one('> One\n>\n> Two\n')).toEqual({
      type: 'quote',
      quote: { rich_text: [text('One')], color: 'default' },
      children: [{ type: 'paragraph', paragraph: { rich_text: [text('Two')], color: 'default' } }],
    });
  });

  it('a blockquote that opens with a list has no text of its own', () => {
    expect(one('> - Item\n')).toEqual({
      type: 'quote',
      quote: { rich_text: [], color: 'default' },
      children: [
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [text('Item')], color: 'default' },
        },
      ],
    });
  });

  it('callout, with its emoji as the icon', () => {
    expect(one('> [!CALLOUT] 💡\n> Body\n')).toEqual({
      type: 'callout',
      callout: {
        rich_text: [text('Body')],
        icon: { type: 'emoji', emoji: '💡' },
        color: 'default',
      },
    });
  });

  it('callout in the escaped spelling some editors produce', () => {
    expect(one('> \\[!CALLOUT] 💡\n> Body\n')).toEqual(one('> [!CALLOUT] 💡\n> Body\n'));
  });

  it('callout with no emoji and no body', () => {
    expect(one('> [!CALLOUT]\n')).toEqual({
      type: 'callout',
      callout: { rich_text: [], color: 'default' },
    });
  });

  it('toggle', () => {
    expect(one('<details>\n<summary>A toggle</summary>\n\nInside\n\n</details>\n')).toEqual({
      type: 'toggle',
      toggle: { rich_text: [text('A toggle')], color: 'default' },
      children: [
        { type: 'paragraph', paragraph: { rich_text: [text('Inside')], color: 'default' } },
      ],
    });
  });

  it('toggle heading', () => {
    expect(one('<details>\n<summary>## Toggle heading</summary>\n\nIn\n\n</details>\n')).toEqual({
      type: 'heading_2',
      heading_2: { rich_text: [text('Toggle heading')], is_toggleable: true, color: 'default' },
      children: [{ type: 'paragraph', paragraph: { rich_text: [text('In')], color: 'default' } }],
    });
  });

  it('refuses a toggle heading Notion has no level for', () => {
    expect(() => blocks('<details>\n<summary>#### Deep</summary>\n\n</details>\n')).toThrow(
      PushError,
    );
  });

  it('a toggle inside a toggle closes at the right tag', () => {
    const text = [
      '<details>',
      '<summary>Outer</summary>',
      '',
      '<details>',
      '<summary>Inner</summary>',
      '',
      'Deep',
      '',
      '</details>',
      '',
      '</details>',
      '',
      'After',
      '',
    ].join('\n');
    const produced = blocks(text);
    expect(produced.map((block) => block.type)).toEqual(['toggle', 'paragraph']);
    expect(produced[0]?.children?.[0]?.type).toBe('toggle');
  });

  it('an unclosed toggle takes the rest of the document', () => {
    const produced = blocks('<details>\n<summary>Open</summary>\n\nInside\n');
    expect(produced).toHaveLength(1);
    expect(produced[0]?.children).toHaveLength(1);
  });

  it('a summary that is not inline content produces no text', () => {
    expect(one('<details>\n<summary>- a list</summary>\n\n</details>\n')).toEqual({
      type: 'toggle',
      toggle: { rich_text: [], color: 'default' },
    });
  });

  it('code with a language, and a fence with none', () => {
    expect(one('```ts\nconst a = 1;\n```\n')).toEqual({
      type: 'code',
      code: { rich_text: [text('const a = 1;')], language: 'ts', caption: [] },
    });
    expect(one('```\nplain\n```\n')).toEqual({
      type: 'code',
      code: { rich_text: [text('plain')], language: 'plain text', caption: [] },
    });
  });

  it('code whose language carries a second word, and an empty fence', () => {
    expect((one('```shell script\nls\n```\n').code as { language: string }).language).toBe(
      'shell script',
    );
    expect((one('```\n```\n').code as { rich_text: unknown[] }).rich_text).toEqual([]);
  });

  it('divider', () => {
    expect(one('---\n')).toEqual({ type: 'divider', divider: {} });
  });

  it('block equation', () => {
    expect(one('$$\nx^2\n$$\n')).toEqual({ type: 'equation', equation: { expression: 'x^2' } });
  });

  it('table, header row on by default', () => {
    expect(one('| a | b |\n| - | - |\n| c | d |\n')).toEqual({
      type: 'table',
      table: { table_width: 2, has_column_header: true, has_row_header: false },
      children: [
        { type: 'table_row', table_row: { cells: [[text('a')], [text('b')]] } },
        { type: 'table_row', table_row: { cells: [[text('c')], [text('d')]] } },
      ],
    });
  });

  it('image paragraph becomes an external image block', () => {
    expect(one('![A caption](https://example.com/x.png)\n')).toEqual({
      type: 'image',
      image: {
        type: 'external',
        external: { url: 'https://example.com/x.png' },
        caption: [text('A caption')],
      },
    });
  });

  it('an image with no alt text has no caption', () => {
    expect((one('![](https://x/y.png)\n').image as { caption: unknown[] }).caption).toEqual([]);
  });

  it('a paragraph that is nothing but one absolute link becomes a file block', () => {
    expect(one('[The name](https://example.com/x.pdf)\n')).toEqual({
      type: 'file',
      file: {
        type: 'external',
        external: { url: 'https://example.com/x.pdf' },
        caption: [text('The name')],
      },
    });
  });

  it('a link with anything beside it stays a paragraph', () => {
    expect(one('See [the name](https://example.com/x.pdf)\n').type).toBe('paragraph');
  });

  it('a paragraph that is one relative link stays a paragraph', () => {
    expect(one('[Leaf](Leaf.md)\n').type).toBe('paragraph');
  });

  it('a paragraph that is one mention stays a paragraph', () => {
    expect(
      blocks('[Leaf](Leaf.md)\n', {
        from: 'Leaf.md',
        ids: new Map([['Leaf.md', 'a'.repeat(32)]]),
      })[0]?.type,
    ).toBe('paragraph');
  });
});

describe('block attributes', () => {
  it('colour on the block below', () => {
    expect(one('<!-- docsync: color=green -->\n\nGreen.\n')).toEqual({
      type: 'paragraph',
      paragraph: { rich_text: [text('Green.')], color: 'green' },
    });
  });

  it('table header flags', () => {
    const table = one('<!-- docsync: header-row=false header-column=true -->\n\n| a |\n| - |\n')
      .table as Record<string, unknown>;
    expect(table).toEqual({ table_width: 1, has_column_header: false, has_row_header: true });
  });

  it('is lenient about keys and spellings it does not know', () => {
    expect(one('<!-- docsync: color=red future=1 broken -->\n\nRed.\n')).toEqual({
      type: 'paragraph',
      paragraph: { rich_text: [text('Red.')], color: 'red' },
    });
  });

  it('applies to the next block only', () => {
    const colors = blocks('<!-- docsync: color=blue -->\n\nOne.\n\nTwo.\n').map(
      (block) => (block.paragraph as { color: string }).color,
    );
    expect(colors).toEqual(['blue', 'default']);
  });

  it('a placeholder produces nothing and clears a pending attribute', () => {
    expect(
      blocks(
        '<!-- docsync: color=blue -->\n\n<!-- docsync:block notion:abc type=embed -->\n\nX.\n',
      ),
    ).toEqual([{ type: 'paragraph', paragraph: { rich_text: [text('X.')], color: 'default' } }]);
  });

  it('ignores HTML it did not write, including a stray close tag', () => {
    expect(blocks('</details>\n\n<figure>x</figure>\n')).toEqual([]);
  });

  it('drops frontmatter and link definitions', () => {
    expect(blocks('---\ntitle: X\n---\n\n[a]: https://example.com\n')).toEqual([]);
  });
});

describe('inline', () => {
  it('each annotation alone', () => {
    expect(richText('**b**\n')).toEqual([text('b', { bold: true })]);
    expect(richText('_i_\n')).toEqual([text('i', { italic: true })]);
    expect(richText('*i*\n')).toEqual([text('i', { italic: true })]);
    expect(richText('~~s~~\n')).toEqual([text('s', { strikethrough: true })]);
    expect(richText('`c`\n')).toEqual([text('c', { code: true })]);
    expect(richText('<u>u</u>\n')).toEqual([text('u', { underline: true })]);
    expect(richText('<span data-color="red">r</span>\n')).toEqual([text('r', { color: 'red' })]);
  });

  it('annotations combine, and close in the right order', () => {
    expect(richText('***<u>x</u>***\n')).toEqual([
      text('x', { bold: true, italic: true, underline: true }),
    ]);
    expect(richText('<u>a</u>b\n')).toEqual([text('a', { underline: true }), text('b')]);
  });

  it('a link, and a link with annotations', () => {
    expect(richText('see [t](https://e.com/)\n')).toEqual([
      text('see '),
      text('t', {}, 'https://e.com/'),
    ]);
    expect(richText('**[t](https://e.com/)**\n')).toEqual([
      text('t', { bold: true }, 'https://e.com/'),
    ]);
  });

  it('an inline equation', () => {
    expect(richText('$E$\n')).toEqual([
      {
        type: 'equation',
        equation: { expression: 'E' },
        annotations: NO_ANNOTATIONS,
        plain_text: 'E',
        href: null,
      },
    ]);
  });

  it('a hard break is a newline inside one run, in either spelling', () => {
    expect(richText('one\\\ntwo\n')).toEqual([text('one\ntwo')]);
    expect(richText('one  \ntwo\n')).toEqual([text('one\ntwo')]);
  });

  it('escapes merge back into one run', () => {
    expect(richText('a \\* b\n')).toEqual([text('a * b')]);
  });

  it('runs that differ in link or annotation are not merged', () => {
    expect(richText('[a](https://x/)[b](https://y/)\n')).toHaveLength(2);
    expect(richText('a**b**\n')).toHaveLength(2);
  });

  it('an inline image keeps its alt text and its URL', () => {
    expect(richText('see ![alt](https://x/y.png)\n')).toEqual([
      text('see '),
      text('alt', {}, 'https://x/y.png'),
    ]);
  });

  it('ignores a footnote reference', () => {
    expect(richText('a[^1]\n\n[^1]: note\n')).toEqual([text('a')]);
  });

  it('is callable on its own', () => {
    expect(inline([{ type: 'text', value: 'x' }])).toEqual([text('x')]);
  });
});

describe('mentions', () => {
  const PAGE = '3cf715cbeb08819db888c032d7bb60de';

  it('a relative link to a page in the checkout', () => {
    expect(
      richText('[Leaf](../Leaf.md)\n', {
        from: 'Blocks/Nested.md',
        ids: new Map([['Leaf.md', PAGE]]),
      }),
    ).toEqual([mentionRun({ type: 'page', page: { id: PAGE } }, 'Leaf')]);
  });

  it('a relative link to a page that is not in the checkout stays a link', () => {
    expect(richText('[Leaf](Leaf.md)\n', { from: 'a.md', ids: new Map() })).toEqual([
      text('Leaf', {}, 'Leaf.md'),
    ]);
  });

  it('a notion.so URL, dashed or not', () => {
    const expected = [mentionRun({ type: 'page', page: { id: PAGE } }, 'T')];
    expect(richText(`[T](https://www.notion.so/${PAGE})\n`)).toEqual(expected);
    expect(richText('[T](https://www.notion.so/3cf715cb-eb08-819d-b888-c032d7bb60de)\n')).toEqual(
      expected,
    );
    expect(richText(`[T](https://www.notion.so/Some-Title-${PAGE})\n`)).toEqual(expected);
  });

  it('a user mention', () => {
    expect(richText('[@Me](notion://user/2e924337300b4281b820a7ff207370b1)\n')).toEqual([
      mentionRun(
        { type: 'user', user: { object: 'user', id: '2e924337300b4281b820a7ff207370b1' } },
        '@Me',
      ),
    ]);
  });

  it('a date mention, and a range', () => {
    expect(richText('[d](notion://date/2026-09-02)\n')).toEqual([
      mentionRun({ type: 'date', date: { start: '2026-09-02', end: null } }, 'd'),
    ]);
    expect(
      (
        richText('[d](notion://date/2026-09-02/2026-09-03)\n')[0] as unknown as {
          mention: unknown;
        }
      ).mention,
    ).toEqual({ type: 'date', date: { start: '2026-09-02', end: '2026-09-03' } });
  });

  it('any other URL stays a link', () => {
    expect(richText('a [x](https://example.com/)\n')).toEqual([
      text('a '),
      text('x', {}, 'https://example.com/'),
    ]);
  });
});

describe('resolvePath', () => {
  it('resolves a link against the file it sits in', () => {
    expect(resolvePath('a/b/c.md', '../d.md')).toBe('a/d.md');
    expect(resolvePath('a/b/c.md', './d.md')).toBe('a/b/d.md');
    expect(resolvePath('c.md', 'd/e.md')).toBe('d/e.md');
  });
});
