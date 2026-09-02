/**
 * An in-memory Notion, for the write and push tests.
 *
 * It holds pages and block trees, applies appends and deletes the way the real
 * API does — new blocks get ids, nested children are created with their
 * parent — and records every call, so a test can assert on the *requests* as
 * well as the result. Nothing here opens a socket.
 */
import type { NotionApi, NotionBlock, RawObject } from './api.js';

export interface FakePage {
  id: string;
  title: string;
  parentId?: string;
  archived?: boolean;
  blocks: NotionBlock[];
}

export interface FakeApi extends NotionApi {
  /** Every call, as `method:argument`, in order. */
  calls: string[];
  /** The children each append was asked to create, as sent. */
  appends: RawObject[][];
  pages: Map<string, FakePage>;
  /** The block tree of a page, for a test that wants to look at the result. */
  bodyOf(pageId: string): NotionBlock[];
}

export interface FakeApiOptions {
  pages?: FakePage[];
}

/** A fake whose ids are predictable: `b1`, `b2`, … and `page1`, `page2`, … */
export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const calls: string[] = [];
  const appends: RawObject[][] = [];
  const pages = new Map<string, FakePage>();
  for (const page of options.pages ?? []) pages.set(page.id, { ...page });

  let nextBlock = 0;
  let nextPage = 0;

  /** The block with this id, and the list it lives in. */
  function find(id: string): { list: NotionBlock[]; index: number } | undefined {
    const search = (list: NotionBlock[]): { list: NotionBlock[]; index: number } | undefined => {
      for (const [index, block] of list.entries()) {
        if (block.id === id) return { list, index };
        const found = block.children === undefined ? undefined : search(block.children);
        if (found) return found;
      }
      return undefined;
    };
    for (const page of pages.values()) {
      const found = search(page.blocks);
      if (found) return found;
    }
    return undefined;
  }

  /** The list of children `id` names, whether it is a page or a block. */
  function listOf(id: string): NotionBlock[] | undefined {
    const page = pages.get(id);
    if (page) return page.blocks;
    const found = find(id);
    if (!found) return undefined;
    const block = found.list[found.index] as NotionBlock;
    block.children ??= [];
    return block.children;
  }

  /** Turns one request payload into stored blocks, children and all. */
  function create(payload: RawObject): NotionBlock {
    nextBlock += 1;
    const type = String(payload.type);
    const sent = { ...((payload[type] as RawObject | undefined) ?? {}) };
    const nested = Array.isArray(sent.children) ? (sent.children as RawObject[]) : [];
    delete sent.children;

    const block: NotionBlock = {
      object: 'block',
      id: `b${nextBlock}`,
      type,
      has_children: nested.length > 0,
      [type]: sent,
    };
    if (nested.length > 0) block.children = nested.map(create);
    return block;
  }

  return {
    calls,
    appends,
    pages,
    bodyOf(pageId) {
      return pages.get(pageId)?.blocks ?? [];
    },

    async page(id) {
      calls.push(`page:${id}`);
      const page = pages.get(id);
      if (!page) throw new Error(`no page ${id}`);
      return { object: 'page', id, properties: { title: { type: 'title', title: [] } } };
    },

    async blockTree(id) {
      calls.push(`blockTree:${id}`);
      return listOf(id) ?? [];
    },

    async user() {
      return undefined;
    },

    async children(id) {
      calls.push(`children:${id}`);
      return (listOf(id) ?? []).map((block) => ({ ...block, children: undefined }));
    },

    async deleteBlock(id) {
      calls.push(`delete:${id}`);
      const found = find(id);
      if (found) found.list.splice(found.index, 1);
    },

    async append(id, children) {
      calls.push(`append:${id}:${children.length}`);
      appends.push([...children] as RawObject[]);
      const list = listOf(id);
      if (!list) throw new Error(`no block ${id}`);
      const created = children.map((child) => create(child as RawObject));
      list.push(...created);
      // The API answers only the blocks it made at the top of the request.
      return created.map((block) => ({ ...block, children: undefined }));
    },

    async createPage(parentId, title, children) {
      nextPage += 1;
      const id = `page${nextPage}`;
      calls.push(`createPage:${parentId}:${title}:${children?.length ?? 0}`);
      pages.set(id, {
        id,
        title,
        parentId,
        blocks: (children ?? []).map((child) => create(child as RawObject)),
      });
      // A new page shows up in its parent as a `child_page` block.
      pages.get(parentId)?.blocks.push({
        object: 'block',
        id: `b-page-${id}`,
        type: 'child_page',
        has_children: true,
        child_page: { title },
      });
      return { object: 'page', id };
    },

    async updatePage(id, patch) {
      calls.push(`updatePage:${id}:${JSON.stringify(patch)}`);
      const page = pages.get(id);
      if (!page) throw new Error(`no page ${id}`);
      if (patch.title !== undefined) page.title = patch.title;
      if (patch.archived !== undefined) page.archived = patch.archived;
      return { object: 'page', id, archived: page.archived === true };
    },
  };
}
