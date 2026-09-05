/**
 * The manual test for ticket 32: the Discovery Inputs rewrite, pushed for real.
 *
 * The fake Docs model (`src/gdrive/docs-model.mock.ts`) is only as good as what
 * it was checked against, and this ticket is about three defects a fake could
 * easily agree with. So the same rewrite the reproduction test runs in memory
 * runs here against the real API: a Doc built from `push-discovery-base.md`,
 * a diff-based push of `push-discovery-next.md` over it, a fetch, and a diff
 * of the fetch against what was pushed.
 *
 * It creates its own Doc **inside** the fixture folder "Docsync test" and
 * touches nothing else in it: the folder is otherwise READ ONLY. The Doc is
 * trashed (never permanently deleted) at the end, and the id is printed so it
 * can be found in the Drive trash.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/smoke-gdrive-patch.ts
 *
 * Sign in first with `docsync auth google`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialProvider } from '../dist/auth/index.js';
import { createGDriveApi } from '../dist/gdrive/api.js';
import { pushRoot } from '../dist/gdrive/push.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

/** The fixture folder. Read only except for the one Doc this script creates. */
const FOLDER = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const TITLE = `Patch smoke 32 ${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
const PATH = `drive/${TITLE}.md`;

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'gdrive',
  '__fixtures__',
);

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(10)} ${detail}`);
}

/** The lines that differ, as a unified-ish diff nobody has to squint at. */
function diff(expected: string, actual: string): string[] {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const out: string[] = [];
  const length = Math.max(a.length, b.length);
  for (let at = 0; at < length; at += 1) {
    if (a[at] === b[at]) continue;
    if (a[at] !== undefined) out.push(`-${at + 1}: ${a[at]}`);
    if (b[at] !== undefined) out.push(`+${at + 1}: ${b[at]}`);
  }
  return out;
}

const provider = createCredentialProvider();
const api = createGDriveApi(await provider.accessToken('gdocs'));
const writer = createGDriveWriter(api);

const base = fixture('push-discovery-base.md');
const next = fixture('push-discovery-next.md');

// 1. One Doc of our own, in the fixture folder. Nothing else there is touched.
const made = await writer.createDoc(FOLDER, TITLE, parseMarkdown(base));
say('create', `${made.id} "${TITLE}" in the "Docsync test" folder, ${made.batches} batch(es)`);

let ok = false;
try {
  // 2. What the Doc actually says now: the base a push diffs against. The
  //    fixture does not round-trip byte for byte through a create, so this,
  //    and not the file, is the previous version.
  const seeded = documentToMarkdown(await api.getDocument(made.id));
  const drift = diff(base, seeded);
  say('seeded', `${seeded.length} chars, ${drift.length} line(s) differ from the fixture`);
  for (const line of drift) console.log(`  ${line}`);

  // 3. The rewrite, pushed the way `docsync push` pushes it.
  const file = (body: string): string =>
    `---\nid: gdocs:${made.id}\ntitle: ${TITLE}\n---\n\n${body}`;
  const report = await pushRoot(
    { path: 'drive/', src: { source: 'gdocs', id: FOLDER }, ignore: [] },
    [{ kind: 'modified', path: PATH, text: file(next), previousText: file(seeded) }],
    provider,
    new Map([
      [
        PATH,
        { path: PATH, src: { source: 'gdocs', id: made.id }, type: 'gdoc', lastEditedTime: '' },
      ],
    ]),
    { api },
  );
  say('push', JSON.stringify(report[0]?.blocks ?? 'no counts reported'));

  // 4. The fetch after the push, against what was pushed.
  const after = documentToMarkdown(await api.getDocument(made.id));
  const found = diff(next, after);
  ok = found.length === 0;
  say(ok ? 'ok' : 'FAILED', `${found.length} line(s) differ from what was pushed`);
  for (const line of found) console.log(`  ${line}`);

  // The three defects of the ticket, named, so the output says which is which.
  const breaks = (text: string) => (text.match(/<!-- docsync:pagebreak -->/g) ?? []).length;
  say('breaks', `pushed ${breaks(next)}, fetched ${breaks(after)}`);
  say(
    'escape',
    after.includes('ALUMINUM_FENCE-25-26-WEB-150dpi.pdf')
      ? 'ALUMINUM_FENCE… came back unescaped'
      : `ALUMINUM_FENCE… came back as ${JSON.stringify(
          after.match(/ALUMINUM.{0,3}FENCE/)?.[0] ?? 'not found',
        )}`,
  );
  const orphans = ['3D models', 'Textures', 'Very project-dependant'].filter((one) =>
    after.includes(one),
  );
  say(
    'orphans',
    orphans.length === 0
      ? 'no deleted nested item survived'
      : `deleted nested items still there: ${orphans.join(', ')}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
}

console.log(
  `\n${ok ? 'The fetch after the push equals what was pushed.' : 'THE FETCH DIFFERS FROM WHAT WAS PUSHED.'}\n` +
    `Left behind: the trashed Doc "${TITLE}" (${made.id}), recoverable from the Drive trash. ` +
    'Nothing else in the "Docsync test" folder was read or written.',
);
process.exit(ok ? 0 : 1);
