import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../markdown.js';
import type { NotionBlock } from './api.js';
import { ASSETS, fixtureBlocks, fixtureTitle, PAGE_IDS } from './fixtures.mock.js';
import {
  bareId,
  blocksToMarkdown,
  inline,
  plain,
  type RichText,
  relativePath,
} from './to-markdown.js';

/** A block with a body, the way the API shapes one. */
function block(type: string, body: Record<string, unknown> = {}, id = 'b1'): NotionBlock {
  return { object: 'block', id, type, has_children: false, [type]: body };
}

/** A rich-text run of plain text. */
function text(value: string, annotations: Record<string, unknown> = {}): RichText {
  return {
    type: 'text',
    text: { content: value, link: null },
    plain_text: value,
    href: null,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
      ...annotations,
    },
  };
}

/** A rich-text run of text that carries a link. */
function linked(value: string, url: string, annotations: Record<string, unknown> = {}): RichText {
  return {
    ...text(value, annotations),
    text: { content: value, link: { url } },
    href: url,
  };
}

/** What one block converts to, without the trailing blank line. */
function markdown(blocks: NotionBlock[], from?: string, pages?: Map<string, string>): string {
  return blocksToMarkdown(blocks, { from, pages });
}

function one(type: string, body: Record<string, unknown> = {}): string {
  return markdown([block(type, body)]);
}

/** The rich text of one paragraph, as Markdown. */
function inlineMarkdown(parts: RichText[]): string {
  return markdown([block('paragraph', { rich_text: parts, color: 'default' })]).trim();
}

const LEAF_ID = '3cf715cbeb08819db888c032d7bb60de';

describe('blocks', () => {
  it('paragraph', () => {
    expect(one('paragraph', { rich_text: [text('Hello.')] })).toBe('Hello.\n');
  });

  it('heading 1, 2 and 3', () => {
    expect(one('heading_1', { rich_text: [text('One')] })).toBe('# One\n');
    expect(one('heading_2', { rich_text: [text('Two')] })).toBe('## Two\n');
    expect(one('heading_3', { rich_text: [text('Three')] })).toBe('### Three\n');
  });

  it('bulleted list, nested by two spaces', () => {
    const child = block('bulleted_list_item', { rich_text: [text('Nested')] }, 'b2');
    const parent: NotionBlock = {
      ...block('bulleted_list_item', { rich_text: [text('Top')] }),
      has_children: true,
      children: [child],
    };
    expect(markdown([parent])).toBe('- Top\n  - Nested\n');
  });

  it('numbered list', () => {
    expect(
      markdown([
        block('numbered_list_item', { rich_text: [text('One')] }, 'n1'),
        block('numbered_list_item', { rich_text: [text('Two')] }, 'n2'),
      ]),
    ).toBe('1. One\n2. Two\n');
  });

  it('to-do, checked and not', () => {
    expect(
      markdown([
        block('to_do', { rich_text: [text('Open')], checked: false }, 't1'),
        block('to_do', { rich_text: [text('Done')], checked: true }, 't2'),
      ]),
    ).toBe('- [ ] Open\n- [x] Done\n');
  });

  it('keeps to-dos and bullets in one list, as Markdown cannot tell them apart', () => {
    expect(
      markdown([
        block('bulleted_list_item', { rich_text: [text('Bullet')] }, 'b1'),
        block('to_do', { rich_text: [text('Task')], checked: false }, 't1'),
      ]),
    ).toBe('- Bullet\n- [ ] Task\n');
  });

  it('quote', () => {
    expect(one('quote', { rich_text: [text('Quoted')] })).toBe('> Quoted\n');
  });

  it('quote with a line break inside it', () => {
    expect(one('quote', { rich_text: [text('One\nTwo')] })).toBe('> One\\\n> Two\n');
  });

  it('callout, with its emoji and its body under the marker', () => {
    expect(
      one('callout', {
        rich_text: [text('Body.')],
        icon: { type: 'emoji', emoji: '💡' },
        color: 'gray_background',
      }),
    ).toBe('<!-- docsync: color=gray_background -->\n\n> [!CALLOUT] 💡\\\n> Body.\n');
  });

  it('callout without an icon', () => {
    expect(one('callout', { rich_text: [text('Body.')], icon: null, color: 'default' })).toBe(
      '> [!CALLOUT]\\\n> Body.\n',
    );
  });

  it('toggle', () => {
    const toggle: NotionBlock = {
      ...block('toggle', { rich_text: [text('A toggle')] }),
      has_children: true,
      children: [block('paragraph', { rich_text: [text('Inside.')] }, 'p1')],
    };
    expect(markdown([toggle])).toBe(
      '<details>\n<summary>A toggle</summary>\n\nInside.\n\n</details>\n',
    );
  });

  it('toggle heading', () => {
    const heading: NotionBlock = {
      ...block('heading_2', { rich_text: [text('Toggle heading')], is_toggleable: true }),
      has_children: true,
      children: [block('paragraph', { rich_text: [text('Inside.')] }, 'p1')],
    };
    expect(markdown([heading])).toBe(
      '<details>\n<summary>## Toggle heading</summary>\n\nInside.\n\n</details>\n',
    );
  });

  it('code with a language', () => {
    expect(one('code', { rich_text: [text('const x = 1;')], language: 'typescript' })).toBe(
      '```typescript\nconst x = 1;\n```\n',
    );
  });

  it('code in plain text, which is a fence with no language', () => {
    expect(one('code', { rich_text: [text('just text')], language: 'plain text' })).toBe(
      '```\njust text\n```\n',
    );
  });

  it('code in a language whose name has a space keeps the whole name', () => {
    expect(one('code', { rich_text: [text('x')], language: 'visual basic' })).toBe(
      '```visual basic\nx\n```\n',
    );
  });

  it('code with no language field at all is plain text', () => {
    expect(one('code', { rich_text: [text('x')] })).toBe('```\nx\n```\n');
  });

  it('divider', () => {
    expect(one('divider')).toBe('---\n');
  });

  it('table, with the header flags Notion stores', () => {
    const row = (...cells: string[]): NotionBlock => ({
      object: 'block',
      id: `r${cells[0]}`,
      type: 'table_row',
      has_children: false,
      table_row: { cells: cells.map((cell) => [text(cell)]) },
    });
    const table: NotionBlock = {
      ...block('table', { table_width: 2, has_column_header: true, has_row_header: false }),
      has_children: true,
      children: [row('Name', 'Value'), row('a', 'b')],
    };
    expect(markdown([table])).toBe('| Name | Value |\n| ---- | ----- |\n| a    | b     |\n');

    const flagged: NotionBlock = {
      ...table,
      table: { table_width: 2, has_column_header: false, has_row_header: true },
    };
    expect(markdown([flagged])).toBe(
      '<!-- docsync: header-row=false header-column=true -->\n\n| Name | Value |\n| ---- | ----- |\n| a    | b     |\n',
    );
  });

  it('pads a short table row to the table width', () => {
    const table: NotionBlock = {
      ...block('table', { table_width: 2, has_column_header: true }),
      has_children: true,
      children: [
        {
          object: 'block',
          id: 'r1',
          type: 'table_row',
          has_children: false,
          table_row: { cells: [[text('only')]] },
        },
      ],
    };
    expect(markdown([table])).toBe('| only |   |\n| ---- | - |\n');
  });

  it('falls back to a placeholder for a table with no rows', () => {
    expect(one('table', { table_width: 2, has_column_header: true })).toBe(
      '<!-- docsync:block notion:b1 type=table -->\n',
    );
  });

  it('block equation', () => {
    expect(one('equation', { expression: 'E = mc^2' })).toBe('$$\nE = mc^2\n$$\n');
  });

  it('external image, with its caption as alt text', () => {
    expect(
      one('image', {
        type: 'external',
        external: { url: 'https://example.com/i.png' },
        caption: [text('A picture')],
      }),
    ).toBe('![A picture](https://example.com/i.png)\n');
  });

  it('external file, PDF and video as links', () => {
    for (const type of ['file', 'pdf', 'video']) {
      expect(
        one(type, {
          type: 'external',
          external: { url: 'https://example.com/x' },
          caption: [text('Caption')],
        }),
      ).toBe('[Caption](https://example.com/x)\n');
    }
  });

  it('a file with no caption is linked by its own name', () => {
    expect(
      one('file', { type: 'external', external: { url: 'https://x/y' }, name: 'spec.pdf' }),
    ).toBe('[spec.pdf](https://x/y)\n');
  });

  it('a Notion-hosted file the fetch downloaded is linked into the assets directory', () => {
    const assets = new Map([['b1', 'Specs/Auth.assets/chili.png']]);
    const hosted = block('image', {
      type: 'file',
      file: { url: 'https://prod-files…' },
      caption: [text('Uploaded image')],
    });
    expect(blocksToMarkdown([hosted], { from: 'Specs/Auth.md', assets })).toBe(
      '![Uploaded image](Auth.assets/chili.png)\n',
    );

    const file = block('file', {
      type: 'file',
      file: { url: 'https://prod-files…' },
      name: 'sample-file.bin',
      caption: [],
    });
    expect(
      blocksToMarkdown([file], {
        from: 'Specs/Auth.md',
        assets: new Map([['b1', 'Specs/Auth.assets/sample-file.bin']]),
      }),
    ).toBe('[sample-file.bin](Auth.assets/sample-file.bin)\n');
  });

  it('a Notion-hosted file nobody downloaded is still a placeholder', () => {
    expect(one('image', { type: 'file', file: { url: 'https://prod-files…' }, caption: [] })).toBe(
      '<!-- docsync:block notion:b1 type=image -->\n',
    );
  });

  it('placeholders carry the block id and type', () => {
    for (const type of [
      'bookmark',
      'embed',
      'synced_block',
      'column_list',
      'table_of_contents',
      'breadcrumb',
      'button',
      'link_preview',
      'unsupported',
    ]) {
      expect(one(type)).toBe(`<!-- docsync:block notion:b1 type=${type} -->\n`);
    }
  });

  it('leaves child pages and child databases out of the body', () => {
    expect(
      markdown([
        block('child_page', { title: 'Nested' }, 'c1'),
        block('paragraph', { rich_text: [text('Body.')] }, 'p1'),
        block('child_database', { title: 'A database' }, 'd1'),
      ]),
    ).toBe('Body.\n');
  });

  it('writes a non-default block colour above the block', () => {
    expect(one('paragraph', { rich_text: [text('Green.')], color: 'green' })).toBe(
      '<!-- docsync: color=green -->\n\nGreen.\n',
    );
  });

  it('writes nothing above a default-coloured block', () => {
    expect(one('paragraph', { rich_text: [text('Plain.')], color: 'default' })).toBe('Plain.\n');
  });

  it('keeps blocks nested under a paragraph as following blocks', () => {
    const parent: NotionBlock = {
      ...block('paragraph', { rich_text: [text('Parent.')] }),
      has_children: true,
      children: [block('paragraph', { rich_text: [text('Child.')] }, 'p2')],
    };
    expect(markdown([parent])).toBe('Parent.\n\nChild.\n');
  });

  it('survives a block whose body is missing', () => {
    expect(markdown([{ object: 'block', id: 'b1', type: 'paragraph', has_children: false }])).toBe(
      '',
    );
  });
});

describe('rich text', () => {
  it('each annotation on its own', () => {
    expect(inlineMarkdown([text('bold', { bold: true })])).toBe('**bold**');
    expect(inlineMarkdown([text('italic', { italic: true })])).toBe('_italic_');
    expect(inlineMarkdown([text('struck', { strikethrough: true })])).toBe('~~struck~~');
    expect(inlineMarkdown([text('code', { code: true })])).toBe('`code`');
    expect(inlineMarkdown([text('under', { underline: true })])).toBe('<u>under</u>');
    expect(inlineMarkdown([text('red', { color: 'red' })])).toBe(
      '<span data-color="red">red</span>',
    );
    expect(inlineMarkdown([text('lit', { color: 'yellow_background' })])).toBe(
      '<span data-color="yellow_background">lit</span>',
    );
  });

  it('combines annotations from the inside out, in a fixed order', () => {
    expect(
      inlineMarkdown([
        text('all', {
          bold: true,
          italic: true,
          strikethrough: true,
          underline: true,
          color: 'blue',
        }),
      ]),
    ).toBe('**_~~<u><span data-color="blue">all</span></u>~~_**');
  });

  it('a link, with annotations inside it', () => {
    const link: RichText = {
      ...text('site', { bold: true }),
      text: { content: 'site', link: { url: 'https://example.com' } },
      href: 'https://example.com',
    };
    expect(inlineMarkdown([link])).toBe('[**site**](https://example.com)');
  });

  it('an inline equation', () => {
    expect(
      inlineMarkdown([
        { type: 'equation', equation: { expression: 'a^2' }, plain_text: 'a^2', href: null },
      ]),
    ).toBe('$a^2$');
  });

  it('a mention of a page in the checkout, relative to the file', () => {
    const mention: RichText = {
      type: 'mention',
      mention: { type: 'page', page: { id: '3cf715cb-eb08-819d-b888-c032d7bb60de' } },
      plain_text: 'Leaf',
      href: 'https://app.notion.com/p/3cf715cbeb08819db888c032d7bb60de',
    };
    const pages = new Map([[LEAF_ID, 'Docsync test/Leaf.md']]);
    expect(
      markdown([block('paragraph', { rich_text: [mention] })], 'Docsync test/Blocks.md', pages),
    ).toBe('[Leaf](Leaf.md)\n');
  });

  it('names a mention the API left "Untitled" after the page it points at', () => {
    // Inside a table cell the API labels a page mention "Untitled" whatever
    // the page is called; the file name carries the title.
    const mention: RichText = {
      type: 'mention',
      mention: { type: 'page', page: { id: '3cf715cb-eb08-819d-b888-c032d7bb60de' } },
      plain_text: 'Untitled',
      href: 'https://app.notion.com/p/3cf715cbeb08819db888c032d7bb60de',
    };
    const pages = new Map([[LEAF_ID, 'Docsync test/Lead Qualification.md']]);
    expect(
      markdown([block('paragraph', { rich_text: [mention] })], 'Docsync test/Blocks.md', pages),
    ).toBe('[Lead Qualification](<Lead Qualification.md>)\n');
    // Outside the checkout the label says what Notion will show there.
    expect(inlineMarkdown([mention])).toBe(
      '[{page title}](https://www.notion.so/3cf715cbeb08819db888c032d7bb60de)',
    );
  });

  it('a mention of a page outside the checkout', () => {
    const mention: RichText = {
      type: 'mention',
      mention: { type: 'page', page: { id: '38349858-129f-4c39-a121-0129743b666e' } },
      plain_text: 'Untitled',
      href: 'https://app.notion.com/p/38349858129f4c39a1210129743b666e',
    };
    expect(inlineMarkdown([mention])).toBe(
      '[{page title}](https://www.notion.so/38349858129f4c39a1210129743b666e)',
    );
  });

  it('a mention of a database is always a notion.so link', () => {
    const mention: RichText = {
      type: 'mention',
      mention: { type: 'database', database: { id: '38349858-129f-4c39-a121-0129743b666e' } },
      plain_text: 'Tasks',
      href: null,
    };
    expect(inlineMarkdown([mention])).toBe(
      '[Tasks](https://www.notion.so/38349858129f4c39a1210129743b666e)',
    );
  });

  it('a user mention', () => {
    const mention: RichText = {
      type: 'mention',
      mention: {
        type: 'user',
        user: { object: 'user', id: '2e924337-300b-4281-b820-a7ff207370b1' },
      },
      plain_text: '@Ada Lovelace',
      href: null,
    };
    // Ids are canonical everywhere: undashed, like page ids and placeholders.
    expect(inlineMarkdown([mention])).toBe(
      '[@Ada Lovelace](notion://user/2e924337300b4281b820a7ff207370b1)',
    );
  });

  it('a date mention, plain, with a time, and as a range', () => {
    const date = (value: Record<string, unknown>, label: string): RichText => ({
      type: 'mention',
      mention: { type: 'date', date: { end: null, time_zone: null, ...value } },
      plain_text: label,
      href: null,
    });
    expect(inlineMarkdown([date({ start: '2026-09-02' }, '2026-09-02')])).toBe(
      '[2026-09-02](notion://date/2026-09-02)',
    );
    expect(
      inlineMarkdown([date({ start: '2026-09-02', end: '2026-09-03' }, '2026-09-02 → 2026-09-03')]),
    ).toBe('[2026-09-02 → 2026-09-03](notion://date/2026-09-02/2026-09-03)');
    expect(inlineMarkdown([date({ start: '2026-09-02T10:00:00.000+02:00' }, 'at ten')])).toBe(
      '[at ten](notion://date/2026-09-02T10:00:00.000+02:00)',
    );
  });

  it('a link preview and anything else with a URL is a plain link', () => {
    const preview: RichText = {
      type: 'mention',
      mention: { type: 'link_preview', link_preview: { url: 'https://example.com/x' } },
      plain_text: 'example.com',
      href: 'https://example.com/x',
    };
    expect(inlineMarkdown([preview])).toBe('[example.com](https://example.com/x)');
  });

  it('a mention with neither a shape we know nor a URL keeps its text', () => {
    const odd: RichText = {
      type: 'mention',
      mention: { type: 'template_mention', template_mention: {} },
      plain_text: '@Today',
      href: null,
    };
    expect(inlineMarkdown([odd])).toBe('@Today');
  });

  it('a line break inside one block is a trailing backslash', () => {
    expect(inlineMarkdown([text('one\ntwo')])).toBe('one\\\ntwo');
  });

  it('escapes what Markdown would otherwise read as syntax', () => {
    expect(inline([text('a * b _ c # d [e] f')])).toEqual([
      { type: 'text', value: 'a * b _ c # d [e] f' },
    ]);
    expect(inlineMarkdown([text('a * b _ c [e]')])).toBe('a \\* b \\_ c \\[e]');
  });

  it('survives rich text with nothing in it', () => {
    expect(inlineMarkdown([{ type: 'text' }])).toBe('');
    expect(inlineMarkdown([{ type: 'equation' }])).toBe('$$');
    expect(inlineMarkdown([{ type: 'mention', plain_text: 'x' }])).toBe('x');
  });
});

describe('inline runs', () => {
  it('moves the spaces at the edges of a styled run outside it', () => {
    expect(inlineMarkdown([text('Send the ', { bold: true }), text('memo')])).toBe(
      '**Send the** memo',
    );
    expect(inlineMarkdown([text('a'), text(' b ', { italic: true }), text('c')])).toBe('a _b_ c');
    expect(inlineMarkdown([text('a'), text(' b ', { strikethrough: true }), text('c')])).toBe(
      'a ~~b~~ c',
    );
    // A run that is nothing but spaces has nothing to wrap, and so wraps nothing.
    expect(inlineMarkdown([text('a'), text(' ', { bold: true }), text('b')])).toBe('a b');
    expect(inlineMarkdown([text('', { bold: true }), text('x')])).toBe('x');
  });

  it('keeps the link and the html wrappers around all of the pieces', () => {
    expect(inlineMarkdown([linked(' x ', 'https://example.com/', { bold: true })])).toBe(
      '[ **x** ](https://example.com/)',
    );
    // `<u>` and `<span>` hold a space perfectly well, so they stay outside the
    // pieces rather than being shed with the emphasis.
    expect(inlineMarkdown([text(' x ', { bold: true, underline: true, color: 'red' })])).toBe(
      '<u><span data-color="red"> </span></u>' +
        '**<u><span data-color="red">x</span></u>**' +
        '<u><span data-color="red"> </span></u>',
    );
  });

  it('leaves a code run and a mention alone', () => {
    // The spaces are the code's own content, and a mention is atomic.
    expect(inline([text(' b ', { code: true, bold: true })])).toEqual([
      { type: 'strong', children: [{ type: 'inlineCode', value: ' b ' }] },
    ]);
    // A mention is atomic: its label is the source's, not text we may cut.
    expect(
      inlineMarkdown([{ type: 'mention', plain_text: ' who ', annotations: { bold: true } }]),
    ).toBe('**&#x20;who&#x20;**');
  });

  it('merges adjacent runs that agree on their annotations and their link', () => {
    expect(inlineMarkdown([text('early', { bold: true }), text('.', { bold: true })])).toBe(
      '**early.**',
    );
    expect(inlineMarkdown([text('one'), text(' two')])).toBe('one two');
    // A bold run before a bold link is not the same run: the link differs.
    expect(
      inlineMarkdown([text('a ', { bold: true }), linked('b', 'https://example.com/', {})]),
    ).toBe('**a** [b](https://example.com/)');
    expect(inlineMarkdown([text('a', { bold: true }), text('b', { italic: true })])).toBe(
      '**a**_b_',
    );
    expect(inlineMarkdown([text('a', { color: 'red' }), text('b', { color: 'blue' })])).toBe(
      '<span data-color="red">a</span><span data-color="blue">b</span>',
    );
  });

  it('the bold sentence Notion splits around a link (ticket 28)', () => {
    const url = 'https://example.com/asset-request';
    expect(
      inlineMarkdown([
        text('Send the ', { bold: true }),
        linked('info / asset request', url, { bold: true }),
        text(' ', { bold: true }),
        text('early', { bold: true }),
        text('.', { bold: true }),
      ]),
    ).toBe(`**Send the** [**info / asset request**](${url}) **early.**`);
  });
});

describe('the escaping paragraph in the fixture', () => {
  const BLOCKS_PAGE = '3cf715cbeb0881168ea0f3f18715e1a4';

  it('reads back as exactly the text Notion holds', () => {
    const block = fixtureBlocks(BLOCKS_PAGE).find((one) =>
      String(
        (one.paragraph as { rich_text?: { plain_text?: string }[] })?.rich_text?.[0]?.plain_text ??
          '',
      ).startsWith('Paragraph with characters'),
    );
    const source = plain(
      (block?.paragraph as { rich_text: RichText[] } | undefined)?.rich_text ?? [],
    );
    expect(source).not.toBe('');

    const tree = parseMarkdown(blocksToMarkdown([block as NotionBlock]));
    const paragraph = tree.children[0] as { children: { type: string; value?: string }[] };
    const back = paragraph.children.map((child) => child.value ?? '').join('');

    expect(back).toBe(source);
  });
});

describe('relativePath', () => {
  it('links inside the same directory', () => {
    expect(relativePath('a/b/One.md', 'a/b/Two.md')).toBe('Two.md');
  });

  it('links into a subdirectory', () => {
    expect(relativePath('a/One.md', 'a/One/Child.md')).toBe('One/Child.md');
  });

  it('links up and across', () => {
    expect(relativePath('a/b/c/One.md', 'a/Two.md')).toBe('../../Two.md');
  });

  it('links from a file at the repo root', () => {
    expect(relativePath('One.md', 'dir/Two.md')).toBe('dir/Two.md');
  });
});

describe('every fixture page', () => {
  // The map a real fetch builds; here it is enough that the two pages the
  // fixture mentions are in it.
  const pages = new Map([[LEAF_ID, 'Docsync test/Leaf.md']]);

  for (const id of PAGE_IDS) {
    it(`converts ${fixtureTitle(id) || id}`, () => {
      const from = `Docsync test/${fixtureTitle(id)}.md`;
      // The links a fetch would have written for the files this page hosts
      // (MANUAL §12 phase 2); a page that hosts none gets an empty map.
      const assets = new Map(
        ASSETS.filter((asset) =>
          fixtureBlocks(id).some((block) => bareId(block.id) === asset.block),
        ).map((asset): [string, string] => [
          asset.block,
          `${from.slice(0, -'.md'.length)}.assets/${asset.file.replace(/^asset-\w+/, nameOf(asset))}`,
        ]),
      );
      expect(blocksToMarkdown(fixtureBlocks(id), { pages, from, assets })).toMatchSnapshot();
    });
  }
});

/** The name the fetch gives one recorded asset: the source's, or the URL's. */
function nameOf(asset: { url: string; file: string }): string {
  const path = asset.url.split('?', 1)[0] ?? '';
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)).replace(/\.[^.]*$/, '');
}
