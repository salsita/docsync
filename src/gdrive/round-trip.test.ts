/**
 * The 07 + 08 round trip, over the recorded fixture tree.
 *
 * The property MANUAL §6 promises is that fetching a document and pushing it
 * unchanged leaves no diff on the next fetch. Here that is: every recorded Doc
 * becomes Markdown (ticket 07), the Markdown becomes the batch a push would
 * send (ticket 08), the batch is applied to a model of a Docs document
 * (`docs-model.mock.ts`), and the model converts back to the same Markdown.
 *
 * Three things cannot survive, and are projected out of the *expected* text
 * rather than quietly tolerated in the comparison, so that adding a fourth is
 * a failing test and not a shrug:
 *
 * - a **horizontal rule**, which no Docs API request creates (ticket 08);
 * - a **placeholder**, `docsync:block` or `docsync:object` — an image, a
 *   merged-cell table — which phase-1 write-back does not recreate (MANUAL §7);
 * - a **checklist tick**, which `documents.get` never reports, so the dialect
 *   only ever writes `- [ ]` (ticket 07 Outcome). No fixture holds a `- [x]`,
 *   so this one is proved by a unit test rather than here.
 *
 * Colour, highlight, font, size and alignment need no projection: the read side
 * already drops them (MANUAL §6), so they are not in the Markdown to begin
 * with. They are lost on a push all the same, which is what MANUAL §7 says.
 */
import type { Root, RootContent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import { createDocsModel } from './docs-model.mock.js';
import { DOC_IDS, fixtureDocument } from './fixtures.mock.js';
import { markdownToRequests } from './from-markdown.js';
import { documentToMarkdown } from './to-markdown.js';
import { footnoteRequests } from './write.js';

const PLACEHOLDER = /^<!--\s*docsync:(block|object)\b/;

/** What the Markdown says once the known losses are taken out of it. */
function project(markdown: string): { text: string; excluded: string[] } {
  const excluded: string[] = [];
  const tree = parseMarkdown(markdown);
  const kept: Root = { type: 'root', children: keep(tree.children, excluded) };
  return { text: stringifyMarkdown(kept), excluded };
}

function keep(nodes: readonly RootContent[], excluded: string[]): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    if (node.type === 'thematicBreak') {
      excluded.push('horizontal rule');
      continue;
    }
    if (node.type === 'html' && PLACEHOLDER.test(node.value.trim())) {
      excluded.push(node.value.trim());
      continue;
    }
    if (node.type === 'paragraph') {
      const children = node.children.filter((child) => {
        if (child.type !== 'html' || !PLACEHOLDER.test(child.value.trim())) return true;
        excluded.push(child.value.trim());
        return false;
      });
      // A paragraph that was only a placeholder is a paragraph no longer.
      if (children.length === 0) continue;
      out.push({ ...node, children });
      continue;
    }
    out.push(node);
  }
  return out;
}

/** The Markdown a push of `markdown` would leave behind at the source. */
function pushed(markdown: string, documentId = 'model'): string {
  const plan = markdownToRequests(markdown);
  const model = createDocsModel(documentId);
  const replies = model.apply(plan.requests);
  // The same second batch `write.ts` sends, over the same replies.
  model.apply(footnoteRequests(plan.footnotes, replies, 0, model.document()));
  return documentToMarkdown(model.document());
}

describe('the 07 + 08 round trip', () => {
  for (const id of DOC_IDS) {
    it(`writes ${id} back to the Markdown it was read as`, () => {
      const markdown = documentToMarkdown(fixtureDocument(id));
      const { text } = project(markdown);
      expect(pushed(markdown, id)).toBe(text);
    });
  }

  it('excludes exactly the known losses, and only from Elements', () => {
    const excluded = new Map<string, string[]>();
    for (const id of DOC_IDS) {
      const { excluded: found } = project(documentToMarkdown(fixtureDocument(id)));
      if (found.length > 0) excluded.set(id, found);
    }
    expect(Object.fromEntries(excluded)).toEqual({
      '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4': [
        'horizontal rule',
        '<!-- docsync:object gdocs:kix.655cbf6q1wjw type=image -->',
      ],
    });
  });
});
