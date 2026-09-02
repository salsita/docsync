import { describe, expect, it, vi } from 'vitest';
import { createNotionApi, createNotionClient, NOTION_VERSION, type NotionClient } from './api.js';

/** A block as the API hands it back, with only the fields the wrapper reads. */
function block(id: string, type: string, hasChildren = false): Record<string, unknown> {
  return { object: 'block', id, type, has_children: hasChildren, [type]: {} };
}

/** A 429 as the SDK throws it: a status, a code, and headers. */
function tooManyRequests(retryAfter?: string): Error & { status: number } {
  const error = Object.assign(new Error('rate limited'), {
    status: 429,
    code: 'rate_limited',
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
  return error;
}

interface FakeOptions {
  /** Child lists by parent id; each entry is one page of results. */
  children?: Record<string, Array<Record<string, unknown>[]>>;
  pages?: Record<string, Record<string, unknown>>;
  users?: Record<string, Record<string, unknown>>;
  /** Errors to throw before the next successful call, per method. */
  failures?: unknown[];
}

function fakeClient(options: FakeOptions = {}) {
  const calls: string[] = [];
  const failures = [...(options.failures ?? [])];
  const maybeFail = () => {
    const failure = failures.shift();
    if (failure) throw failure;
  };
  const client: NotionClient = {
    pages: {
      async retrieve({ page_id }) {
        calls.push(`page:${page_id}`);
        maybeFail();
        const page = options.pages?.[page_id];
        if (!page) throw new Error(`no page ${page_id}`);
        return page;
      },
    },
    users: {
      async retrieve({ user_id }) {
        calls.push(`user:${user_id}`);
        maybeFail();
        const user = options.users?.[user_id];
        if (!user) throw new Error(`no user ${user_id}`);
        return user;
      },
    },
    blocks: {
      children: {
        async list({ block_id, start_cursor }) {
          calls.push(`children:${block_id}:${start_cursor ?? ''}`);
          maybeFail();
          const pages = options.children?.[block_id] ?? [];
          const index = start_cursor === undefined ? 0 : Number(start_cursor);
          const results = pages[index] ?? [];
          const more = index + 1 < pages.length;
          return {
            results,
            has_more: more,
            next_cursor: more ? String(index + 1) : null,
          };
        },
      },
    },
  };
  return { client, calls };
}

const noSleep = { sleep: async () => {} };

describe('createNotionApi', () => {
  it('follows the cursor across pages of children', async () => {
    const { client, calls } = fakeClient({
      children: { root: [[block('a', 'paragraph')], [block('b', 'paragraph')]] },
    });
    const api = createNotionApi(client, noSleep);

    const blocks = await api.blockTree('root');

    expect(blocks.map((one) => one.id)).toEqual(['a', 'b']);
    expect(calls).toEqual(['children:root:', 'children:root:1']);
  });

  it('recurses into blocks that have children', async () => {
    const { client } = fakeClient({
      children: {
        root: [[block('a', 'bulleted_list_item', true)]],
        a: [[block('a1', 'paragraph')]],
      },
    });

    const [first] = await createNotionApi(client, noSleep).blockTree('root');

    expect(first?.children?.map((one) => one.id)).toEqual(['a1']);
  });

  it('does not recurse into a child page or a child database', async () => {
    const { client, calls } = fakeClient({
      children: {
        root: [[block('page', 'child_page', true), block('db', 'child_database', true)]],
      },
    });

    const blocks = await createNotionApi(client, noSleep).blockTree('root');

    expect(blocks.every((one) => one.children === undefined)).toBe(true);
    expect(calls).toEqual(['children:root:']);
  });

  it('leaves children undefined when the block claims none', async () => {
    const { client } = fakeClient({ children: { root: [[block('a', 'paragraph')]] } });
    const [first] = await createNotionApi(client, noSleep).blockTree('root');
    expect(first?.children).toBeUndefined();
  });

  it('retries a 429 after Retry-After seconds', async () => {
    const sleep = vi.fn(async () => {});
    const { client, calls } = fakeClient({
      children: { root: [[block('a', 'paragraph')]] },
      failures: [tooManyRequests('2')],
    });

    const blocks = await createNotionApi(client, { sleep }).blockTree('root');

    expect(blocks.map((one) => one.id)).toEqual(['a']);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls).toHaveLength(2);
  });

  it('reads Retry-After from a Headers object as well', async () => {
    const sleep = vi.fn(async () => {});
    const failure = Object.assign(new Error('slow down'), {
      status: 429,
      headers: new Headers({ 'Retry-After': '3' }),
    });
    const { client } = fakeClient({ pages: { p: { id: 'p' } }, failures: [failure] });

    await createNotionApi(client, { sleep }).page('p');

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('backs off without Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    const { client } = fakeClient({
      pages: { p: { id: 'p' } },
      failures: [tooManyRequests(), tooManyRequests('bogus')],
    });

    await createNotionApi(client, { sleep }).page('p');

    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it('gives up after three retries and rethrows', async () => {
    const { client, calls } = fakeClient({
      pages: { p: { id: 'p' } },
      failures: [
        tooManyRequests('0'),
        tooManyRequests('0'),
        tooManyRequests('0'),
        tooManyRequests('0'),
      ],
    });

    await expect(createNotionApi(client, noSleep).page('p')).rejects.toThrow('rate limited');
    expect(calls).toHaveLength(4);
  });

  it('does not retry anything but a 429', async () => {
    const { client, calls } = fakeClient({
      pages: { p: { id: 'p' } },
      failures: [Object.assign(new Error('gone'), { status: 404 })],
    });

    await expect(createNotionApi(client, noSleep).page('p')).rejects.toThrow('gone');
    expect(calls).toHaveLength(1);
  });

  it('does not retry a thrown non-object', async () => {
    const { client } = fakeClient({ pages: { p: { id: 'p' } }, failures: ['boom'] });
    await expect(createNotionApi(client, noSleep).page('p')).rejects.toBe('boom');
  });

  it('retrieves a page', async () => {
    const { client } = fakeClient({ pages: { p: { id: 'p', object: 'page' } } });
    expect(await createNotionApi(client, noSleep).page('p')).toEqual({ id: 'p', object: 'page' });
  });

  it('caches users for the run, including a failed lookup', async () => {
    const { client, calls } = fakeClient({ users: { u: { id: 'u', name: 'Ada' } } });
    const api = createNotionApi(client, noSleep);

    expect(await api.user('u')).toEqual({ id: 'u', name: 'Ada' });
    expect(await api.user('u')).toEqual({ id: 'u', name: 'Ada' });
    // A user the token may not read is not worth asking about twice.
    expect(await api.user('gone')).toBeUndefined();
    expect(await api.user('gone')).toBeUndefined();

    expect(calls).toEqual(['user:u', 'user:gone']);
  });

  it('waits for real when no sleep is injected', async () => {
    const { client, calls } = fakeClient({
      pages: { p: { id: 'p' } },
      failures: [tooManyRequests('0')],
    });

    await createNotionApi(client).page('p');

    expect(calls).toHaveLength(2);
  });

  it('never asks about a missing user id', async () => {
    const { client, calls } = fakeClient({});
    expect(await createNotionApi(client, noSleep).user(undefined)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('createNotionClient', () => {
  it('builds a client for the pinned API version', () => {
    const client = createNotionClient('secret_token');
    expect(typeof client.pages.retrieve).toBe('function');
    expect(typeof client.blocks.children.list).toBe('function');
    expect(typeof client.users.retrieve).toBe('function');
    expect(NOTION_VERSION).toBe('2025-09-03');
  });
});
