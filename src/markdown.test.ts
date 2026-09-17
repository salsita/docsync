import type { PhrasingContent, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { CANONICAL_DOCUMENT } from './dialect.mock.js';
import { parseMarkdown, stringifyMarkdown } from './markdown.js';

const t = (value: string): PhrasingContent => ({ type: 'text', value });
const br: PhrasingContent = { type: 'break' };

/** One paragraph, the way an adapter hands it over. */
function paragraphOf(children: PhrasingContent[]): Root {
  return { type: 'root', children: [{ type: 'paragraph', children }] };
}

/** What a run of inline content says, with a line break as the newline it is. */
function plainOf(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.value;
      if (node.type === 'break') return '\n';
      return 'children' in node ? plainOf(node.children as PhrasingContent[]) : '';
    })
    .join('');
}

describe('the markdown pipeline', () => {
  it('round-trips a canonical document byte for byte', () => {
    expect(stringifyMarkdown(parseMarkdown(CANONICAL_DOCUMENT))).toBe(CANONICAL_DOCUMENT);
  });

  it('is idempotent on a second pass', () => {
    const once = stringifyMarkdown(parseMarkdown(CANONICAL_DOCUMENT));
    expect(stringifyMarkdown(parseMarkdown(once))).toBe(once);
  });

  it('parses frontmatter as a yaml node rather than a thematic break', () => {
    const tree = parseMarkdown('---\nid: notion:abc\n---\n\nBody.\n');
    expect(tree.children[0]?.type).toBe('yaml');
  });

  it('parses GFM tables, task list items and strikethrough', () => {
    const tree = parseMarkdown('| a |\n| - |\n| b |\n\n- [x] done\n\n~~gone~~\n');
    expect(tree.children.map((child) => child.type)).toEqual(['table', 'list', 'paragraph']);
  });

  it('parses math', () => {
    const tree = parseMarkdown('$$\nx\n$$\n\nand $y$ inline\n');
    expect(tree.children[0]?.type).toBe('math');
  });

  it('normalises non-canonical spellings to the canonical ones', () => {
    const messy = [
      'Setext',
      '======',
      '',
      '* star bullet',
      '* another',
      '',
      '___',
      '',
      '__bold__ and *italic*',
      '',
    ].join('\n');
    expect(stringifyMarkdown(parseMarkdown(messy))).toBe(
      '# Setext\n\n- star bullet\n- another\n\n---\n\n**bold** and _italic_\n',
    );
  });

  it('writes italic with underscores, the way Prettier does', () => {
    expect(stringifyMarkdown(parseMarkdown('_i_\n'))).toBe('_i_\n');
    expect(stringifyMarkdown(parseMarkdown('***x***\n'))).toBe('_**x**_\n');
  });

  it('still accepts the asterisk spelling of italic on input', () => {
    expect(stringifyMarkdown(parseMarkdown('*i*\n'))).toBe('_i_\n');
  });

  it('writes a line break inside a block as a trailing backslash', () => {
    expect(stringifyMarkdown(parseMarkdown('a\\\nb\n'))).toBe('a\\\nb\n');
  });

  it('still accepts the two-trailing-spaces spelling of a line break on input', () => {
    expect(stringifyMarkdown(parseMarkdown('a  \nb\n'))).toBe('a\\\nb\n');
  });

  it('pads table cells by display width, so emoji and CJK land where Prettier puts them', () => {
    const table = ['| Emoji | 中文 |', '| - | - |', '| 💡 ok | 漢字 |', '| a | 中 |', ''];
    expect(stringifyMarkdown(parseMarkdown(table.join('\n')))).toBe(
      ['| Emoji | 中文 |', '| ----- | ---- |', '| 💡 ok | 漢字 |', '| a     | 中   |', ''].join(
        '\n',
      ),
    );
  });

  it('turns a line break inside a table cell into a space, since GFM has no other way', () => {
    const tree = parseMarkdown('| a |\n| - |\n| b |\n');
    const row = (tree.children[0] as { children: { children: { children: unknown[] }[] }[] })
      .children[1];
    const cell = row?.children[0];
    if (cell)
      cell.children = [
        { type: 'text', value: 'one' },
        { type: 'break' },
        { type: 'text', value: 'two' },
      ];

    expect(stringifyMarkdown(tree)).toBe('| a       |\n| ------- |\n| one two |\n');
  });

  it('leaves an underscore inside a word unescaped, since it opens nothing', () => {
    // What the owner types is what the fetch after the push writes back
    // (ticket 32): no `ALUMINUM\\_FENCE`, a change nobody made.
    const line = 'A file (ALUMINUM_FENCE-25-26-WEB-150dpi.pdf) and snake_case_name.\n';
    expect(stringifyMarkdown(parseMarkdown(line))).toBe(line);
  });

  it('keeps the escape where an underscore could open emphasis', () => {
    expect(stringifyMarkdown(parseMarkdown('A \\_word\\_ and end_ and _start.\n'))).toBe(
      'A \\_word\\_ and end\\_ and \\_start.\n',
    );
  });

  it('keeps the escape at a run boundary, where what precedes is not a word', () => {
    const tree = parseMarkdown('x\n');
    (tree.children[0] as { children: unknown[] }).children = [
      { type: 'strong', children: [{ type: 'text', value: 'Bold' }] },
      { type: 'text', value: '_after' },
    ];

    expect(stringifyMarkdown(tree)).toBe('**Bold**\\_after\n');
  });

  it('keeps ordered list numbers incrementing', () => {
    expect(stringifyMarkdown(parseMarkdown('1. a\n1. b\n'))).toBe('1. a\n2. b\n');
  });
});

/**
 * Ticket 42. A source splits a run wherever an edit or a style change began, so
 * a run that *ends* in a line break leaves an empty text node behind it. The
 * serializer takes `before` from the last thing it wrote, the empty node makes
 * that `''`, and every escape that depends on knowing a line just began stops
 * firing: `# x` after the break comes back as a heading and the paragraph is
 * two blocks. The adapters no longer emit one; this is the net under them.
 */
describe('an empty text node beside a line break', () => {
  const cases: [name: string, children: PhrasingContent[]][] = [
    ['a heading marker', [t('text'), br, t(''), t('# x')]],
    ['an ordered list marker', [t('text'), br, t(''), t('1. x')]],
    ['a bullet', [t('text'), br, t(''), t('- x')]],
    ['a block quote', [t('text'), br, t(''), t('> x')]],
    ['the other bullet', [t('text'), br, t(''), t('+ x')]],
    ['a setext underline', [t('text'), br, t(''), t('---')]],
    ['the other setext underline', [t('text'), br, t(''), t('===')]],
    ['four leading spaces', [t('text'), br, t(''), t('    indented')]],
    ['a styled heading marker', [t('text'), br, t(''), { type: 'strong', children: [t('# x')] }]],
    ['a heading marker at the very start', [t(''), t('# x')]],
    ['a styled start', [t(''), { type: 'strong', children: [t('x')] }]],
  ];

  for (const [name, children] of cases) {
    it(`escapes ${name} the way it would without the empty node`, () => {
      const printed = stringifyMarkdown(paragraphOf(children));
      // Idempotence alone is not enough: `# x` at the very start of a paragraph
      // prints as a heading and a heading prints as a heading, so the row that
      // loses a whole block reads as stable.
      expect(stringifyMarkdown(parseMarkdown(printed))).toBe(printed);
      const { children: blocks } = parseMarkdown(printed);
      expect(blocks).toHaveLength(1);
      const only = blocks[0];
      expect(only?.type).toBe('paragraph');
      expect(only?.type === 'paragraph' ? plainOf(only.children) : '').toBe(plainOf(children));
    });
  }

  it('leaves the tree it was handed alone', () => {
    // `readLive` (`gdrive/ranges.ts`) stringifies a tree and then reads the
    // ranges off that same tree, so the net prunes a copy.
    const tree = paragraphOf([t('text'), br, t(''), t('# x')]);
    stringifyMarkdown(tree);
    const [only] = tree.children;
    expect(only?.type === 'paragraph' ? only.children : []).toHaveLength(4);
  });
});
