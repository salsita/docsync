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
 * With `--suggest` (ticket 33) the same rewrite is pushed under a root with
 * `suggest: true`: the batch goes out in suggesting mode, and the script then
 * checks that the body did not move, that the sidecar makes exactly one thread
 * per distinct suggestion id however many paragraphs a suggestion spans
 * (ticket 34), and that what is waiting in the Doc says what the diff says.
 * That needs the Google Workspace Developer Preview Program on the Cloud
 * project that owns the OAuth client; without it the API refuses the batch and
 * the push says so.
 *
 *   node --experimental-strip-types scripts/smoke-gdrive-patch.ts --suggest
 *
 * Sign in first with `docsync auth google`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialProvider } from '../dist/auth/index.js';
import { formatSidecar } from '../dist/comments/format.js';
import { createGDriveApi } from '../dist/gdrive/api.js';
import { threadsOf } from '../dist/gdrive/comments.js';
import { pushRoot } from '../dist/gdrive/push.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

/** `--suggest`: push in suggesting mode and read the suggestions back. */
const SUGGEST = process.argv.includes('--suggest');

/** The fixture folder. Read only except for the one Doc this script creates. */
const FOLDER = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const TITLE = `Patch smoke ${SUGGEST ? 33 : 32} ${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
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

/**
 * The document's text with every pending suggestion accepted: suggested
 * insertions kept, suggested deletions dropped, one line per paragraph.
 */
function acceptedText(doc: {
  body?: {
    content?: {
      paragraph?: {
        elements?: { textRun?: { content?: string; suggestedDeletionIds?: string[] } }[];
      };
    }[];
  };
}): string {
  const lines: string[] = [];
  for (const element of doc.body?.content ?? []) {
    const runs = element.paragraph?.elements ?? [];
    const text = runs
      .filter((one) => (one.textRun?.suggestedDeletionIds ?? []).length === 0)
      .map((one) => one.textRun?.content ?? '')
      .join('');
    for (const line of text.split(/[\n\v]/)) lines.push(line.trim());
  }
  return lines.join('\n');
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
    {
      path: 'drive/',
      src: { source: 'gdocs', id: FOLDER },
      ignore: [],
      // A suggesting root pulls the sidecars: that is where a suggestion is
      // read (MANUAL §4).
      ...(SUGGEST ? { comments: true, suggest: true } : {}),
    },
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
  say(
    'push',
    `${report[0]?.action ?? 'nothing'} ${JSON.stringify(report[0]?.blocks ?? 'no counts reported')}` +
      (SUGGEST ? ', sent in suggesting mode' : ''),
  );

  if (SUGGEST) {
    // 4. The body did not move: a suggesting batch writes nothing (MANUAL §7).
    const body = documentToMarkdown(await api.getDocument(made.id));
    const moved = diff(seeded, body);
    say(
      moved.length === 0 ? 'body' : 'FAILED',
      `${moved.length} line(s) of the body moved; a suggesting push moves none`,
    );
    for (const line of moved) console.log(`  ${line}`);

    // 5. What the client will see, read the way the fetch after the push reads
    //    it: inline, one sidecar thread per pending suggestion (MANUAL §6).
    const inline = await api.getDocument(made.id, 'inline');
    const threads = threadsOf(inline, [], body);
    const suggestions = threads.filter((one) => one.kind === 'suggestion');
    // A suggestion is one id and one card in Docs, so it is one thread whatever
    // it spans: the counts have to agree (ticket 34).
    const ids = new Set(suggestions.map((one) => one.id));
    const grouped = suggestions.length === ids.size;
    say(
      grouped ? 'suggested' : 'FAILED',
      `${ids.size} distinct suggestion id(s), ${suggestions.length} sidecar thread(s)` +
        (grouped ? '' : '; a suggestion that spans blocks must still be one thread'),
    );
    console.log(
      formatSidecar({
        document: { source: 'gdocs', id: made.id },
        fetched: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        threads,
      }),
    );

    // 6. And they say what the rewrite says: with every suggestion accepted,
    //    the Doc's paragraphs carry every line the diff adds. A thread shows
    //    one suggestion at a time, so a paragraph two of them edit reads right
    //    only with both, and the marks of the dialect are not in a paragraph.
    const plain = (line: string): string =>
      line
        .replaceAll(/\*\*|`|\\$/g, '')
        .replace(/^[\s>]*(?:[-*]|\d+\.|#+)?\s*/, '')
        .trim();
    const wanted = diff(seeded, next)
      .filter((one) => one.startsWith('+'))
      .map((one) => plain(one.slice(one.indexOf(': ') + 2)))
      .filter((one) => one !== '' && !one.startsWith('<!--'));
    const accepted = acceptedText(inline);
    const missing = wanted.filter((line) => !accepted.includes(line));
    ok = moved.length === 0 && suggestions.length > 0 && grouped && missing.length === 0;
    say(
      ok ? 'ok' : 'FAILED',
      missing.length === 0
        ? 'with every suggestion accepted, the Doc says what the rewrite says'
        : `${missing.length} added line(s) are missing with every suggestion accepted`,
    );
    for (const line of missing) console.log(`  ${line}`);
  } else {
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
    // The nested items of the three deleted list items, worded so that no line
    // of `next` contains them: what survived a deletion of its parent.
    const orphans = [
      'Real photographs when possible',
      'A source from which we can infer the branding',
      'Very project-dependant',
    ].filter((one) => after.includes(one));
    say(
      'orphans',
      orphans.length === 0
        ? 'no deleted nested item survived'
        : `deleted nested items still there: ${orphans.join(', ')}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
}

const verdict = SUGGEST
  ? ok
    ? 'The body is untouched, one thread per suggestion, and the suggestions say what the rewrite says.'
    : 'THE SUGGESTING PUSH DID NOT DO WHAT IT SAYS.'
  : ok
    ? 'The fetch after the push equals what was pushed.'
    : 'THE FETCH DIFFERS FROM WHAT WAS PUSHED.';

console.log(
  `\n${verdict}\n` +
    `Left behind: the trashed Doc "${TITLE}" (${made.id}), recoverable from the Drive trash. ` +
    'Nothing else in the "Docsync test" folder was read or written.',
);
process.exit(ok ? 0 : 1);
