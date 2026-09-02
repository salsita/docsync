/**
 * The manual test for ticket 06: create, replace, rename and archive, against
 * the real Notion API.
 *
 * It never touches the fixture pages. It makes **one** new page, "Docsync write
 * test", as a child of `Docsync test`, does all four operations on that page,
 * and leaves it archived. Re-running it makes another one.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/notion-write-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts notion`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';
import { createNotionApi, createNotionClient } from '../dist/notion/api.js';
import { markdownToBlocks } from '../dist/notion/from-markdown.js';
import { blocksToMarkdown } from '../dist/notion/to-markdown.js';
import { titleOf } from '../dist/notion/walk.js';
import { createNotionWriter } from '../dist/notion/write.js';

/** The fixture tree, which this script reads and never writes. */
const PARENT_ID = '3cf715cbeb088035b511f0b4f06efbd5';
const BLOCKS_ID = '3cf715cbeb0881168ea0f3f18715e1a4';

const TITLE = 'Docsync write test';
const RENAMED = 'Docsync write test (renamed)';

const REPLACEMENT = `# Replaced body

The first body is gone; this is the second one.

- with a list
- and a second item

| a | b |
|---|---|
| c | d |
`;

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(10)} ${detail}`);
}

const provider = createCredentialProvider();
const api = createNotionApi(createNotionClient(await provider.accessToken('notion')));
const writer = createNotionWriter(api);

// The body to create the page with: the Blocks page, converted to Markdown and
// straight back, which is the whole of ticket 06 in one line.
const source = await api.blockTree(BLOCKS_ID);
const markdown = blocksToMarkdown(source, {});
const blocks = markdownToBlocks(markdown);
say('source', `${source.length} blocks -> ${markdown.length} bytes -> ${blocks.length} blocks`);

let pageId: string;
try {
  pageId = await writer.createPage(PARENT_ID, TITLE, blocks);
} catch (error) {
  console.error(
    `Could not create a page under "Docsync test": ${
      error instanceof Error ? error.message : String(error)
    }\nThe integration needs insert access on that page. Stopping; nothing was changed.`,
  );
  process.exit(1);
}

say('create', `${pageId} titled "${titleOf(await api.page(pageId))}"`);

// The point of the exercise: what Notion made out of our blocks converts back
// to the Markdown we would have got had we pushed nothing at all.
const readBack = blocksToMarkdown(await api.blockTree(pageId), {});
const expected = blocksToMarkdown(blocks as never, {});
say('verify', readBack === expected ? 'reads back byte-identical' : 'DIFFERS from what we sent');
if (readBack !== expected) {
  const ours = expected.split('\n');
  for (const [at, line] of readBack.split('\n').entries()) {
    if (line !== ours[at])
      console.log(`  ${at}: sent ${JSON.stringify(ours[at])}`, `got ${JSON.stringify(line)}`);
  }
}

await writer.replaceBody(pageId, markdownToBlocks(REPLACEMENT));
const replaced = await api.blockTree(pageId);
say('replace', `${replaced.length} top-level blocks: ${replaced.map((b) => b.type).join(', ')}`);

await writer.renamePage(pageId, RENAMED);
say('rename', `now titled "${titleOf(await api.page(pageId))}"`);

await writer.archivePage(pageId);
const archived = await api.page(pageId);
say('archive', `in_trash=${archived.in_trash} archived=${archived.archived}`);

console.log(`\nhttps://www.notion.so/${pageId.replaceAll('-', '')}`);
