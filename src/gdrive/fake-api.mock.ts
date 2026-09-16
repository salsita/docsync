/**
 * A Drive that lives in memory, for the push tests.
 *
 * `write.test.ts` pins what goes on the wire; this is for the layer above,
 * where what matters is *which* operations a diff turns into and in what order.
 * Documents are backed by `docs-model.mock.ts`, so a push can be read back as
 * Markdown, and every write is recorded in `calls`.
 */
import type {
  BatchUpdateResult,
  CommentAnchor,
  CommentThread,
  DocsDocument,
  DocsWriteReply,
  DocsWriteRequest,
  DriveComment,
  DriveFile,
  FileMetadata,
  GDriveApi,
  MoveOptions,
  SuggestionThread,
  Tab,
} from './api.js';
import { createDocsModel, type DocsModel, type ViewMode } from './docs-model.mock.js';
import { documentToMarkdown } from './to-markdown.js';

/** One file in the fake Drive. */
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed?: boolean;
  bytes?: Uint8Array;
  /**
   * What Drive reports as the file's last-edit time. Empty unless a test sets
   * one, which is how a fetch is made to see a document move (MANUAL §7).
   */
  modifiedTime?: string;
}

/** One tab of a fake Doc: its own body, its title, and where it is nested. */
export interface FakeTab {
  id: string;
  title: string;
  parentId?: string;
  model: DocsModel;
  /**
   * Where the tab's comments sit, by anchor id, as the preview answers them
   * (MANUAL §6, ticket 40). Empty unless a test seeds one.
   */
  anchors: Record<string, CommentAnchor>;
}

/** One post of a fake discussion: what a reply in Docs carries. */
export interface FakePost {
  author: string;
  content: string;
  createTime: string;
}

export interface FakeDrive extends GDriveApi {
  /** Every file, by id, including the ones a push made. */
  files: Map<string, FakeFile>;
  /** The tabs of one Doc, in order, for a test that asserts on them. */
  tabs(id: string): FakeTab[];
  /** Bytes by URI, for the images a document already holds. */
  hosted: Map<string, Uint8Array>;
  /** Comment threads by file id, for a test of a root with `comments: true`. */
  threads: Map<string, DriveComment[]>;
  /**
   * What the preview's `commentsViewMode` answers, by file id (ticket 40).
   * Empty unless a test seeds it, which is a Doc outside the preview — and a
   * Doc with nothing to say, since the API leaves both fields out for one.
   */
  discussions: Map<string, { comments?: CommentThread[]; suggestions?: SuggestionThread[] }>;
  /** A reply under a suggestion's card, as the preview's `addCommentReply` makes one. */
  replyToSuggestion(documentId: string, suggestionId: string, post: FakePost): void;
  /** The line Docs prints on a suggestion's card, which the API calls `summaryText`. */
  summarise(documentId: string, suggestionId: string, summary: string): void;
  /** The shares that exist right now, as `<fileId>:<permissionId>`. */
  permissions: Set<string>;
  /** Every operation, in order: `createFile Notes`, `trash doc1`, … */
  calls: string[];
  /**
   * One document's body as Markdown, for asserting what a push wrote. A Doc
   * with several tabs is asked one tab at a time (ticket 37); with none named,
   * it is the first tab, which is the whole Doc when there is only one.
   */
  markdown(id: string, tabId?: string): string;
}

const DOCUMENT = 'application/vnd.google-apps.document';

/** A Drive holding the files given, with an empty document behind each Doc. */
export function createFakeDrive(seed: readonly Partial<FakeFile>[] = []): FakeDrive {
  const files = new Map<string, FakeFile>();
  // A Doc is its tabs (MANUAL §6, ticket 37): one of them for a Doc as most
  // Docs are, and the model of a body behind each.
  const documents = new Map<string, FakeTab[]>();
  let nextTab = 0;
  const hosted = new Map<string, Uint8Array>();
  const threads = new Map<string, DriveComment[]>();
  const discussions = new Map<
    string,
    { comments?: CommentThread[]; suggestions?: SuggestionThread[] }
  >();
  const permissions = new Set<string>();
  const calls: string[] = [];
  let nextPermission = 0;
  let made = 0;

  for (const one of seed) {
    const file: FakeFile = {
      id: one.id ?? `file${files.size}`,
      name: one.name ?? 'Untitled',
      mimeType: one.mimeType ?? DOCUMENT,
      parents: one.parents ?? [],
      ...(one.bytes === undefined ? {} : { bytes: one.bytes }),
      ...(one.modifiedTime === undefined ? {} : { modifiedTime: one.modifiedTime }),
    };
    files.set(file.id, file);
    if (file.mimeType === DOCUMENT) documents.set(file.id, [firstTab(file.id, file.name)]);
  }

  /** The tab every Doc has: `t.0`, which is what a one-tab Doc's id is. */
  function firstTab(id: string, name: string): FakeTab {
    return { id: 't.0', title: name, model: createDocsModel(id, name), anchors: {} };
  }

  /** The discussion of one suggestion, made when a test first says something about it. */
  function suggestionOf(documentId: string, suggestionId: string): SuggestionThread {
    const held = discussions.get(documentId) ?? {};
    const found = (held.suggestions ?? []).find((one) => one.suggestionId === suggestionId);
    if (found !== undefined) return found;
    const made: SuggestionThread = { suggestionId, status: 'OPEN', replies: [] };
    discussions.set(documentId, { ...held, suggestions: [...(held.suggestions ?? []), made] });
    return made;
  }

  /** The tabs of a Doc, or a loud failure: nothing else is a Doc. */
  function tabsOf(id: string): FakeTab[] {
    const found = documents.get(id);
    if (found === undefined) throw new Error(`no document ${id}`);
    return found;
  }

  /** One tab, by the id a request named, or the first one when it named none. */
  function tabFor(id: string, tabId: string | undefined): FakeTab {
    const tabs = tabsOf(id);
    // The API's own rule: no `tabId` means the first tab (MANUAL §7).
    const found = tabId === undefined ? tabs[0] : tabs.find((tab) => tab.id === tabId);
    if (found === undefined) throw new Error(`no tab ${tabId ?? '(first)'} in ${id}`);
    return found;
  }

  /** The tab a request is addressed to: any `tabId` inside it, at any depth. */
  function tabIdOf(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      for (const one of value) {
        const found = tabIdOf(one);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.tabId === 'string') return record.tabId;
    for (const one of Object.values(record)) {
      const found = tabIdOf(one);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The reply's tab tree: a parent, then the tabs nested in it. */
  function tabTree(id: string, mode: ViewMode, anchors: boolean, parentId?: string): Tab[] {
    return tabsOf(id)
      .filter((tab) => tab.parentId === parentId)
      .map((tab, index): Tab => {
        const document = tab.model.document(mode);
        const placed = anchors && Object.keys(tab.anchors).length > 0;
        return {
          tabProperties: {
            tabId: tab.id,
            title: tab.title,
            index,
            nestingLevel: parentId === undefined ? 0 : 1,
            ...(parentId === undefined ? {} : { parentTabId: parentId }),
          },
          documentTab: {
            ...(document.body === undefined ? {} : { body: document.body }),
            ...(document.lists === undefined ? {} : { lists: document.lists }),
            ...(document.footnotes === undefined ? {} : { footnotes: document.footnotes }),
            ...(document.inlineObjects === undefined
              ? {}
              : { inlineObjects: document.inlineObjects }),
            // Only under `COMMENTS_VIEW_MODE_INCLUDED`, as the API does it.
            ...(placed ? { commentAnchors: tab.anchors } : {}),
          },
          childTabs: tabTree(id, mode, anchors, tab.id),
        };
      });
  }

  function metadata(file: FakeFile): DriveFile {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime ?? '',
    };
  }

  function get(id: string): FakeFile {
    const found = files.get(id);
    if (found === undefined) throw new Error(`no file ${id}`);
    return found;
  }

  function create(data: FileMetadata, bytes?: Uint8Array): DriveFile {
    made += 1;
    const file: FakeFile = {
      id: `new${made}`,
      name: data.name ?? 'Untitled',
      mimeType: data.mimeType ?? 'application/octet-stream',
      parents: data.parents ?? [],
      ...(bytes === undefined ? {} : { bytes }),
    };
    files.set(file.id, file);
    if (file.mimeType === DOCUMENT) documents.set(file.id, [firstTab(file.id, file.name)]);
    calls.push(`create ${file.name}`);
    return metadata(file);
  }

  return {
    files,
    calls,
    hosted,
    threads,
    discussions,
    permissions,

    replyToSuggestion(documentId, suggestionId, post) {
      const thread = suggestionOf(documentId, suggestionId);
      thread.replies = [
        ...(thread.replies ?? []),
        {
          postId: `post${(thread.replies ?? []).length + 1}`,
          content: post.content,
          contentHtml: `<p>${post.content}</p>`,
          author: { displayName: post.author },
          createTime: post.createTime,
          updateTime: post.createTime,
          suggestionAction: 'NO_SUGGESTION_ACTION_CHANGE',
        },
      ];
      calls.push(`addCommentReply ${documentId} ${suggestionId}`);
    },

    summarise(documentId, suggestionId, summary) {
      const thread = suggestionOf(documentId, suggestionId);
      thread.summaryText = summary;
      thread.summaryHtml = `<p>${summary}</p>`;
    },

    async createPermission(id, permission) {
      nextPermission += 1;
      const permissionId = `perm${nextPermission}`;
      permissions.add(`${id}:${permissionId}`);
      calls.push(`share ${id} ${permission.type}/${permission.role}`);
      return permissionId;
    },

    async deletePermission(id, permissionId) {
      permissions.delete(`${id}:${permissionId}`);
      calls.push(`unshare ${id}`);
    },

    async downloadUri(uri) {
      calls.push(`downloadUri ${uri}`);
      const bytes = hosted.get(uri);
      if (bytes === undefined) throw new Error(`nothing hosted at ${uri}`);
      return { bytes, contentType: 'image/png' };
    },

    tabs(id) {
      return tabsOf(id);
    },

    markdown(id, tabId) {
      // The body as everyone but a reviewer sees it: what a suggestion proposes
      // is not in it (MANUAL §6).
      return documentToMarkdown(tabFor(id, tabId).model.document('preview'));
    },

    async listFolder(id) {
      return [...files.values()]
        .filter((file) => file.parents.includes(id) && file.trashed !== true)
        .map(metadata);
    },

    async getFile(id) {
      calls.push(`getFile ${id}`);
      return metadata(get(id));
    },

    async getDocument(id, mode = 'preview', options = {}): Promise<DocsDocument> {
      // As the real API answers with `includeTabsContent=true` (ticket 37):
      // the contents are under `tabs` and there is no top-level body at all.
      // Inline is the view a push and a comment sidecar read: the pending
      // suggestions are on the runs they touch (MANUAL §6, §7).
      const asked = options.comments === true;
      // The discussions and the anchors come only when asked for, and a Doc
      // with none leaves the fields out, exactly as the API does (ticket 40).
      const held = asked ? (discussions.get(id) ?? {}) : {};
      return {
        documentId: id,
        title: get(id).name,
        tabs: tabTree(id, mode, asked),
        ...(held.comments === undefined ? {} : { comments: held.comments }),
        ...(held.suggestions === undefined ? {} : { suggestions: held.suggestions }),
      };
    },

    async comments(id) {
      // A push never reads one, so this is empty unless a test seeded it.
      return threads.get(id) ?? [];
    },

    async download(id) {
      return get(id).bytes ?? new Uint8Array();
    },

    async export() {
      throw new Error('the fake Drive does not export');
    },

    async batchUpdate(documentId, requests, options = {}): Promise<BatchUpdateResult> {
      const tabs = tabsOf(documentId);
      const suggesting = options.suggest === true;
      calls.push(`batchUpdate ${documentId}${suggesting ? ' suggest' : ''}`);

      const replies: DocsWriteReply[] = [];
      for (const request of requests as DocsWriteRequest[]) {
        const [name] = Object.keys(request);
        // The three tab requests are the document's own, not a body's.
        if (name === 'addDocumentTab') {
          const properties = (request.addDocumentTab as { tabProperties?: Record<string, string> })
            ?.tabProperties;
          nextTab += 1;
          const id = `t.new${nextTab}`;
          const title = properties?.title ?? 'Untitled';
          tabs.push({
            id,
            title,
            ...(properties?.parentTabId === undefined ? {} : { parentId: properties.parentTabId }),
            model: createDocsModel(documentId, title),
            anchors: {},
          });
          calls.push(`addTab ${documentId} ${title}`);
          replies.push({ addDocumentTab: { tabProperties: { tabId: id, title } } });
          continue;
        }
        if (name === 'updateDocumentTabProperties') {
          const properties = (
            request.updateDocumentTabProperties as { tabProperties?: Record<string, string> }
          )?.tabProperties;
          const tab = tabFor(documentId, properties?.tabId);
          tab.title = properties?.title ?? tab.title;
          calls.push(`renameTab ${documentId} ${tab.id} ${tab.title}`);
          replies.push({});
          continue;
        }
        if (name === 'deleteTab') {
          const tabId = (request.deleteTab as { tabId?: string })?.tabId;
          const at = tabs.findIndex((tab) => tab.id === tabId);
          if (at >= 0) tabs.splice(at, 1);
          calls.push(`deleteTab ${documentId} ${tabId ?? ''}`);
          replies.push({});
          continue;
        }
        // Everything else is addressed to one tab's body, by the `tabId` the
        // request carries — and to the first tab when it carries none.
        replies.push(
          ...tabFor(documentId, tabIdOf(request)).model.apply([request], { suggest: suggesting }),
        );
      }
      const ids = replies.map((reply) => reply.suggestionId ?? '').filter((id) => id !== '');
      return { replies, suggestionIds: [...new Set(ids)] };
    },

    async createFile(data) {
      return create(data);
    },

    async updateFile(id, data, move: MoveOptions = {}) {
      const file = get(id);
      if (data.name !== undefined) {
        file.name = data.name;
        calls.push(`rename ${id} ${data.name}`);
      }
      if (data.trashed === true) {
        file.trashed = true;
        calls.push(`trash ${id}`);
      }
      if (move.addParents !== undefined) {
        file.parents = [
          ...file.parents.filter((parent) => parent !== move.removeParents),
          move.addParents,
        ];
        calls.push(`move ${id} ${move.removeParents ?? ''}->${move.addParents}`);
      }
      return metadata(file);
    },

    async uploadRevision(id, bytes, mimeType) {
      const file = get(id);
      file.bytes = bytes;
      calls.push(`upload ${id} ${mimeType ?? ''}`);
      return metadata(file);
    },

    async uploadFile(data, bytes, mimeType) {
      return create({ ...data, mimeType: mimeType ?? data.mimeType }, bytes);
    },

    async copyFile(id, data) {
      const source = get(id);
      return create({ ...data, mimeType: source.mimeType });
    },
  };
}
