/**
 * The manual test for #42: a Doc whose paragraphs hold a soft line break
 * where Markdown has trouble with one, against the real Docs API.
 *
 * The fake model proves the converter. Only Google can say that it really
 * stores a run boundary right behind a vertical tab, which is the shape that
 * used to leave an empty text node and an unescaped `# x` behind it. So this
 * makes a Doc of its own inside the fixture folder "Docsync test" — nothing
 * that is already there is written or renamed — and checks:
 *
 * 1. a paragraph `First target.⏎# not a heading`, the words after the break in
 *    a run of their own (a colour the dialect cannot name), reads as one
 *    paragraph with the `#` escaped,
 * 2. a paragraph `Second target.⏎1. not a list`, the words after the break
 *    bold, reads as one paragraph and no `&#xNAN;`,
 * 3. a paragraph ending in a soft line break reads without it,
 * 4. what was read parses back to itself, which is the base check of a push,
 * 5. a push that edits another paragraph plans no request inside those three,
 * 6. and after it the three are what they were, the trailing break included.
 *
 * It trashes the Doc at the end — trashed, never deleted (MANUAL §8) — and
 * prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdocs-soft-break-smoke.ts
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
import { parseMarkdown, stringifyMarkdown } from '../dist/markdown.js';

/** The read-only fixture folder. The Doc this script makes is its own. */
const FOLDER = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const TITLE = 'Soft line break smoke (docsync)';
const PATH = 'client/Notes.md';
/** A soft line break, as Docs stores it. */
const VERTICAL_TAB = String.fromCharCode(11);

const BODY =
  '# Notes\n\n' +
  'First target.\n\n' +
  'Second target.\n\n' +
  'Third target.\n\n' +
  'An unrelated paragraph.\n';

const EXPECTED =
  '# Notes\n\n' +
  'First target.\\\n\\# not a heading\n\n' +
  'Second target.\\\n**1. not a list**\n\n' +
  'Third target.\n\n' +
  'An unrelated paragraph.\n';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(12)} ${detail}`);
}

function check(name: string, passed: boolean, detail = ''): boolean {
  say(passed ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
  return passed;
}

/** One tab as a document, which is what every reader above `tabs.ts` reads. */
function onlyTab(document: DocsDocument): DocsDocument {
  return flattenTabs(document)[0]?.doc ?? {};
}

/** The tab's text, run after run. */
function textOf(doc: DocsDocument): string {
  return (doc.body?.content ?? [])
    .flatMap((element) => element.paragraph?.elements ?? [])
    .map((part) => part.textRun?.content ?? '')
    .join('');
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

  /** Text put behind a sentence, inside its paragraph, and where it landed. */
  const append = async (sentence: string, text: string): Promise<number> => {
    const at = indexOf(onlyTab(await api.getDocument(made.id)), sentence) + sentence.length;
    await api.batchUpdate(made.id, [{ insertText: { location: { index: at, tabId }, text } }]);
    return at;
  };

  const first = await append('First target.', `${VERTICAL_TAB}# not a heading`);
  await api.batchUpdate(made.id, [
    {
      updateTextStyle: {
        range: { startIndex: first + 1, endIndex: first + 1 + '# not a heading'.length, tabId },
        textStyle: { foregroundColor: { color: { rgbColor: { red: 0.6, green: 0, blue: 0 } } } },
        fields: 'foregroundColor',
      },
    },
  ]);
  const second = await append('Second target.', `${VERTICAL_TAB}1. not a list`);
  await api.batchUpdate(made.id, [
    {
      updateTextStyle: {
        range: { startIndex: second + 1, endIndex: second + 1 + '1. not a list'.length, tabId },
        textStyle: { bold: true },
        fields: 'bold',
      },
    },
  ]);
  await append('Third target.', VERTICAL_TAB);
  say('breaks', 'a coloured run and a bold run behind a break, and a break at a paragraph’s end');

  /* --- 1–4. what a fetch reads ------------------------------------------- */

  const doc = onlyTab(await api.getDocument(made.id));
  const stored = textOf(doc);
  ok =
    check(
      'Docs stores the three breaks as vertical tabs',
      stored.split(VERTICAL_TAB).length === 4,
      JSON.stringify(stored),
    ) && ok;

  const live = readLive(doc, { from: PATH });
  ok =
    check(
      'the Doc reads as the Markdown expected',
      live.markdown === EXPECTED,
      JSON.stringify(live.markdown),
    ) && ok;
  ok =
    check(
      'and parses back to itself, which is the base check of a push',
      stringifyMarkdown(parseMarkdown(live.markdown)) === live.markdown,
    ) && ok;
  ok =
    check(
      'every base block has its live block',
      live.blocks.every((block) => block !== undefined),
      `${live.blocks.length} blocks`,
    ) && ok;

  /* --- 5. an unrelated edit ---------------------------------------------- */

  const next = live.markdown.replace('An unrelated paragraph.', 'An edited paragraph.');
  const plan = planPatch(live, diffBlocks(parseMarkdown(live.markdown), parseMarkdown(next)), {
    path: PATH,
  });
  const floor = indexOf(doc, 'An unrelated');
  const indices =
    JSON.stringify(plan.requests).match(/"(?:index|startIndex|endIndex)":(\d+)/g) ?? [];
  ok =
    check(
      'the plan names no index inside the three paragraphs',
      indices.length > 0 && indices.every((one) => Number(one.split(':')[1]) >= floor),
      `${plan.requests.length} requests, all at or after ${floor}`,
    ) && ok;
  await writer.patchBody(made.id, plan, { tabId });
  say('push', 'the edit to the last paragraph');

  /* --- 6. nothing else moved --------------------------------------------- */

  const after = onlyTab(await api.getDocument(made.id));
  ok =
    check(
      'a fetch after the push reads the edited Markdown and nothing else',
      readLive(after, { from: PATH }).markdown === next,
      JSON.stringify(readLive(after, { from: PATH }).markdown),
    ) && ok;
  ok =
    check(
      'and the break at the end of the third paragraph is still in the Doc',
      textOf(after).includes(`Third target.${VERTICAL_TAB}\n`),
    ) && ok;
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
}

console.log(
  `${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the trashed Doc "${TITLE}" (${made.id}) in the fixture folder, recoverable from the Drive trash. Nothing that was already in the folder was written.`,
);
process.exit(ok ? 0 : 1);
