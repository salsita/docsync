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
  /** Comment pages by block id; each entry is one page of results. */
  comments?: Record<
    string,
    { results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null }[]
  >;
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
      async create(args) {
        calls.push(`create:${JSON.stringify(args)}`);
        maybeFail();
        return { object: 'page', id: 'new', ...args };
      },
      async update(args) {
        calls.push(`update:${JSON.stringify(args)}`);
        maybeFail();
        return { object: 'page', ...args };
      },
    },
    comments: {
      async list({ block_id, start_cursor }) {
        calls.push(`comments:${block_id}${start_cursor === undefined ? '' : `:${start_cursor}`}`);
        maybeFail();
        return (
          options.comments?.[block_id]?.shift() ?? {
            results: [],
            has_more: false,
            next_cursor: null,
          }
        );
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
      async delete({ block_id }) {
        calls.push(`delete:${block_id}`);
        maybeFail();
        return { object: 'block', id: block_id };
      },
      async update({ block_id, ...body }) {
        calls.push(`update:${block_id}:${JSON.stringify(body)}`);
        maybeFail();
        return { object: 'block', id: block_id };
      },
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
        async append({ block_id, children, after }) {
          calls.push(
            `append:${block_id}:${children.length}${after === undefined ? '' : `:after=${after}`}`,
          );
          maybeFail();
          return { results: children.map((_child, at) => block(`${block_id}-${at}`, 'paragraph')) };
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

  it('pages through the comments on one block', async () => {
    const { client, calls } = fakeClient({
      comments: {
        b: [
          { results: [{ id: 'c1' }], has_more: true, next_cursor: 'p2' },
          { results: [{ id: 'c2' }], has_more: false, next_cursor: null },
        ],
      },
    });

    const found = await createNotionApi(client, noSleep).comments('b');

    expect(found.map((comment) => comment.id)).toEqual(['c1', 'c2']);
    expect(calls).toEqual(['comments:b', 'comments:b:p2']);
  });

  it('answers an empty list for a block nobody commented on', async () => {
    const { client } = fakeClient();
    expect(await createNotionApi(client, noSleep).comments('b')).toEqual([]);
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

  it('lists the direct children of a block without recursing', async () => {
    const { client, calls } = fakeClient({
      children: { root: [[block('a', 'paragraph', true)]], a: [[block('a1', 'paragraph')]] },
    });

    const blocks = await createNotionApi(client, noSleep).children('root');

    expect(blocks.map((one) => one.id)).toEqual(['a']);
    expect(calls).toEqual(['children:root:']);
  });

  it('deletes a block', async () => {
    const { client, calls } = fakeClient({});
    await createNotionApi(client, noSleep).deleteBlock('b1');
    expect(calls).toEqual(['delete:b1']);
  });

  it('appends children and answers the blocks it created', async () => {
    const { client } = fakeClient({});
    const created = await createNotionApi(client, noSleep).append('p', [
      { type: 'paragraph', paragraph: {} },
    ]);
    expect(created.map((one) => one.id)).toEqual(['p-0']);
  });

  it('appends after a block that is already there', async () => {
    const { client, calls } = fakeClient({});
    await createNotionApi(client, noSleep).append(
      'p',
      [{ type: 'paragraph', paragraph: {} }],
      'b7',
    );
    expect(calls).toEqual(['append:p:1:after=b7']);
  });

  it('updates one block with its type-specific body', async () => {
    const { client, calls } = fakeClient({});
    await createNotionApi(client, noSleep).updateBlock('b1', {
      paragraph: { rich_text: [], color: 'red' },
    });
    expect(calls).toEqual(['update:b1:{"paragraph":{"rich_text":[],"color":"red"}}']);
  });

  it('answers no blocks when the append response carries none', async () => {
    const client = fakeClient({}).client;
    client.blocks.children.append = async () => ({});
    expect(await createNotionApi(client, noSleep).append('p', [])).toEqual([]);
  });

  it('creates a page under a parent page, with a body', async () => {
    const { client, calls } = fakeClient({});
    await createNotionApi(client, noSleep).createPage('parent', 'Title', [
      { type: 'divider', divider: {} },
    ]);
    expect(calls[0]).toContain('"parent":{"type":"page_id","page_id":"parent"}');
    expect(calls[0]).toContain('"content":"Title"');
    expect(calls[0]).toContain('"divider"');
  });

  it('creates a page with no body at all', async () => {
    const { client, calls } = fakeClient({});
    await createNotionApi(client, noSleep).createPage('parent', 'Title');
    expect(calls[0]).not.toContain('children');
  });

  it('renames a page, archives one, and does both', async () => {
    const { client, calls } = fakeClient({});
    const api = createNotionApi(client, noSleep);

    await api.updatePage('p', { title: 'New' });
    await api.updatePage('p', { archived: true });
    await api.updatePage('p', { title: 'New', archived: true });

    expect(calls[0]).toContain('"content":"New"');
    expect(calls[0]).not.toContain('archived');
    expect(calls[1]).toContain('"archived":true');
    expect(calls[1]).not.toContain('properties');
    expect(calls[2]).toContain('"archived":true');
  });

  it('retries a 429 on a write as well', async () => {
    const sleep = vi.fn(async () => {});
    const { client, calls } = fakeClient({ failures: [tooManyRequests('1')] });

    await createNotionApi(client, { sleep }).deleteBlock('b1');

    expect(sleep).toHaveBeenCalledWith(1000);
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
    expect(typeof client.blocks.delete).toBe('function');
    expect(typeof client.blocks.children.append).toBe('function');
    expect(typeof client.blocks.update).toBe('function');
    expect(typeof client.pages.create).toBe('function');
    expect(typeof client.pages.update).toBe('function');
    expect(NOTION_VERSION).toBe('2025-09-03');
  });
});
