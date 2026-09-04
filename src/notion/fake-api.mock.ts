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
  /** The bytes of every file upload, by the id the fake handed out. */
  uploads: Map<string, { name: string; contentType: string; bytes: Uint8Array }>;
  /** What a hosted URL serves, so a fetch after a push can read it back. */
  hosted: Map<string, Uint8Array>;
  /** The block tree of a page, for a test that wants to look at the result. */
  bodyOf(pageId: string): NotionBlock[];
}

export interface FakeApiOptions {
  pages?: FakePage[];
  /** Bytes by URL, for the blocks a fixture page already hosts. */
  hosted?: Record<string, Uint8Array>;
}

/** A fake whose ids are predictable: `b1`, `b2`, … and `page1`, `page2`, … */
export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const calls: string[] = [];
  const appends: RawObject[][] = [];
  const pages = new Map<string, FakePage>();
  for (const page of options.pages ?? []) pages.set(page.id, { ...page });
  const uploads = new Map<string, { name: string; contentType: string; bytes: Uint8Array }>();
  const hosted = new Map<string, Uint8Array>(Object.entries(options.hosted ?? {}));

  let nextBlock = 0;
  let nextPage = 0;
  let nextUpload = 0;

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

  /**
   * The fields Notion computes for a rich-text run and a request may not carry
   * (`write.ts` strips them), filled in the way Notion fills them: a run's
   * `plain_text` is its content, and its `href` is its link. A mention keeps
   * whatever it was sent, since only Notion knows what a mention is called.
   */
  function computed(value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((raw) => {
      const run = { ...(raw as RawObject) };
      const text = run.text as { content?: string; link?: { url: string } | null } | undefined;
      const equation = run.equation as { expression?: string } | undefined;
      const content = text?.content ?? equation?.expression;
      if (typeof content === 'string') run.plain_text = content;
      run.href = text?.link?.url ?? run.href ?? null;
      return run;
    });
  }

  /** One block body with the computed fields of every run it holds filled in. */
  function withComputed(body: RawObject): RawObject {
    const out = { ...body };
    if ('rich_text' in out) out.rich_text = computed(out.rich_text);
    if ('caption' in out) out.caption = computed(out.caption);
    if (Array.isArray(out.cells))
      out.cells = (out.cells as unknown[]).map((cell) => computed(cell));
    return out;
  }

  /**
   * A block body that points at a file upload, as Notion stores it once the
   * upload has landed: a hosted file with a URL of its own (MANUAL §12 phase
   * 2). The bytes are registered under that URL, so a fetch reads them back.
   */
  function hostFileUpload(body: RawObject): RawObject {
    const upload = body.file_upload as { id?: string } | undefined;
    if (upload?.id === undefined) return body;
    const uploaded = uploads.get(upload.id);
    const url = `https://fake-files/${upload.id}`;
    if (uploaded !== undefined) hosted.set(url, uploaded.bytes);
    const out: RawObject = { ...body, type: 'file', file: { url, expiry_time: '' } };
    delete out.file_upload;
    if (out.name === undefined && uploaded !== undefined) out.name = uploaded.name;
    return out;
  }

  /** Turns one request payload into stored blocks, children and all. */
  function create(payload: RawObject): NotionBlock {
    nextBlock += 1;
    const type = String(payload.type);
    const sent = hostFileUpload(
      withComputed({ ...((payload[type] as RawObject | undefined) ?? {}) }),
    );
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
    uploads,
    hosted,

    async block(id) {
      calls.push(`block:${id}`);
      const found = find(id);
      const block = found === undefined ? undefined : found.list[found.index];
      if (block === undefined) throw new Error(`no block ${id}`);
      return block;
    },

    async download(url) {
      calls.push(`download:${url}`);
      const bytes = hosted.get(url);
      if (bytes === undefined) throw new Error(`nothing hosted at ${url}`);
      return bytes;
    },

    async upload(name, bytes, contentType) {
      nextUpload += 1;
      const id = `fu${nextUpload}`;
      calls.push(`upload:${id}:${name}:${bytes.length}:${contentType}`);
      uploads.set(id, { name, contentType, bytes });
      return id;
    },

    bodyOf(pageId) {
      return pages.get(pageId)?.blocks ?? [];
    },

    async page(id) {
      calls.push(`page:${id}`);
      const page = pages.get(id);
      if (!page) throw new Error(`no page ${id}`);
      return {
        object: 'page',
        id,
        properties: {
          title: { type: 'title', title: [{ plain_text: page.title }] },
        },
      };
    },

    async blockTree(id) {
      calls.push(`blockTree:${id}`);
      return listOf(id) ?? [];
    },

    async user() {
      return undefined;
    },

    async comments(blockId) {
      calls.push(`comments:${blockId}`);
      return [];
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

    async append(id, children, after) {
      calls.push(`append:${id}:${children.length}${after === undefined ? '' : `:after=${after}`}`);
      appends.push([...children] as RawObject[]);
      const list = listOf(id);
      if (!list) throw new Error(`no block ${id}`);
      const created = children.map((child) => create(child as RawObject));
      // `after` puts the new blocks directly behind that child, as the API does;
      // without it they go at the end.
      const at = after === undefined ? -1 : list.findIndex((block) => block.id === after);
      if (at < 0) list.push(...created);
      else list.splice(at + 1, 0, ...created);
      // The API answers only the blocks it made at the top of the request.
      return created.map((block) => ({ ...block, children: undefined }));
    },

    async updateBlock(id, body) {
      calls.push(`update:${id}:${JSON.stringify(body)}`);
      const found = find(id);
      if (!found) throw new Error(`no block ${id}`);
      const block = found.list[found.index] as NotionBlock;
      // The API replaces the type-specific body and cannot change the type.
      const sent = hostFileUpload(withComputed((body[block.type] ?? {}) as RawObject));
      block[block.type] = { ...((block[block.type] ?? {}) as RawObject), ...sent };
      // A block that now points at an upload no longer points at what it did.
      if (sent.type === 'file') delete (block[block.type] as RawObject).external;
      return { object: 'block', id };
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
