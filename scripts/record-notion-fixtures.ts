/**
 * Record the Notion fixture tree, once, with the owner's own token.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/record-notion-fixtures.ts
 *
 * Walks the private page "Docsync test" and writes the raw API responses to
 * `src/notion/__fixtures__/`, which is what every test above `api.ts` runs on.
 * Read-only: it calls `pages.retrieve`, `blocks.children.list` and
 * `users.retrieve` and nothing else, so it cannot change the workspace.
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

const api = createNotionApi(
  createNotionClient(await createCredentialProvider().accessToken('notion')),
);

const users = new Map();
const pageIds = [];

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
