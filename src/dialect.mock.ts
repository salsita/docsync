/**
 * One document holding every construct the dialect uses (MANUAL §6).
 *
 * The canonical form is whatever `stringifyMarkdown` emits, so this text is the
 * fixed point the whole tool is built around: fetch writes it, push parses it.
 * `markdown.test.ts` pins that it round-trips byte for byte;
 * `markdown.prettier.test.ts` pins that Prettier leaves it alone. It lives here
 * rather than in either test so that the two cannot drift apart, and so that a
 * construct added to the manual is added in one place.
 *
 * The callout marker is written escaped (`> \[!CALLOUT]`) because that is what
 * re-stringifying plain text produces: `[` could open a link reference. What
 * fetch writes is the unescaped `> [!CALLOUT] 💡` of MANUAL §6 — the converter
 * emits the marker as an inline HTML node, which passes through verbatim (see
 * `to-markdown.test.ts`). Both spellings read back as the same text, so push
 * accepts either, and both survive Prettier.
 */
export const CANONICAL_DOCUMENT = `---
id: notion:3cf715cbeb088035b511f0b4f06efbd5
title: Everything
---

# Heading one

## Heading two

### Heading three

###### Heading six

A paragraph with _emphasis_, **strong**, ~~struck~~, \`code\`, a [link](https://example.com), <u>underline</u> and <span data-color="red">colour</span>.

A paragraph whose first line ends in a break\\
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

| Emoji | 中文 | Plain |
| ----- | ---- | ----- |
| 💡 ok | 漢字 | x     |
| a     | 中   | yy    |

![caption](https://example.com/i.png)

[name](https://example.com/file.pdf)

[@Ada](notion://user/abc)

[2026-09-02](notion://date/2026-09-02)

<!-- docsync: color=green -->

A paragraph in green.

<!-- docsync: header-row=false -->

| Name | Value |
| ---- | ----- |
| a    | b     |

<!-- docsync:block notion:858f37cd0bd94a7e8c5d0e6f7a8b9c0d type=synced_block -->

<!-- docsync:block gdocs:DOC1#12 type=table -->

<!-- docsync:object gdocs:OBJ1 type=drawing -->

<!-- docsync:pagebreak -->

A footnote reference[^1]

[^1]: The footnote text.

---

Escaping edge cases: a literal \\* star, an \\_underscore\\_, a # hash, a \\[bracket] and a back\\slash.
`;
