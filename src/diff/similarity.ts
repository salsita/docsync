/**
 * How alike two pieces of text are, and the tokenisation both diffs use.
 *
 * Pure and source-agnostic: `blocks.ts` asks this whether a removed and an
 * inserted block are the same block edited, the way `git diff` asks whether a
 * removed and an added file are a rename. The measure is git's: the amount of
 * text the two share, over the length of the longer one, so that a paragraph
 * with a word replaced is similar and a paragraph that merely starts the same
 * way is not.
 *
 * Tokens are words as `Intl.Segmenter` sees them, which is what makes the
 * measure and the character diff behave on text that is not English: a run of
 * CJK is segmented into words rather than treated as one long token, and an
 * emoji — including a multi-codepoint one — stays whole.
 */

/**
 * Word segmentation. The locale is pinned so that two machines tokenise the
 * same text the same way; segmentation of CJK is dictionary-based and does not
 * depend on it.
 */
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' });

/** The tokens of a text, in order, concatenating back to the text itself. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const part of SEGMENTER.segment(text)) out.push(part.segment);
  return out;
}

/**
 * How much of the longer text the two share, from 0 to 1. Shared means the
 * same token, counted as many times as both hold it, weighted by its length so
 * that a long word matching counts for more than a comma.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 1;

  const counts = new Map<string, number>();
  for (const token of tokens(a)) counts.set(token, (counts.get(token) ?? 0) + 1);

  let shared = 0;
  for (const token of tokens(b)) {
    const left = counts.get(token) ?? 0;
    if (left === 0) continue;
    counts.set(token, left - 1);
    shared += token.length;
  }
  return shared / longer;
}
