/**
 * The only part of the Notion adapter that talks to Notion.
 *
 * It is deliberately thin: pagination, recursion into child blocks, a per-run
 * user cache and the rate-limit retry, over an injectable client. Everything
 * above it (`walk.ts`, `to-markdown.ts`) sees plain recorded JSON, which is why
 * those modules are tested entirely on the fixtures in `__fixtures__/` and
 * never open a socket.
 */
import { Client } from '@notionhq/client';

/**
 * The Notion API version this adapter is written against, pinned rather than
 * inherited from the SDK: a new default in a patch release must not change
 * what our documents look like. It is also the SDK's own default at the time
 * of writing, so its response types match what we ask for.
 */
export const NOTION_VERSION = '2025-09-03';

/** How many times a 429 is retried before the error reaches the caller. */
const MAX_RETRIES = 3;

/** Backoff used when Notion does not say how long to wait. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** One object as the API returned it. Recorded verbatim as a fixture. */
export type RawObject = Record<string, unknown>;

/** A block, with the children we fetched for it attached. */
export interface NotionBlock extends RawObject {
  id: string;
  type: string;
  /** Absent when the block has none; never an empty array. */
  children?: NotionBlock[];
}

/** One page of `blocks.children.list`. */
export interface ChildrenPage {
  results: RawObject[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * The slice of the SDK this adapter uses. Narrow on purpose: a test passes a
 * plain object, and the real `Client` satisfies it structurally.
 */
export interface NotionClient {
  pages: { retrieve(args: { page_id: string }): Promise<unknown> };
  users: { retrieve(args: { user_id: string }): Promise<unknown> };
  blocks: {
    children: {
      list(args: { block_id: string; start_cursor?: string; page_size?: number }): Promise<unknown>;
    };
  };
}

/** What `createNotionApi` hands out. */
export interface NotionApi {
  /** The page object. */
  page(id: string): Promise<RawObject>;
  /** Every block under `id`, recursively, in order. */
  blockTree(id: string): Promise<NotionBlock[]>;
  /** A user, cached for the run. `undefined` when the token cannot read them. */
  user(id: string | undefined): Promise<RawObject | undefined>;
}

export interface NotionApiOptions {
  /** Injected so the retry test does not wait. Default: real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** A client for the real API, with the version pinned and SDK retries off. */
export function createNotionClient(accessToken: string): NotionClient {
  // `retry: false` because the retry policy is this module's, and tested here.
  return new Client({ auth: accessToken, notionVersion: NOTION_VERSION, retry: false });
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Child pages and databases are documents of their own, not body content. */
const OPAQUE = new Set(['child_page', 'child_database']);

export function createNotionApi(client: NotionClient, options: NotionApiOptions = {}): NotionApi {
  const sleep = options.sleep ?? realSleep;
  const users = new Map<string, RawObject | undefined>();

  /** Runs one call, retrying a 429 for as long as the policy allows. */
  async function call<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        if (attempt >= MAX_RETRIES || !isRateLimited(error)) throw error;
        await sleep(retryAfterMs(error) ?? RETRY_DELAYS_MS[attempt] ?? 4000);
      }
    }
  }

  async function listChildren(id: string): Promise<RawObject[]> {
    const results: RawObject[] = [];
    let cursor: string | undefined;
    do {
      const page = (await call(() =>
        client.blocks.children.list({ block_id: id, start_cursor: cursor, page_size: 100 }),
      )) as ChildrenPage;
      results.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
    return results;
  }

  async function blockTree(id: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    for (const raw of await listChildren(id)) {
      const block = raw as NotionBlock;
      if (block.has_children === true && !OPAQUE.has(block.type)) {
        block.children = await blockTree(block.id);
      }
      blocks.push(block);
    }
    return blocks;
  }

  return {
    async page(id) {
      return (await call(() => client.pages.retrieve({ page_id: id }))) as RawObject;
    },
    blockTree,
    async user(id) {
      if (id === undefined) return undefined;
      if (users.has(id)) return users.get(id);
      let user: RawObject | undefined;
      try {
        user = (await call(() => client.users.retrieve({ user_id: id }))) as RawObject;
      } catch {
        // A person the integration may not see is shown by id instead; that is
        // not a reason to fail a fetch.
        user = undefined;
      }
      users.set(id, user);
      return user;
    },
  };
}

/** Whether an error is Notion saying "too many requests". */
function isRateLimited(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: number }).status === 429
  );
}

/** `Retry-After` in milliseconds, from either a `Headers` or a plain object. */
function retryAfterMs(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown }).headers;
  let value: string | undefined;
  if (headers instanceof Headers) value = headers.get('retry-after') ?? undefined;
  else if (typeof headers === 'object' && headers !== null) {
    const found = (headers as Record<string, unknown>)['retry-after'];
    if (typeof found === 'string') value = found;
  }
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
