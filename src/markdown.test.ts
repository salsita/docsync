import { describe, expect, it } from 'vitest';
import { CANONICAL_DOCUMENT } from './dialect.mock.js';
import { parseMarkdown, stringifyMarkdown } from './markdown.js';

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

  it('keeps ordered list numbers incrementing', () => {
    expect(stringifyMarkdown(parseMarkdown('1. a\n1. b\n'))).toBe('1. a\n2. b\n');
  });
});
