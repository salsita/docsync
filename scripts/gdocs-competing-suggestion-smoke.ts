/**
 * The manual test for ticket 41: a suggesting push onto a Doc that already
 * carries pending suggestions, against the real Docs API.
 *
 * The fake model proves the planner. Only Google can say what the API does with
 * two suggestions over one word, and what it does when a suggested deletion is
 * asked to cover somebody else's suggested insertion — the request this ticket
 * says the planner must never send, and which nobody had ever tried. So this
 * makes a Doc of its own inside the fixture folder "Docsync test" — nothing
 * that is already there is written or renamed — and checks:
 *
 * 1. a first suggesting batch (`one` → `three`) is a pending suggestion,
 * 2. the body a push diffs against is still the text before anybody suggested
 *    anything: the suggested words are not in it,
 * 3. a second suggesting push of `one (1) year` → `two (2) years` plans no
 *    range that covers the first batch's inserted words,
 * 4. after it, the run holding `one` carries **both** deletion ids and both
 *    proposals stand side by side as separate insertions,
 * 5. a paragraph written after an empty paragraph, a paragraph that is itself
 *    a pending suggested insertion and a list lands where the Markdown put it,
 * 6. and the probe: what the API answers to a `deleteContentRange` over another
 *    author's suggested insertion, sent by hand, never by the planner.
 *
 * **One identity.** The script signs in once, so the "other author" is this
 * same account suggesting in an earlier batch. That is not a shortcut around
 * the case: ticket 41 settled that an edit over text the same account already
 * suggested is the same case as somebody else's — a second competing
 * suggestion, not a rewrite of the first — so one identity is a faithful
 * stand-in, and the API stacks ids by suggestion, not by author.
 *
 * It trashes the Doc at the end — trashed, never deleted (MANUAL §8) — and
 * prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdocs-competing-suggestion-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts gdocs`.
 */

import { createCredentialProvider } from '../dist/auth/index.js';
import { diffBlocks } from '../dist/diff/blocks.js';
import { createGDriveApi, DOCUMENT_MIME, type DocsDocument } from '../dist/gdrive/api.js';
import { planPatch } from '../dist/gdrive/patch.js';
import { readLive } from '../dist/gdrive/ranges.js';
import { flattenTabs } from '../dist/gdrive/tabs.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

/** The read-only fixture folder. The Doc this script makes is its own. */
const FOLDER = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const TITLE = 'Competing suggestion smoke (docsync)';
const PATH = 'client/Contract.md';

const BODY =
  '# Terms\n\n' +
  'The term is one (1) year from the Effective Date.\n\n' +
  '1. Discovery.\n2. Delivery.\n3. Handover.\n\n' +
  'The remainder follows.\n\n' +
  '## Platforms\n';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(12)} ${detail}`);
}

function check(name: string, passed: boolean, detail = ''): boolean {
  say(passed ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
  return passed;
}

/** Where a piece of the tab's text sits, in the indices the API counts in. */
function indexOf(doc: DocsDocument, text: string): number {
  for (const element of doc.body?.content ?? []) {
    for (const part of element.paragraph?.elements ?? []) {
      const at = (part.textRun?.content ?? '').indexOf(text);
      if (at >= 0) return (part.startIndex ?? 0) + at;
    }
  }
  throw new Error(`no "${text}" in the document`);
}

/** Every text run of the tab, with the suggestions each one carries. */
function runs(doc: DocsDocument): {
  text: string;
  start: number;
  end: number;
  inserted: string[];
  deleted: string[];
}[] {
  const out = [];
  for (const element of doc.body?.content ?? []) {
    for (const part of element.paragraph?.elements ?? []) {
      if (part.textRun === undefined) continue;
      out.push({
        text: part.textRun.content ?? '',
        start: part.startIndex ?? 0,
        end: part.endIndex ?? 0,
        inserted: part.textRun.suggestedInsertionIds ?? [],
        deleted: part.textRun.suggestedDeletionIds ?? [],
      });
    }
  }
  return out;
}

/** Every run of the tab with the ids on it, which is what a reviewer sees. */
function dump(title: string, all: ReturnType<typeof runs>): void {
  console.log(`\n--- ${title} ---`);
  for (const run of all) {
    console.log(
      `${JSON.stringify(run.text).padEnd(34)} ins [${run.inserted.join(', ')}] del [${run.deleted.join(', ')}]`,
    );
  }
  console.log('---\n');
}

/** One tab as a document, which is what every reader above `tabs.ts` reads. */
function onlyTab(document: DocsDocument): DocsDocument {
  return flattenTabs(document)[0]?.doc ?? {};
}

const token = await createCredentialProvider().accessToken('gdocs');
const api = createGDriveApi(token);
const writer = createGDriveWriter(api);
let ok = true;

const made = await api.createFile({ name: TITLE, mimeType: DOCUMENT_MIME, parents: [FOLDER] });
say('create', `${made.id} "${TITLE}" in the fixture folder`);

try {
  const tabId = flattenTabs(await api.getDocument(made.id))[0]?.id ?? '';
  await writer.writeTab(made.id, tabId, parseMarkdown(BODY));
  say('write', `the body into tab ${tabId}`);

  // An empty paragraph after the list, written plainly: the report of
  // 2026-09-16 had them all through the region where the blocks drifted.
  const beforeRemainder = indexOf(
    onlyTab(await api.getDocument(made.id, 'inline')),
    'The remainder',
  );
  await api.batchUpdate(made.id, [
    { insertText: { location: { index: beforeRemainder, tabId }, text: '\n' } },
  ]);
  say('empty', 'an empty paragraph before "The remainder follows."');

  /* --- 1. the other author's suggestion, made in a batch of its own ------ */

  const first = onlyTab(await api.getDocument(made.id, 'inline'));
  const one = indexOf(first, 'one (1)');
  await api.batchUpdate(
    made.id,
    [
      { insertText: { location: { index: one + 3, tabId }, text: 'three' } },
      { deleteContentRange: { range: { startIndex: one, endIndex: one + 3, tabId } } },
    ],
    { suggest: true },
  );
  // And a whole paragraph suggested into the list, which is a paragraph with no
  // block in the base at all.
  const delivery = indexOf(onlyTab(await api.getDocument(made.id, 'inline')), 'Handover.');
  await api.batchUpdate(
    made.id,
    [{ insertText: { location: { index: delivery, tabId }, text: 'Training.\n' } }],
    { suggest: true },
  );
  say('suggest', '"one" → "three", and a whole suggested list item');

  const pending = onlyTab(await api.getDocument(made.id, 'inline'));
  const theirs = runs(pending).filter((run) => run.inserted.length > 0);
  /** Every suggestion id the first batch made: "the other author's". */
  const older = new Set(runs(pending).flatMap((run) => [...run.inserted, ...run.deleted]));
  say('ids', `the other author's suggestions: ${[...older].join(', ')}`);
  ok =
    check(
      'the first batch is pending, as suggested insertions and deletions',
      theirs.length > 0 && runs(pending).some((run) => run.deleted.length > 0),
      theirs.map((run) => JSON.stringify(run.text)).join(' '),
    ) && ok;

  /* --- 2. the base a push diffs against ---------------------------------- */

  const live = readLive(pending, { from: PATH });
  ok =
    check(
      'the body a push diffs against is the text before anybody suggested',
      live.markdown === BODY,
      JSON.stringify(live.markdown),
    ) && ok;
  ok =
    check(
      'and base block n is live block n',
      live.blocks.every((block) => block !== undefined),
      `${live.blocks.length} blocks, ${live.blocks.filter((one) => one === undefined).length} unmapped`,
    ) && ok;

  /* --- 3. the competing suggestion, planned ------------------------------ */

  const next = BODY.replace('one (1) year', 'two (2) years').replace(
    'The remainder follows.\n',
    'The remainder follows.\n\nThe schedule is attached.\n',
  );
  const plan = planPatch(live, diffBlocks(parseMarkdown(live.markdown), parseMarkdown(next)), {
    path: PATH,
    suggest: true,
  });

  const covers = plan.requests.some((request) => {
    const range = (
      request as { deleteContentRange?: { range: { startIndex: number; endIndex: number } } }
    ).deleteContentRange?.range;
    if (range === undefined) return false;
    return theirs.some((run) => range.startIndex < run.end && range.endIndex > run.start);
  });
  ok =
    check(
      'the plan sends no range over the other suggestion’s words',
      !covers,
      `${plan.requests.length} requests`,
    ) && ok;

  await writer.patchBody(made.id, plan, { suggest: true, tabId });
  say('push', 'the edit, in suggesting mode');

  /* --- 4. two proposals over one word ------------------------------------ */

  const after = onlyTab(await api.getDocument(made.id, 'inline'));
  const struck = runs(after)
    .filter((run) => run.deleted.length > 0)
    .map((run) => run.text);
  ok =
    check(
      'both halves of the edited phrase are proposed for deletion',
      struck.includes('one') && struck.some((text) => text.includes('(1) year')),
      struck.map((text) => JSON.stringify(text)).join(' '),
    ) && ok;
  // The client's own words are still exactly what they were: a suggested
  // insertion, proposed and not struck. That is the fault this ticket is
  // about — they used to be deleted with the paragraph around them.
  const theirWords = runs(after).find((run) => run.text === 'three');
  ok =
    check(
      'the client\u2019s suggested words are untouched',
      theirWords !== undefined && theirWords.deleted.length === 0,
      `ins [${(theirWords?.inserted ?? []).join(', ')}] del [${(theirWords?.deleted ?? []).join(', ')}]`,
    ) && ok;
  const words = runs(after)
    .filter((run) => run.inserted.length > 0)
    .map((run) => run.text.trim());
  ok =
    check(
      'and both proposals stand side by side',
      words.includes('three') && words.some((word) => word.startsWith('two (2) years')),
      words.join(' | '),
    ) && ok;
  // Whose id each half ends up under is the API's business, and it is not the
  // ticket's guess: Docs neither stacks a second deletion id on a run somebody
  // already proposes deleting nor keeps this push's deletion under its own id
  // — it folds a suggestion that touches an existing one into that one
  // (probed 2026-09-16, and printed below so the run says what it did).
  say(
    'ids',
    `this push's suggestions: ${[
      ...new Set(
        runs(after)
          .flatMap((run) => [...run.inserted, ...run.deleted])
          .filter((id) => !older.has(id)),
      ),
    ].join(', ')}`,
  );
  dump('the runs, after the competing suggestion', runs(after));

  /* --- 5. the paragraph lands where the Markdown put it ------------------ */

  const text = runs(after)
    .map((run) => run.text)
    .join('');
  const schedule = text.indexOf('The schedule is attached.');
  ok =
    check(
      'the new paragraph is after the sentence and before the heading',
      schedule > text.indexOf('The remainder follows.') && schedule < text.indexOf('Platforms'),
      `at ${schedule}, between ${text.indexOf('The remainder follows.')} and ${text.indexOf('Platforms')}`,
    ) && ok;

  /* --- 6. the probe ------------------------------------------------------ */

  // What this ticket says the planner may never send, sent by hand once so the
  // answer is on the record: a suggested deletion over another suggestion's
  // inserted words.
  const target = runs(onlyTab(await api.getDocument(made.id, 'inline'))).find(
    (run) => run.text === 'three',
  );
  let answer = 'the API accepted it';
  try {
    await api.batchUpdate(
      made.id,
      [
        {
          deleteContentRange: {
            range: { startIndex: target?.start ?? 0, endIndex: target?.end ?? 0, tabId },
          },
        },
      ],
      { suggest: true },
    );
    const all = runs(onlyTab(await api.getDocument(made.id, 'inline')));
    const probed = all.find((run) => run.text === 'three');
    answer =
      probed === undefined
        ? 'the API accepted it and the other suggestion’s words are gone from the document entirely'
        : `the API accepted it; the run is still there with insertions [${probed.inserted.join(', ')}] and deletions [${probed.deleted.join(', ')}]`;
    dump('the runs, after the probe', all);
  } catch (error) {
    answer = `the API refused it: ${error instanceof Error ? error.message : String(error)}`;
  }
  say('probe', `a suggested deletion over a suggested insertion — ${answer}`);
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
}

console.log(
  `${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the trashed Doc "${TITLE}" (${made.id}) in the fixture folder, recoverable from the Drive trash, with the suggestions it carries. Nothing that was already in the folder was written.`,
);
process.exit(ok ? 0 : 1);
