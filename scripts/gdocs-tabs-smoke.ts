/**
 * The manual test for #37: tabs against the real Docs API.
 *
 * The fake model and the recorded fixtures prove the *reading* of tabs; only
 * Google can say whether the three tab requests and a `tabId` on every
 * location and range do what the documentation claims. So this makes a Doc of
 * its own inside the fixture folder "Docsync test" — nothing that is already
 * there is read, written or renamed — and checks:
 *
 * 1. `addDocumentTab` makes a tab and answers its id,
 * 2. a batch whose locations carry `tabId` lands in *that* tab, and the first
 *    tab is left exactly as it was — which is the whole bug of #37,
 *    since a request with no `tabId` goes to the first tab,
 * 3. `updateDocumentTabProperties` with `fields: title` retitles a tab,
 * 4. a nested tab (`parentTabId`) comes back nested, and
 * 5. `documents.get` with `includeTabsContent=true` answers every tab and no
 *    top-level body.
 *
 * It trashes the Doc at the end — trashed, never deleted (MANUAL §8) — and
 * prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdocs-tabs-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts gdocs`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';
import { createGDriveApi, DOCUMENT_MIME } from '../dist/gdrive/api.js';
import { flattenTabs } from '../dist/gdrive/tabs.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

/** The read-only fixture folder. The Doc this script makes is its own. */
const FOLDER = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const TITLE = 'Tabs smoke (docsync)';

const FIRST = 'The first tab. Nothing in this script may touch it.\n';
const SECOND = 'The second tab, written with a tabId on every location.\n';
const NESTED = 'A tab nested under the second one.\n';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(10)} ${detail}`);
}

function check(name: string, passed: boolean, detail = ''): boolean {
  say(passed ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
  return passed;
}

const api = createGDriveApi(await createCredentialProvider().accessToken('gdocs'));
const writer = createGDriveWriter(api);
let ok = true;

const made = await api.createFile({ name: TITLE, mimeType: DOCUMENT_MIME, parents: [FOLDER] });
say('create', `${made.id} "${TITLE}" in the fixture folder`);

try {
  // 1. The Doc has one tab, and only a read can say what its id is.
  const fresh = flattenTabs(await api.getDocument(made.id));
  const firstTab = fresh[0]?.id ?? '';
  ok =
    check(
      'a new Doc has exactly one tab, with an id',
      fresh.length === 1 && firstTab !== '',
      `tabId ${firstTab}`,
    ) && ok;

  await writer.writeTab(made.id, firstTab, parseMarkdown(FIRST));
  say('write', `the first tab (${firstTab})`);

  // 2. A second tab, and a body written into it by id.
  const second = await writer.addTab(made.id, 'Second tab');
  say('addTab', `${second} "Second tab"`);
  await writer.writeTab(made.id, second, parseMarkdown(SECOND));

  // 3. A tab nested under it.
  const nested = await writer.addTab(made.id, 'Nested tab', second);
  say('addTab', `${nested} "Nested tab" under ${second}`);
  await writer.writeTab(made.id, nested, parseMarkdown(NESTED));

  // 4. And a retitle of the second tab.
  await writer.renameTab(made.id, second, 'Full notes');
  say('rename', `${second} → "Full notes"`);

  const document = await api.getDocument(made.id);
  ok =
    check(
      'the reply carries the tabs and no top-level body',
      document.tabs !== undefined && document.body === undefined,
      `${document.tabs?.length ?? 0} root tab(s)`,
    ) && ok;

  const tabs = flattenTabs(document);
  ok =
    check(
      'every tab came back, parent before child',
      tabs.map((tab) => tab.id).join(',') === [firstTab, second, nested].join(','),
      tabs.map((tab) => `${tab.title}(${tab.id})`).join(' '),
    ) && ok;

  const text = new Map(tabs.map((tab) => [tab.id ?? '', documentToMarkdown(tab.doc)]));
  ok =
    check(
      'the first tab holds what was written into it, and nothing else',
      text.get(firstTab) === FIRST,
      JSON.stringify(text.get(firstTab)),
    ) && ok;
  ok =
    check(
      'the second tab holds its own body: tabId decided where the batch went',
      text.get(second) === SECOND,
      JSON.stringify(text.get(second)),
    ) && ok;
  ok = check('the nested tab holds its own body', text.get(nested) === NESTED) && ok;
  ok =
    check(
      'the retitle took, and the nesting is what it was asked for',
      tabs.find((tab) => tab.id === second)?.title === 'Full notes' &&
        tabs.find((tab) => tab.id === nested)?.parentId === second,
    ) && ok;
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
}

console.log(
  `\n${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the trashed Doc "${TITLE}" (${made.id}) in the fixture folder, recoverable from the Drive trash. Nothing that was already in the folder was read or written.`,
);
process.exit(ok ? 0 : 1);
