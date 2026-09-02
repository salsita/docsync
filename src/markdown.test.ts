import { describe, expect, it } from 'vitest';
import { parseMarkdown, stringifyMarkdown } from './markdown.js';

/**
 * One document holding every construct the dialect uses (MANUAL §6). The
 * canonical form is whatever `stringifyMarkdown` emits, so this text is the
 * fixed point the whole tool is built around: fetch writes it, push parses it.
 */
const CANONICAL = `---
id: notion:3cf715cbeb088035b511f0b4f06efbd5
title: Everything
---

# Heading one

## Heading two

### Heading three

A paragraph with *emphasis*, **strong**, ~~struck~~, \`code\`, a [link](https://example.com), <u>underline</u> and <span data-color="red">colour</span>.

A paragraph whose first line ends in a break${'  '}
and continues here.

- bullet
  - nested bullet
- [ ] unchecked
- [x] checked

1. first
2. second

> quoted text

> \\[!CALLOUT] 💡
> Callout body.

<!--
The callout marker above is escaped because that is what re-stringifying plain
*text* produces: \`[\` could open a link reference. What fetch writes is the
unescaped \`> [!CALLOUT] 💡\` of MANUAL §6 — the converter emits the marker as an
inline HTML node, which passes through verbatim (see \`to-markdown.test.ts\`).
Both spellings read back as the same text, so push accepts either.
-->

<details>
<summary>## Toggle heading</summary>

Paragraph inside the toggle.

</details>

\`\`\`ts
const x: number = 1;
\`\`\`

\`\`\`
plain text, no language
\`\`\`

$$
E = mc^2
$$

Inline math $a^2 + b^2$ in a sentence.

| Name | Value |
| ---- | ----- |
| a    | b     |

![caption](https://example.com/i.png)

<!-- docsync: color=green -->

A paragraph in green.

<!-- docsync:block notion:858f37cd0bd94a7e8c5d0e6f7a8b9c0d type=synced_block -->

---

Escaping edge cases: a literal \\* star, an \\_underscore\\_, a # hash, a \\[bracket] and a back\\slash.
`;

describe('the markdown pipeline', () => {
  it('round-trips a canonical document byte for byte', () => {
    expect(stringifyMarkdown(parseMarkdown(CANONICAL))).toBe(CANONICAL);
  });

  it('is idempotent on a second pass', () => {
    const once = stringifyMarkdown(parseMarkdown(CANONICAL));
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
      '__bold__ and _italic_',
      '',
    ].join('\n');
    expect(stringifyMarkdown(parseMarkdown(messy))).toBe(
      '# Setext\n\n- star bullet\n- another\n\n---\n\n**bold** and *italic*\n',
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
