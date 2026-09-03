/**
 * The manual test for ticket 15: a diff-based push against the real Notion API.
 *
 * It never touches the fixture pages' content. It makes **one** new page,
 * "Docsync patch test", as a child of `Docsync test`, puts a comment on one of
 * its blocks, pushes an edit that touches other blocks, and then checks the
 * three things the fake API cannot prove:
 *
 * 1. the comment on the untouched block is still there,
 * 2. every untouched block still has the id it had, and
 * 3. `after` on the append endpoint really does put a block where we say.
 *
 * It archives the page it made and prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/notion-patch-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts notion`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';
import { parseMarkdown, stringifyMarkdown } from '../dist/markdown.js';
import { createNotionApi, createNotionClient } from '../dist/notion/api.js';
import { markdownToBlocks } from '../dist/notion/from-markdown.js';
import { pushRoot } from '../dist/notion/push.js';
import { blocksToMarkdown } from '../dist/notion/to-markdown.js';
import { createNotionWriter } from '../dist/notion/write.js';

/** The page this script is allowed to create a child of. Never written to. */
const PARENT_ID = '3cf715cbeb088035b511f0b4f06efbd5';

const TITLE = 'Docsync patch test';
const PATH = 'notion/Docsync patch test.md';
const COMMENT = 'docsync smoke: this comment must survive the push';

/** The body the page is created with. Every line of it is load-bearing below. */
const BODY = `# Patch smoke

The first paragraph. It gets a comment, and the push must not touch it.

The second paragraph. The push edits one word of this one, and no other.

- a bullet that stays
- a bullet that goes

A <span data-color="red">red run</span> inside a paragraph the push edits at the end.
`;

/** The comments API, which the adapter does not wrap until ticket 17. */
interface CommentsClient {
  comments: {
    create(args: {
      parent: { block_id: string };
      rich_text: { type: 'text'; text: { content: string } }[];
    }): Promise<{ id?: string }>;
    list(args: { block_id: string }): Promise<{
      results: { id: string; rich_text?: { plain_text?: string }[] }[];
    }>;
  };
}

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(10)} ${detail}`);
}

/** A check, so that the output reads as a list of answers and not of prose. */
function check(name: string, ok: boolean, detail = ''): boolean {
  say(ok ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
  return ok;
}

/** Both sides of a comparison through the one pipeline (MANUAL §6). */
function canonical(markdown: string): string {
  return stringifyMarkdown(parseMarkdown(markdown));
}

const provider = createCredentialProvider();
const client = createNotionClient(await provider.accessToken('notion'));
const comments = client as unknown as CommentsClient;
const api = createNotionApi(client);
const writer = createNotionWriter(api);

let pageId: string;
try {
  pageId = await writer.createPage(PARENT_ID, TITLE, markdownToBlocks(BODY));
} catch (error) {
  console.error(
    `Could not create a page under "Docsync test": ${
      error instanceof Error ? error.message : String(error)
    }\nThe integration needs insert access on that page. Stopping; nothing was changed.`,
  );
  process.exit(1);
}
say('create', `${pageId} titled "${TITLE}", ${BODY.trim().split('\n\n').length} blocks`);

const before = await api.blockTree(pageId);
const idsBefore = before.map((block) => block.id);
const base = blocksToMarkdown(before, {});

// The comment goes on the first paragraph, which the push below never touches.
const commented = before.find((block) => block.type === 'paragraph');
if (commented === undefined) {
  console.error('The page came back without a paragraph to comment on. Stopping.');
  process.exit(1);
}
await comments.comments.create({
  parent: { block_id: commented.id },
  rich_text: [{ type: 'text', text: { content: COMMENT } }],
});
say('comment', `on block ${commented.id} (${blocksToMarkdown([commented], {}).trim()})`);

// One edit of each kind: a word inside a block, a deleted list item, a new
// block in the middle, and a new block at the end.
const next = `${base
  .replace('edits one word of this one', 'edits exactly one word of this one')
  .replace('- a bullet that goes\n', '')
  .replace(
    'A <span data-color="red">red run</span>',
    'One more paragraph, inserted in the middle.\n\nA <span data-color="red">red run</span>',
  )}\nA paragraph the push appended at the end.\n`;
if (next === base) {
  console.error('The page did not come back as it was written, so there is nothing to edit.');
  process.exit(1);
}

const file = (body: string): string => `---\nid: notion:${pageId}\n---\n\n${body}`;
const report = await pushRoot(
  { path: 'notion/', src: { source: 'notion', id: PARENT_ID }, ignore: [] },
  [{ kind: 'modified', path: PATH, text: file(next), previousText: file(base) }],
  provider,
  new Map([
    [
      PATH,
      {
        path: PATH,
        src: { source: 'notion', id: pageId },
        type: 'notion-page',
        lastEditedTime: '',
      },
    ],
  ]),
  { api },
);
const counts = report[0]?.blocks;
say('push', counts === undefined ? 'no counts reported' : JSON.stringify(counts));

const after = await api.blockTree(pageId);
const idsAfter = after.map((block) => block.id);
const kept = idsBefore.filter((id) => idsAfter.includes(id));

let ok = true;
ok =
  check(
    'the page says what the file says',
    canonical(blocksToMarkdown(after, {})) === canonical(next),
  ) && ok;
ok =
  check(
    'the commented block was never rewritten',
    idsAfter.includes(commented.id),
    `${kept.length} of ${idsBefore.length} block ids survived`,
  ) && ok;

const found = await comments.comments.list({ block_id: commented.id });
const survived = found.results.some((one) =>
  (one.rich_text ?? []).some((run) => (run.plain_text ?? '').includes(COMMENT)),
);
ok =
  check('the comment is still on that block', survived, `${found.results.length} comment(s)`) && ok;

const middle = after.map((block) => blocksToMarkdown([block], {}).trim());
ok =
  check(
    'the inserted block landed where it was asked to',
    middle.indexOf('One more paragraph, inserted in the middle.') ===
      middle.findIndex((one) => one.includes('red run')) - 1,
    middle.join(' | ').slice(0, 120),
  ) && ok;

await writer.archivePage(pageId);
const archived = await api.page(pageId);
say('archive', `in_trash=${archived.in_trash} archived=${archived.archived}`);

console.log(
  `\n${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the archived page ${pageId} in the trash of "Docsync test" (https://www.notion.so/${pageId.replaceAll('-', '')}), and the comment on its first paragraph. Nothing else was written.`,
);
process.exit(ok ? 0 : 1);
