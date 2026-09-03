/**
 * Record the Notion fixture tree, once, with the owner's own token.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/record-notion-fixtures.ts
 *
 * Walks the private page "Docsync test" and writes the raw API responses to
 * `src/notion/__fixtures__/`, which is what every test above `api.ts` runs on.
 * Read-only: it calls `pages.retrieve`, `blocks.children.list`,
 * `users.retrieve` and `GET /v1/comments` and nothing else, so it cannot
 * change the workspace.
 *
 * Comments are recorded per page as one map from block id to the comments on
 * that block, because `GET /v1/comments?block_id=<page>` answers only the
 * page-level ones: a block comment needs a request of its own (ticket 17).
 *
 * Re-run only deliberately. File URLs inside the recorded JSON are signed and
 * expire within the hour; that is fine, nothing downloads them.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialProvider } from '../dist/auth/index.js';
import { createNotionApi, createNotionClient, NOTION_VERSION } from '../dist/notion/api.js';

const ROOT_ID = '3cf715cbeb088035b511f0b4f06efbd5';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'notion', '__fixtures__');

const token = await createCredentialProvider().accessToken('notion');
const api = createNotionApi(createNotionClient(token));

const users = new Map();
const pageIds = [];
let commentRequests = 0;

/**
 * The comments on one block, across every page of results. Plain `fetch`
 * rather than the SDK, so that this script stays runnable against a build that
 * does not know about comments yet.
 */
async function commentsOn(blockId) {
  const results = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ block_id: blockId, page_size: '100' });
    if (cursor !== undefined) query.set('start_cursor', cursor);
    const response = await fetch(`https://api.notion.com/v1/comments?${query}`, {
      headers: { authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
    });
    commentRequests += 1;
    if (!response.ok) throw new Error(`${response.status} on comments ${blockId}`);
    const page = await response.json();
    results.push(...page.results);
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return results;
}

/** Every block of a page that can carry a comment: the tree, flattened. */
function commentable(blocks) {
  const out = [];
  for (const block of blocks) {
    // A child page or database is a document of its own; its comments belong
    // to it and are recorded when the walk reaches it.
    if (block.type === 'child_page' || block.type === 'child_database') continue;
    out.push(block.id);
    if (block.children !== undefined) out.push(...commentable(block.children));
  }
  return out;
}

/** Every user id a page object or block tree mentions. */
function collectUsers(value) {
  if (Array.isArray(value)) {
    for (const item of value) collectUsers(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value;
  if (record.object === 'user' && typeof record.id === 'string') users.set(record.id, null);
  for (const item of Object.values(record)) collectUsers(item);
}

async function write(name, value) {
  await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  ${name}.json`);
}

/** Records one page and every child page under it, depth first. */
async function record(id) {
  const page = await api.page(id);
  const blocks = await api.blockTree(id);
  collectUsers(page);
  collectUsers(blocks);
  pageIds.push(id);
  await write(`page-${id}`, page);
  await write(`blocks-${id}`, blocks);

  // One request per block, plus one for the page itself (ticket 17).
  const comments = {};
  for (const blockId of [id, ...commentable(blocks)]) {
    const found = await commentsOn(blockId);
    comments[blockId] = found;
    collectUsers(found);
  }
  await write(`comments-${id}`, comments);

  for (const block of blocks) {
    if (block.type === 'child_page') await record(block.id.replaceAll('-', ''));
    if (block.type === 'child_database') console.log(`  (skipped database ${block.id})`);
  }
}

await mkdir(OUT, { recursive: true });
console.log(`Recording ${ROOT_ID} at Notion-Version ${NOTION_VERSION}:`);
await record(ROOT_ID);

for (const id of [...users.keys()])
  users.set(id, (await api.user(id)) ?? { id, unavailable: true });
await write('users', Object.fromEntries(users));
await write('index', { rootId: ROOT_ID, notionVersion: NOTION_VERSION, pageIds });
console.log(`${commentRequests} comment requests for ${pageIds.length} pages`);
