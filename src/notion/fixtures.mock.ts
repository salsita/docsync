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
import type { NotionApi, NotionBlock, NotionComment, RawObject } from './api.js';

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

/**
 * One page's recorded comments: the page's own block id, then every block of
 * it, each mapped to what `GET /v1/comments` answered for it. A block with no
 * comment is recorded with an empty list, so a lookup that misses is a test
 * walking off the fixture tree.
 */
export function fixtureComments(pageId: string): Record<string, NotionComment[]> {
  return load<Record<string, NotionComment[]>>(`comments-${pageId}`);
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

/**
 * A `NotionApi` backed by the recorded files, for `walk.ts` and `index.ts`.
 * Every id it is asked about must have been recorded, which is the point: a
 * test that walks off the fixture tree fails loudly instead of hitting Notion.
 */
export function fixtureApi(): NotionApi {
  const users = fixtureUsers();
  // Every page's recorded comment map, flattened: one lookup by block id, which
  // is what the real API takes.
  const comments = new Map<string, NotionComment[]>();
  for (const pageId of PAGE_IDS) {
    for (const [blockId, on] of Object.entries(fixtureComments(pageId))) {
      comments.set(bare(blockId), on);
    }
  }
  return {
    async comments(blockId) {
      const found = comments.get(bare(blockId));
      if (found === undefined) throw new Error(`no recorded comments for ${blockId}`);
      return found;
    },
    async page(id) {
      return fixturePage(bare(id));
    },
    async blockTree(id) {
      return fixtureBlocks(bare(id));
    },
    async user(id) {
      return id === undefined ? undefined : users[id];
    },
    async children(id) {
      return fixtureBlocks(bare(id));
    },
    ...readOnly(),
  };
}

/** A fixture-backed API that counts what a fetch would put on the wire. */
export interface CountedApi {
  api: NotionApi;
  /** One entry per request, as `method:id`, in order. */
  requests: string[];
  /** The user lookups, which the real API makes once per id and caches. */
  users: string[];
}

/**
 * The fixture API with every read counted, so a test can pin what one fetch
 * costs (MANUAL §7: the warning is about exactly this number). `requests` is
 * the page and block traffic, which is what the warning is about; a user
 * lookup is counted apart, since the real API makes it once per id and caches
 * it for the rest of the run however many pages that user edited.
 */
export function countingApi(backing: NotionApi = fixtureApi()): CountedApi {
  const requests: string[] = [];
  const users: string[] = [];
  const seen = new Set<string>();
  const count = <T>(name: string, id: string, value: Promise<T>): Promise<T> => {
    requests.push(`${name}:${id}`);
    return value;
  };
  return {
    requests,
    users,
    api: {
      ...backing,
      page: (id) => count('page', id, backing.page(id)),
      blockTree: (id) => count('blockTree', id, backing.blockTree(id)),
      children: (id) => count('children', id, backing.children(id)),
      comments: (id) => count('comments', id, backing.comments(id)),
      async user(id) {
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          users.push(id);
        }
        return backing.user(id);
      },
    },
  };
}

/** The write half, which a fixture-backed API has no business performing. */
function readOnly(): Pick<
  NotionApi,
  'deleteBlock' | 'append' | 'createPage' | 'updatePage' | 'updateBlock'
> {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`the fixture API is read-only: ${name}`);
  };
  return {
    deleteBlock: refuse('deleteBlock'),
    updateBlock: refuse('updateBlock'),
    append: refuse('append'),
    createPage: refuse('createPage'),
    updatePage: refuse('updatePage'),
  };
}

function bare(id: string): string {
  return id.replaceAll('-', '').toLowerCase();
}
