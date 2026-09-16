/**
 * A push onto a Doc that already carries pending suggestions (ticket 41).
 *
 * The four faults of 2026-09-16, each rebuilt on the fake as the layout the
 * report recorded around it, and the rules the ticket settled on: an edit
 * beside somebody else's suggestion is a **competing suggestion** against the
 * original text alone, never a rewrite of their words and never a
 * whole-paragraph replacement, and what cannot be expressed that way is refused
 * by name before a single request goes out (MANUAL §7).
 *
 * Everything starts from a document the generator wrote and the model applied,
 * so the indices are the indices a real Doc would have, and the pending
 * suggestions are made the way anyone else's are: a `SUGGEST` batch, which is
 * what the client's editor sends too.
 */
import { describe, expect, it } from 'vitest';
import { diffBlocks, flattenBlocks } from '../diff/blocks.js';
import { plainOf } from '../diff/text.js';
import { parseMarkdown } from '../markdown.js';
import type { DocsDocument, DocsWriteRequest } from './api.js';
import { createDocsModel, type DocsModel } from './docs-model.mock.js';
import { mdastToRequests } from './from-markdown.js';
import { type PatchPlan, planPatch } from './patch.js';
import { readLive } from './ranges.js';
import { documentToMarkdown } from './to-markdown.js';

const PATH = 'client/Contract.md';

/** A live Doc written from Markdown by the generator, whatever comes out. */
function written(markdown: string): DocsModel {
  const model = createDocsModel('doc', 'Contract');
  model.apply(mdastToRequests(parseMarkdown(markdown), { from: PATH }).requests);
  return model;
}

/** A live Doc holding exactly what the Markdown says. */
function built(markdown: string): DocsModel {
  const model = written(markdown);
  expect(documentToMarkdown(model.document(), { from: PATH })).toBe(markdown);
  return model;
}

/** Where a stretch of the body starts, as the API counts indices. */
function indexOf(doc: DocsDocument, text: string): number {
  for (const element of doc.body?.content ?? []) {
    for (const run of element.paragraph?.elements ?? []) {
      const found = (run.textRun?.content ?? '').indexOf(text);
      if (found >= 0) return (run.startIndex ?? 0) + found;
    }
  }
  throw new Error(`the document does not say ${JSON.stringify(text)}`);
}

/** What a push of `next` onto the live document would send. */
function plan(model: DocsModel, next: string, options: { suggest?: boolean } = {}): PatchPlan {
  const live = readLive(model.document('inline'), { from: PATH });
  const base = parseMarkdown(live.markdown);
  return planPatch(live, diffBlocks(base, parseMarkdown(next)), { path: PATH, ...options });
}

/** The body a push diffs against: the live Doc with every suggestion rejected. */
function baseOf(model: DocsModel): string {
  return readLive(model.document('inline'), { from: PATH }).markdown;
}

/** Every range a plan deletes, as `[start, end)` pairs. */
function deletions(plan: PatchPlan): [number, number][] {
  return plan.requests
    .map((request) => request as { deleteContentRange?: { range: DocsWriteRequest } })
    .filter((request) => request.deleteContentRange !== undefined)
    .map((request) => [
      Number(request.deleteContentRange?.range.startIndex),
      Number(request.deleteContentRange?.range.endIndex),
    ]);
}

/** Every text a plan inserts, with the index it goes in at. */
function insertions(plan: PatchPlan): { at: number; text: string }[] {
  return plan.requests
    .map((request) => request as { insertText?: { location: { index: number }; text: string } })
    .filter((request) => request.insertText !== undefined)
    .map((request) => ({
      at: Number(request.insertText?.location.index),
      text: String(request.insertText?.text),
    }));
}

/* ------------------------------------------------------- 1. the paragraph */

/**
 * Fault 1. A long paragraph the client has three pending suggestions on, two
 * of them on exactly the words the owner edited. docsync deleted the whole
 * paragraph, the client's suggested insertions included, and wrote the new text
 * over it.
 */
describe('an edit inside a paragraph the client has suggested on', () => {
  const BASE =
    'The term is one (1) year from the Effective Date and renews unless either party says otherwise.\n';

  /** The client's three pending suggestions, made as anyone else makes them. */
  function suggested(): DocsModel {
    const model = built(BASE);
    const one = indexOf(model.document(), 'one (1)');
    const otherwise = indexOf(model.document(), 'otherwise');
    // `one` → `three` and `(1)` → `(3)`, on exactly the words the owner edits,
    // and one elsewhere. Each request is a suggestion of its own, as the API
    // makes them.
    model.apply(
      [
        { insertText: { location: { index: otherwise }, text: 'in writing ' } },
        { deleteContentRange: { range: { startIndex: one + 4, endIndex: one + 7 } } },
        { insertText: { location: { index: one + 7 }, text: '(3)' } },
        { deleteContentRange: { range: { startIndex: one, endIndex: one + 3 } } },
        { insertText: { location: { index: one + 3 }, text: 'three' } },
      ],
      { suggest: true },
    );
    return model;
  }

  it('leaves the body the suggestions were made against alone', () => {
    expect(baseOf(suggested())).toBe(BASE);
  });

  it('suggests over the changed words only, never the whole paragraph', () => {
    const model = suggested();
    const next = BASE.replace('one (1) year', 'two (2) years');
    const patch = plan(model, next, { suggest: true });

    // The paragraph runs from index 1 to the end; nothing may cover it.
    const whole = deletions(patch).some(([from, to]) => to - from > 'one (1) year'.length + 4);
    expect(whole).toBe(false);
    expect(patch.rewritten).toEqual([]);
    expect(
      insertions(patch)
        .map((one) => one.text)
        .join('|'),
    ).not.toContain('Effective Date');
  });

  it('never covers the words the client suggested inserting', () => {
    const model = suggested();
    const document = model.document('inline');
    // Where the client's own inserted runs sit in the live document.
    const foreign: [number, number][] = [];
    for (const element of document.body?.content ?? []) {
      for (const run of element.paragraph?.elements ?? []) {
        if ((run.textRun?.suggestedInsertionIds ?? []).length === 0) continue;
        foreign.push([run.startIndex ?? 0, run.endIndex ?? 0]);
      }
    }
    expect(foreign.length).toBe(3);

    const patch = plan(model, BASE.replace('one (1) year', 'two (2) years'), { suggest: true });
    for (const [from, to] of deletions(patch)) {
      for (const [start, end] of foreign) {
        expect(from < end && to > start).toBe(false);
      }
    }
  });

  it('leaves the client\u2019s own words as their own proposal', () => {
    const model = suggested();
    const patch = plan(model, BASE.replace('one (1) year', 'two (2) years'), { suggest: true });
    model.apply(patch.requests, { suggest: true });

    const runs = (model.document('inline').body?.content ?? []).flatMap(
      (element) => element.paragraph?.elements ?? [],
    );
    // `one` is proposed for deletion — by the client, and now by this push
    // too; the API keeps one strike on the run either way (probed on the live
    // API 2026-09-16). What matters is that `three` is still exactly what it
    // was: their insertion, not struck and not rewritten.
    expect(
      runs.find((run) => run.textRun?.content === 'one')?.textRun?.suggestedDeletionIds,
    ).toHaveLength(1);
    const theirs = runs.find((run) => run.textRun?.content === 'three')?.textRun;
    expect(theirs?.suggestedInsertionIds).toHaveLength(1);
    expect(theirs?.suggestedDeletionIds).toBeUndefined();
    // And this push's own words went in beside them.
    expect(
      runs.some(
        (run) =>
          (run.textRun?.suggestedInsertionIds ?? []).length > 0 &&
          (run.textRun?.content ?? '').includes('two (2) years'),
      ),
    ).toBe(true);
  });

  it('is the same case when the suggestion in the way is our own', () => {
    const model = built(BASE);
    const one = indexOf(model.document(), 'one (1)');
    // An earlier push of ours, still pending: a second competing suggestion,
    // not a rewrite of the first (MANUAL §7).
    model.apply(
      [
        { deleteContentRange: { range: { startIndex: one, endIndex: one + 3 } } },
        { insertText: { location: { index: one + 3 }, text: 'four' } },
      ],
      { suggest: true },
    );
    const patch = plan(model, BASE.replace('one (1) year', 'two (2) years'), { suggest: true });
    expect(patch.rewritten).toEqual([]);
    expect(deletions(patch).every(([from, to]) => to - from <= 'one (1) year'.length + 4)).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------- 2. the alignment */

/**
 * Faults 2 and 3. Base block *n* has to be live block *n*, and it was not: the
 * planner reads the live blocks out of the converted tree while the diff reads
 * the base blocks out of the Markdown that tree prints. A paragraph that
 * *starts* with one of the dialect's placeholder comments — an inline object
 * nobody downloaded, a smart chip, a drawing — prints a line that CommonMark
 * reads back as an HTML block and the block flattening drops, so the live list
 * gains a block the base list has not and everything after it is addressed one
 * block early.
 */
describe('a Doc whose live blocks and base blocks could drift apart', () => {
  /** A paragraph that begins with an inline object nobody downloaded. */
  function withChip(markdown: string, before: string): DocsModel {
    const model = built(markdown);
    model.apply([
      { insertInlineImage: { location: { index: indexOf(model.document(), before) }, uri: 'x' } },
    ]);
    return model;
  }

  it('maps every base block onto the live block of the same kind and text', () => {
    const model = withChip('Chip here.\n\nSecond.\n\nThird.\n', 'Chip');
    const live = readLive(model.document('inline'), { from: PATH });
    const base = flattenBlocks(parseMarkdown(live.markdown));

    expect(live.blocks).toHaveLength(base.length);
    for (const [at, block] of base.entries()) {
      expect(live.blocks[at]?.block.type).toBe(block.type);
    }
  });

  /**
   * Fault 2's layout: `… list | If any of those … | ERP and CRM … | <portal> |
   * [page break] | # Custom Outputs`, with the drift already in front of it.
   */
  it('replaces the placeholder paragraph and not one two blocks earlier', () => {
    const model = withChip(
      'Chip here.\n\n- Item one.\n- Item two.\n\nIf any of those apply, tell us.\n\n' +
        'ERP and CRM systems.\n\n\\<portal>\n\n<!-- docsync:pagebreak -->\n\n# Custom Outputs\n',
      'Chip',
    );
    const base = baseOf(model);
    const next = base.replace('\\<portal>', 'The portal is the client’s own.');
    const patch = plan(model, next, { suggest: true });
    model.apply(patch.requests, { suggest: true });

    // With every suggestion accepted the placeholder is the sentence, and
    // nothing else in the document moved.
    const inline = documentToMarkdown(model.document('inline'), { from: PATH });
    expect(inline).toContain('If any of those apply, tell us.');
    expect(inline).not.toContain('The portal is the client’s ownIf any');
  });

  /**
   * Fault 3's layout: an empty paragraph, a three-item list whose first item
   * carries a pending suggestion, an empty paragraph, a sentence, a heading.
   */
  it('inserts a paragraph after the list and not inside it', () => {
    const model = withChip(
      'Chip here.\n\n1. One.\n2. Two.\n3. Three.\n\nThe remainder follows.\n\n## Platforms\n',
      'Chip',
    );
    const one = indexOf(model.document(), 'One.');
    model.apply([{ insertText: { location: { index: one + 4 }, text: ' Edited.' } }], {
      suggest: true,
    });

    const base = baseOf(model);
    const next = base.replace(
      'The remainder follows.\n',
      'The remainder follows.\n\nA new sentence.\n',
    );
    const patch = plan(model, next, { suggest: true });
    const put = insertions(patch).find((one) => one.text.includes('A new sentence'));
    const platforms = indexOf(model.document('inline'), 'Platforms');
    const two = indexOf(model.document('inline'), 'Two.');

    // It goes in where the Markdown put it: after the sentence, before the
    // heading — not between two items of the list.
    expect(put?.at).toBeGreaterThan(two);
    expect(put?.at).toBeLessThanOrEqual(platforms);
    expect(put?.at).toBeGreaterThan(indexOf(model.document('inline'), 'The remainder'));
  });
});

/* ------------------------------------------------------ 3. the appended item */

/**
 * Fault 4. A new last item of a list arrived with an empty paragraph in front
 * of it: the insertion lends itself the newline of the item before, which in
 * suggesting mode is a suggestion of its own and a paragraph of its own for
 * the reviewer to accept.
 */
describe('a list item appended at the end of a list', () => {
  const BASE = '1. One.\n2. Two.\n3. Three.\n\n## After\n';
  const NEXT = '1. One.\n2. Two.\n3. Three.\n4. **Migration Assistance.**\n\n## After\n';

  it('is one suggested paragraph, with no empty paragraph of its own', () => {
    const patch = plan(built(BASE), NEXT, { suggest: true });
    const written = insertions(patch);
    // No bare newline: a split of the item before is two suggestions and an
    // empty paragraph between them.
    expect(written.map((one) => one.text)).not.toContain('\n');
    expect(written).toHaveLength(1);
    expect(written[0]?.text).toBe('Migration Assistance.\n');
  });

  it('still lends the item before its newline on a plain push', () => {
    // Nothing about a plain push changes: it keeps the bullet of the item it
    // continues, which is what the split is for (ticket 32).
    const written = insertions(plan(built(BASE), NEXT));
    expect(written.map((one) => one.text)).toContain('\n');
  });

  it('leaves no empty paragraph behind in the document', () => {
    const model = built(BASE);
    model.apply(plan(model, NEXT, { suggest: true }).requests, { suggest: true });

    // Every paragraph of the live document, suggestions shown, as a reader
    // sees it: the new item is there and nothing blank came with it.
    const lines = (model.document('inline').body?.content ?? [])
      .filter((element) => element.paragraph !== undefined)
      .map((element) =>
        (element.paragraph?.elements ?? []).map((one) => one.textRun?.content ?? '').join(''),
      );
    expect(lines).toEqual([
      'One.\n',
      'Two.\n',
      'Three.\n',
      'Migration Assistance.\n',
      'After\n',
      '\n',
    ]);
    // And with every suggestion rejected the Doc is what it was.
    expect(documentToMarkdown(model.document('preview'), { from: PATH })).toBe(BASE);
  });
});

/* ---------------------------------------------------------- 4. the refusal */

/**
 * What cannot be expressed as a competing suggestion is refused by name, before
 * a request goes out: deleting a paragraph would delete the words somebody else
 * has proposed adding to it, and neither push may do that (MANUAL §7).
 */
describe('an edit that would have to delete somebody else’s suggestion', () => {
  const BASE = 'Keep this.\n\nThis paragraph goes.\n\nAnd this stays.\n';

  function withForeign(): DocsModel {
    const model = built(BASE);
    const goes = indexOf(model.document(), 'paragraph goes');
    model.apply([{ insertText: { location: { index: goes }, text: 'whole ' } }], { suggest: true });
    return model;
  }

  it('is refused, naming the path, the quote and the suggestion', () => {
    const model = withForeign();
    const next = baseOf(model).replace('This paragraph goes.\n\n', '');
    expect(() => plan(model, next, { suggest: true })).toThrow(
      /cannot be suggested beside the pending suggestion suggest\.s1/,
    );
    expect(() => plan(model, next, { suggest: true })).toThrow(/This paragraph goes/);
  });

  it('is refused on a plain push too, which would discard it silently', () => {
    const model = withForeign();
    const next = baseOf(model).replace('This paragraph goes.\n\n', '');
    expect(() => plan(model, next)).toThrow(/cannot be written beside the pending suggestion/);
  });

  it('says nothing about a paragraph the edit does not touch', () => {
    const model = withForeign();
    const next = baseOf(model).replace('And this stays.', 'And this one stays.');
    expect(() => plan(model, next, { suggest: true })).not.toThrow();
  });
});

/* -------------------------------------------------------- 5. the invariant */

/**
 * The guarantee the two block faults cost: every range a plan sends lies inside
 * the live block the base block it came from maps to. Checked over documents
 * generated from the constructs that break the mapping — placeholders, empty
 * paragraphs, suggested paragraphs, suggested deletions — rather than over one
 * layout somebody thought of.
 */
describe('every plan', () => {
  /** A tiny deterministic generator, so a failure names the seed it came from. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  const LINES = [
    'A plain paragraph.',
    '## A heading',
    '- A bullet item.',
    '1. A numbered item.',
    '\\<portal>',
    '<!-- docsync:pagebreak -->',
  ];

  it('addresses the live block its base block maps to', () => {
    for (let seed = 1; seed < 60; seed += 1) {
      const next = random(seed);
      const lines: string[] = ['A plain paragraph.'];
      for (let at = 0; at < 6; at += 1) lines.push(LINES[Math.floor(next() * LINES.length)] ?? '');
      const markdown = `${lines.join('\n\n')}\n`;
      // A generated run that does not round-trip is a defect of its own, not
      // one this test is about: a push of it is refused as "the source
      // changed" long before the planner sees it.
      if (documentToMarkdown(written(markdown).document(), { from: PATH }) !== markdown) continue;
      const model = written(markdown);
      // A paragraph that begins with an object nobody downloaded, which is the
      // construct the two block faults came from.
      model.apply([
        {
          insertInlineImage: {
            location: { index: indexOf(model.document(), 'A plain') },
            uri: 'x',
          },
        },
      ]);

      const live = readLive(model.document('inline'), { from: PATH });
      const base = flattenBlocks(parseMarkdown(live.markdown));
      expect(live.blocks.length, `seed ${seed}`).toBe(base.length);
      for (const [at, block] of base.entries()) {
        const found = live.blocks[at];
        if (found === undefined) continue;
        expect(found.block.type, `seed ${seed} block ${at}`).toBe(block.type);
        expect(plainOf(found.block.inline ?? []), `seed ${seed} block ${at}`).toBe(block.text);
      }
    }
  });
});

describe('a base block the live document has no counterpart for', () => {
  const TWO = 'First paragraph.\n\nSecond paragraph.\n';

  function unmapped(next: string): () => PatchPlan {
    const model = built(TWO);
    const live = readLive(model.document('inline'), { from: PATH });
    // What a misaligned document looks like to the planner: the first base
    // block has nothing to write to.
    (live.blocks as (typeof live.blocks)[number][])[0] = undefined;
    const base = parseMarkdown(live.markdown);
    return () => planPatch(live, diffBlocks(base, parseMarkdown(next)), { path: PATH });
  }

  it('refuses an edit to it by name rather than dropping it', () => {
    expect(unmapped('First paragraph, changed.\n\nSecond paragraph.\n')).toThrow(
      'the block at "First paragraph." cannot be located in the live document',
    );
  });

  it('refuses deleting it too', () => {
    expect(unmapped('Second paragraph.\n')).toThrow('cannot be located in the live document');
  });

  it('needs nothing for it when it is kept', () => {
    const plan = unmapped('First paragraph.\n\nSecond paragraph, changed.\n')();
    expect(plan.counts.kept).toBe(1);
    expect(plan.counts.updated).toBe(1);
  });
});
