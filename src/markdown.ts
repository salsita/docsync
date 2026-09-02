/**
 * The one Markdown pipeline, shared by every adapter in both directions.
 *
 * Fetch builds an mdast tree and calls `stringifyMarkdown`; push calls
 * `parseMarkdown` on the file and walks the same tree back into source blocks.
 * Because there is exactly one stringifier configuration, "canonical Markdown"
 * (MANUAL §6) has a precise meaning: the text `stringifyMarkdown` emits. That
 * is what makes fetch-push-fetch produce no diff, and what the round-trip test
 * in `markdown.test.ts` pins.
 *
 * The options below are therefore load-bearing. Changing one rewrites every
 * checked-out file in the world on the next fetch, so change them only
 * deliberately, and never to accommodate one document.
 */
import type { Root } from 'mdast';
import type { Handle } from 'mdast-util-to-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkStringify, { type Options as StringifyOptions } from 'remark-stringify';
import { unified } from 'unified';

/** Constructs in which a newline cannot appear, so a break becomes a space. */
const NO_NEWLINE = new Set(['tableCell', 'headingAtx', 'headingSetext']);

/**
 * A line break inside one block is two trailing spaces and a newline (MANUAL
 * §6), not remark's default backslash: it is what Notion's own export writes
 * and what every Markdown editor produces when you press Return inside a
 * paragraph. Both spellings parse back to the same `break` node, so reading is
 * unaffected; only what we write is pinned here.
 */
const hardBreak: Handle = (_node, _parent, state, info) => {
  if (state.stack.some((name) => NO_NEWLINE.has(name))) {
    return /[ \t]/.test(info.before) ? '' : ' ';
  }
  return '  \n';
};

/**
 * The fixed serialization. Every field is spelled out even where it repeats a
 * remark default, so that a remark upgrade that changes a default does not
 * silently change our on-disk format.
 */
export const MARKDOWN_OPTIONS: Readonly<StringifyOptions> = {
  bullet: '-',
  bulletOther: '*',
  bulletOrdered: '.',
  // Numbers increment, the way a person writing the list would: `1.`, `2.`, …
  incrementListMarker: true,
  listItemIndent: 'one',
  emphasis: '*',
  strong: '*',
  fence: '`',
  // Always fence, never indent: an indented code block has no language slot,
  // and Notion's `plain text` is exactly a fence with no language.
  fences: true,
  rule: '-',
  ruleRepetition: 3,
  ruleSpaces: false,
  // `#`-style headings, closed on the left only, at every level.
  setext: false,
  closeAtx: false,
  quote: '"',
  resourceLink: false,
  tightDefinitions: true,
  handlers: { break: hardBreak },
};

const FRONTMATTER = ['yaml'] as const;

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkFrontmatter, [...FRONTMATTER])
  .freeze();

const stringifier = unified()
  .use(remarkStringify, MARKDOWN_OPTIONS)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkFrontmatter, [...FRONTMATTER])
  .freeze();

/** Markdown text to mdast, with GFM, math and YAML frontmatter understood. */
export function parseMarkdown(text: string): Root {
  return parser.parse(text);
}

/** mdast to canonical Markdown text. The inverse of `parseMarkdown`. */
export function stringifyMarkdown(tree: Root): string {
  return stringifier.stringify(tree);
}
