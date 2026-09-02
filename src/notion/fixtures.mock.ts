/**
 * The recorded Notion tree, as `scripts/record-notion-fixtures.ts` wrote it.
 *
 * Raw API responses, committed: every test above `api.ts` runs on these, so the
 * converter and the walk are exercised on what Notion really answers and never
 * on a hand-written approximation. Signed file URLs inside them have expired
 * long ago, which does not matter — nothing downloads them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NotionBlock, RawObject } from './api.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8')) as T;
}

interface Index {
  rootId: string;
  notionVersion: string;
  pageIds: string[];
}

const index = load<Index>('index');

/** The root of the fixture tree: the private page "Docsync test". */
export const ROOT_ID = index.rootId;

/** Every recorded page id, root first, in the order the walk found them. */
export const PAGE_IDS = index.pageIds;

/** The page object for one recorded page. */
export function fixturePage(id: string): RawObject {
  return load<RawObject>(`page-${id}`);
}

/** The full block tree for one recorded page. */
export function fixtureBlocks(id: string): NotionBlock[] {
  return load<NotionBlock[]>(`blocks-${id}`);
}

/** Every user the recorded tree refers to, by id. */
export function fixtureUsers(): Record<string, RawObject> {
  return load<Record<string, RawObject>>('users');
}

/** The title of a recorded page, for tests that need to name one. */
export function fixtureTitle(id: string): string {
  const properties = fixturePage(id).properties as
    | Record<string, { type?: string; title?: { plain_text?: string }[] }>
    | undefined;
  for (const property of Object.values(properties ?? {})) {
    if (property.type === 'title') {
      return (property.title ?? []).map((part) => part.plain_text ?? '').join('');
    }
  }
  return '';
}
