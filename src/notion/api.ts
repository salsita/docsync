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
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>;
    create(args: {
      parent: RawObject;
      properties: RawObject;
      children?: RawObject[];
    }): Promise<unknown>;
    update(args: { page_id: string; properties?: RawObject; archived?: boolean }): Promise<unknown>;
  };
  users: { retrieve(args: { user_id: string }): Promise<unknown> };
  blocks: {
    delete(args: { block_id: string }): Promise<unknown>;
    /**
     * The type-specific body of one block, replaced. The API will not change a
     * block's *type*, which is why a type change is a delete and an insert
     * (MANUAL §7).
     */
    update(args: { block_id: string } & RawObject): Promise<unknown>;
    children: {
      list(args: { block_id: string; start_cursor?: string; page_size?: number }): Promise<unknown>;
      /** `after` is the id of the block the new ones go behind. */
      append(args: { block_id: string; children: RawObject[]; after?: string }): Promise<unknown>;
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
  /** The direct children of a block, paginated, without recursing. */
  children(id: string): Promise<NotionBlock[]>;
  /** Archives one block. Deleting a `child_page` block archives the page. */
  deleteBlock(id: string): Promise<void>;
  /**
   * Appends blocks under `id`; answers the blocks it created, with their ids.
   * `after` puts them directly behind that child instead of at the end, which
   * is how a diff-based push inserts without rewriting the neighbours.
   */
  append(id: string, children: readonly RawObject[], after?: string): Promise<NotionBlock[]>;
  /** Replaces one block's type-specific body. It cannot change the type. */
  updateBlock(id: string, body: RawObject): Promise<RawObject>;
  /** Creates a page under `parentId`, optionally with a body. */
  createPage(parentId: string, title: string, children?: readonly RawObject[]): Promise<RawObject>;
  /** Renames a page, archives it, or both. */
  updatePage(id: string, patch: { title?: string; archived?: boolean }): Promise<RawObject>;
}

export interface NotionApiOptions {
  /** Injected so the retry test does not wait. Default: real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** A client for the real API, with the version pinned and SDK retries off. */
export function createNotionClient(accessToken: string): NotionClient {
  // `retry: false` because the retry policy is this module's, and tested here.
  // The cast is deliberate: `NotionClient` above is the contract this adapter
  // is written against, spelled in the raw JSON the fixtures record, and the
  // SDK's own generated parameter unions are both narrower and noisier.
  const client = new Client({ auth: accessToken, notionVersion: NOTION_VERSION, retry: false });
  return client as unknown as NotionClient;
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

  /** The `title` property of a page, in the one shape `pages.create` takes. */
  function titleProperty(title: string): RawObject {
    return { title: { title: [{ type: 'text', text: { content: title } }] } };
  }

  return {
    async page(id) {
      return (await call(() => client.pages.retrieve({ page_id: id }))) as RawObject;
    },
    blockTree,
    async children(id) {
      return (await listChildren(id)) as NotionBlock[];
    },
    async deleteBlock(id) {
      await call(() => client.blocks.delete({ block_id: id }));
    },
    async append(id, children, after) {
      const response = (await call(() =>
        client.blocks.children.append({
          block_id: id,
          children: [...children],
          ...(after === undefined ? {} : { after }),
        }),
      )) as { results?: RawObject[] };
      return (response.results ?? []) as NotionBlock[];
    },
    async updateBlock(id, body) {
      return (await call(() => client.blocks.update({ block_id: id, ...body }))) as RawObject;
    },
    async createPage(parentId, title, children) {
      return (await call(() =>
        client.pages.create({
          parent: { type: 'page_id', page_id: parentId },
          properties: titleProperty(title),
          ...(children === undefined ? {} : { children: [...children] }),
        }),
      )) as RawObject;
    },
    async updatePage(id, patch) {
      return (await call(() =>
        client.pages.update({
          page_id: id,
          ...(patch.title === undefined ? {} : { properties: titleProperty(patch.title) }),
          ...(patch.archived === undefined ? {} : { archived: patch.archived }),
        }),
      )) as RawObject;
    },
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
