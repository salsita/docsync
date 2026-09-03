/**
 * The 07 + 08 round trip, over the recorded fixture tree.
 *
 * Skipped until ticket 08 writes `from-markdown.ts` and the Docs write half:
 * the property it will pin is the one MANUAL §6 promises — fetching a document
 * and pushing it unchanged leaves no diff on the next fetch — and there is no
 * push to run it against yet.
 *
 * When ticket 08 lands, this becomes: for every recorded Doc, the batch update
 * a push would send, applied to an empty document, converts back to exactly the
 * Markdown that was pushed. Two Docs elements are known losses and belong in
 * the projection ticket 08 writes, not in the assertion:
 *
 * - a checklist item's ticked state, which `documents.get` does not report, so
 *   `- [x]` cannot survive a fetch and the dialect writes `- [ ]`;
 * - everything MANUAL §7 already lists as lost on a Google Docs push — colour,
 *   highlight, font, size, alignment — plus the image, which is a placeholder
 *   until ticket 14.
 */
import { describe, expect, it } from 'vitest';
import { DOC_IDS, fixtureDocument } from './fixtures.mock.js';
import { documentToMarkdown } from './to-markdown.js';

describe('the 07 + 08 round trip', () => {
  it.skip('converts every recorded Doc to Markdown and back to the same Markdown', () => {
    for (const id of DOC_IDS) {
      const markdown = documentToMarkdown(fixtureDocument(id));
      // Ticket 08: `markdownToRequests(markdown)` applied to an empty document,
      // read back through `documentToMarkdown`, must equal `markdown`.
      expect(markdown).toBe(markdown);
    }
  });
});
