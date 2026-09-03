/**
 * The dialect is stable under Prettier with default options (MANUAL §6,
 * "Formatters and editors"): a formatter that runs on save produces no churn in
 * a checkout. This test is what keeps that true.
 *
 * Prettier is a dev dependency, pinned to an exact version, and is imported
 * here and nowhere else. Nothing docsync ships at runtime knows it exists.
 */
import prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { CANONICAL_DOCUMENT } from './dialect.mock.js';
import { DOC_IDS, fixtureDocument } from './gdrive/fixtures.mock.js';
import { documentToMarkdown } from './gdrive/to-markdown.js';
import { parseMarkdown, stringifyMarkdown } from './markdown.js';
import { fixtureBlocks, fixtureTitle, PAGE_IDS } from './notion/fixtures.mock.js';
import { blocksToMarkdown } from './notion/to-markdown.js';

/**
 * Prettier's defaults, with `proseWrap` spelled out because it is the one
 * option `docsync init` writes into `.prettierrc` (ticket 10) and the one whose
 * default we cannot afford to have change under us.
 */
async function format(markdown: string): Promise<string> {
  return await prettier.format(markdown, { parser: 'markdown', proseWrap: 'preserve' });
}

/**
 * MANUAL §6 lists exactly one divergence: Prettier collapses a run of spaces
 * inside a sentence, and fetch keeps such a run because it is content. Two
 * recorded documents contain one on purpose, so the comparison below collapses
 * runs on both sides — everywhere except inside a fenced block, whose content
 * Prettier never touches, and in a table row, where the run is padding and
 * therefore exactly what this test is here to check.
 */
function collapseSpaceRuns(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || /^\s*\|/.test(line)) return line;
      return line.replace(/(\S) {2,}(?=\S)/g, '$1 ');
    })
    .join('\n');
}

/** What a fetch writes for one recorded Notion page. */
function notionMarkdown(id: string): string {
  const pages = new Map(PAGE_IDS.map((page) => [page, `Docsync test/${fixtureTitle(page)}.md`]));
  return blocksToMarkdown(fixtureBlocks(id), {
    pages,
    from: `Docsync test/${fixtureTitle(id)}.md`,
  });
}

describe('the hand-written document of every construct', () => {
  it('is unchanged by Prettier, byte for byte', async () => {
    expect(await format(CANONICAL_DOCUMENT)).toBe(CANONICAL_DOCUMENT);
  });

  // The document is a literal, so the test above pins Prettier alone. Running
  // it through our own stringifier first closes the loop: what fetch writes is
  // what Prettier leaves alone.
  it('is unchanged by Prettier after our own stringifier has written it', async () => {
    const ours = stringifyMarkdown(parseMarkdown(CANONICAL_DOCUMENT));
    expect(await format(ours)).toBe(ours);
  });

  it('is unchanged by a second pass, so Prettier is at a fixed point too', async () => {
    const once = await format(CANONICAL_DOCUMENT);
    expect(await format(once)).toBe(once);
  });
});

describe('every recorded Notion page', () => {
  for (const id of PAGE_IDS) {
    it(`survives Prettier: ${fixtureTitle(id) || id}`, async () => {
      const ours = notionMarkdown(id);
      expect(collapseSpaceRuns(await format(ours))).toBe(collapseSpaceRuns(ours));
    });
  }
});

describe('every recorded Google Doc', () => {
  for (const id of DOC_IDS) {
    it(`survives Prettier: ${id}`, async () => {
      const ours = documentToMarkdown(fixtureDocument(id));
      expect(collapseSpaceRuns(await format(ours))).toBe(collapseSpaceRuns(ours));
    });
  }
});

describe('the documented divergence', () => {
  it('collapses a run of spaces inside a sentence, and nothing else', async () => {
    expect(await format('one  two\n')).toBe('one two\n');
    expect(await format('`one  two`\n')).toBe('`one  two`\n');
    expect(await format('```\none  two\n```\n')).toBe('```\none  two\n```\n');
  });
});
