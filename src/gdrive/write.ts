/**
 * The seven things a push does to Drive (MANUAL §7, §8).
 *
 * `from-markdown.ts` answers requests; this module decides how many round
 * trips they take and in what order, which for Docs is exactly two: one
 * `documents.batchUpdate` that clears the body and writes the new one, and —
 * only when the document has footnotes — a second batch that fills them, since
 * a footnote's segment id does not exist until the first batch has made it.
 *
 * Write-back is a full replace in phase 1: the body is deleted and regenerated,
 * so colour, highlight, fonts, sizes and alignment inside it are lost, while
 * the file id, its sharing, its comments and everything Drive knows about it
 * survive (MANUAL §7). A binary is a new revision of the same file, which is
 * the same promise by other means.
 */
import type { Root } from 'mdast';
import {
  type CommentUpdateState,
  DEFAULT_UPLOAD_MIME,
  DOCUMENT_MIME,
  type DocsDocument,
  type DocsWriteReply,
  type DocsWriteRequest,
  type DriveFile,
  FOLDER_MIME,
  type GDriveApi,
} from './api.js';
import { mdastToRequests, type PlannedFootnote } from './from-markdown.js';
import type { PatchPlan } from './patch.js';
import { tabOf } from './tabs.js';

/** What writing one body did, for the push report. */
export interface BodyResult {
  /** What the API cannot create and the push therefore left behind. */
  dropped: string[];
  /** How many batches it took: one, or two when there are footnotes. */
  batches: number;
  /**
   * How many suggestions the response reported, when the write was sent in
   * suggesting mode (MANUAL §7). The real API reports none: the count is
   * `0`, and the report leaves it out.
   */
  suggested?: number;
  /** What the API said about the comments the suggestions are (MANUAL §7). */
  commentUpdateState?: CommentUpdateState;
}

export interface CreatedDoc extends BodyResult {
  id: string;
}

/** The write operations, over an injected API so tests need no network. */
export interface GDriveWriter {
  /**
   * Clears a Doc's body and writes the Markdown in its place. Used by
   * `createDoc` alone now that a modified document is patched (MANUAL §7); a
   * fresh document has nothing to diff against.
   */
  replaceBody(documentId: string, tree: Root): Promise<BodyResult>;
  /**
   * Sends a plan from `patch.ts`: one batch, and one more for its footnotes.
   * With `suggest`, both go in suggesting mode: the body is left as it is and
   * every request becomes a suggestion the client reviews (MANUAL §7).
   */
  patchBody(documentId: string, plan: PatchPlan, options?: PatchOptions): Promise<BodyResult>;
  /** A new Doc under a folder, with its body. Answers the new file's id. */
  createDoc(parentId: string, name: string, tree: Root): Promise<CreatedDoc>;
  /**
   * A new tab of a Doc (MANUAL §6, #37). `parentTabId` is the tab whose
   * directory the new file sits in. Answers the id the API gave the tab, which
   * is the only place it comes from.
   */
  addTab(documentId: string, title: string, parentTabId?: string): Promise<string>;
  /** The body of a tab this push has just made: it is empty, so nothing is cleared. */
  writeTab(documentId: string, tabId: string, tree: Root): Promise<BodyResult>;
  /** A tab's title, which is what a changed `title:` in a tab file is (MANUAL §6). */
  renameTab(documentId: string, tabId: string, title: string): Promise<void>;
  /** A new folder under a folder, for a path whose directory does not exist. */
  createFolder(parentId: string, name: string): Promise<string>;
  /** A new revision of a binary: same id, same sharing, same comments. */
  uploadRevision(fileId: string, bytes: Uint8Array, mimeType?: string): Promise<DriveFile>;
  /** A new binary under a folder. Answers the new file's id. */
  createFile(parentId: string, name: string, bytes: Uint8Array, mimeType?: string): Promise<string>;
  /** The file's name, which is the document's title (MANUAL §6). */
  rename(fileId: string, name: string): Promise<DriveFile>;
  /** A move between folders inside the root. */
  move(fileId: string, toParent: string, fromParent: string): Promise<DriveFile>;
  /** To the trash, never permanently. Recoverable for about 30 days (MANUAL §8). */
  trash(fileId: string): Promise<DriveFile>;
}

/** How a patch is written (MANUAL §7). */
export interface PatchOptions {
  suggest?: boolean;
  /**
   * The tab the patch is addressed to (MANUAL §6, #37). The API's rule is
   * that a request with no `tabId` lands in the *first* tab, so a push names
   * the tab on every location and range it sends, single-tab Docs included.
   */
  tabId?: string;
}

/**
 * Every location and range of a batch, stamped with the tab it belongs to.
 *
 * A location and a range are exactly the objects that carry an index, which is
 * the same test `from-markdown.ts` uses to stamp a footnote's segment id.
 */
function inTab(requests: readonly DocsWriteRequest[], tabId: string): DocsWriteRequest[] {
  const stamp = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stamp);
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, one] of Object.entries(record)) out[key] = stamp(one);
    if ('index' in record || 'startIndex' in record) out.tabId = tabId;
    return out;
  };
  return requests.map((request) => stamp(request) as DocsWriteRequest);
}

export function createGDriveWriter(api: GDriveApi): GDriveWriter {
  /**
   * The body, in one batch, plus a second one for the footnotes.
   *
   * `clear` is the difference between replacing a document and filling a new
   * one: a `deleteContentRange` over everything the body holds, which goes
   * first so that a failure leaves the document untouched, and which is also
   * why every reply is one further along than the plan says.
   */
  async function writeBody(
    documentId: string,
    tree: Root,
    clear: DocsDocument | undefined,
    tabId?: string,
  ): Promise<BodyResult> {
    const plan = mdastToRequests(tree);
    const head: DocsWriteRequest[] = [];
    if (clear !== undefined) {
      const end = endIndexOf(clear);
      // A body that is one empty paragraph has nothing to delete, and the API
      // refuses an empty range.
      if (end > 2)
        head.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
    }
    if (head.length === 0 && plan.requests.length === 0) {
      return { dropped: plan.dropped, batches: 0 };
    }

    const { replies } = await api.batchUpdate(documentId, send([...head, ...plan.requests], tabId));
    if (plan.footnotes.length === 0) return { dropped: plan.dropped, batches: 1 };

    // The segments exist now, and only the document can say how long each one
    // is, which the bodies need: Docs seeds a new footnote with a space.
    const second = footnoteRequests(
      plan.footnotes,
      replies,
      head.length,
      await readTab(documentId, tabId),
    );
    if (second.length === 0) return { dropped: plan.dropped, batches: 1 };

    await api.batchUpdate(documentId, send(second, tabId));
    return { dropped: plan.dropped, batches: 2 };
  }

  /** A batch, addressed to a tab when the caller named one (#37). */
  function send(requests: readonly DocsWriteRequest[], tabId: string | undefined) {
    return tabId === undefined ? [...requests] : inTab(requests, tabId);
  }

  /** The document as the tab it is being written to, for the footnote segments. */
  async function readTab(documentId: string, tabId: string | undefined): Promise<DocsDocument> {
    return tabOf(await api.getDocument(documentId), tabId);
  }

  return {
    async replaceBody(documentId, tree) {
      return writeBody(documentId, tree, await api.getDocument(documentId));
    },

    async patchBody(documentId, plan, options = {}) {
      const suggest = options.suggest === true;
      const tabId = options.tabId;
      // In suggesting mode the count is what the response reports, which on
      // the real API is nothing: the ids only show up on the next read.
      const made = (result: { suggestionIds: string[] }): number => result.suggestionIds.length;
      const suggested = (count: number): Pick<BodyResult, 'suggested'> =>
        suggest ? { suggested: count } : {};
      const state = (result: {
        commentUpdateState?: CommentUpdateState;
      }): Pick<BodyResult, 'commentUpdateState'> =>
        result.commentUpdateState === undefined
          ? {}
          : { commentUpdateState: result.commentUpdateState };

      if (plan.requests.length === 0) return { dropped: plan.dropped, batches: 0, ...suggested(0) };
      const first = await api.batchUpdate(documentId, send(plan.requests, tabId), { suggest });
      const count = made(first);
      if (plan.footnotes.length === 0) {
        return { dropped: plan.dropped, batches: 1, ...suggested(count), ...state(first) };
      }

      // A footnote an inserted block made exists now, and only the document
      // can say how long its segment is (see `footnoteRequests`).
      const second = footnoteRequests(
        plan.footnotes,
        first.replies,
        0,
        await readTab(documentId, tabId),
      );
      if (second.length === 0) {
        return { dropped: plan.dropped, batches: 1, ...suggested(count), ...state(first) };
      }
      const last = await api.batchUpdate(documentId, send(second, tabId), { suggest });
      return {
        dropped: plan.dropped,
        batches: 2,
        ...suggested(count + made(last)),
        ...state(first.commentUpdateState === undefined ? last : first),
      };
    },

    async createDoc(parentId, name, tree) {
      const file = await api.createFile({ name, mimeType: DOCUMENT_MIME, parents: [parentId] });
      // A new document is empty, so there is nothing to delete first.
      return { id: file.id, ...(await writeBody(file.id, tree, undefined)) };
    },

    async addTab(documentId, title, parentTabId) {
      const { replies } = await api.batchUpdate(documentId, [
        {
          addDocumentTab: {
            tabProperties: {
              title,
              ...(parentTabId === undefined ? {} : { parentTabId }),
            },
          },
        },
      ]);
      const made = replies[0]?.addDocumentTab?.tabProperties?.tabId;
      if (made === undefined || made === '') {
        throw new Error(`${documentId}: the API added a tab but named no tab id`);
      }
      return made;
    },

    async writeTab(documentId, tabId, tree) {
      // A tab this push has just made is empty, as a Doc it has just created is.
      return writeBody(documentId, tree, undefined, tabId);
    },

    async renameTab(documentId, tabId, title) {
      await api.batchUpdate(documentId, [
        {
          updateDocumentTabProperties: { tabProperties: { tabId, title }, fields: 'title' },
        },
      ]);
    },

    async createFolder(parentId, name) {
      const file = await api.createFile({ name, mimeType: FOLDER_MIME, parents: [parentId] });
      return file.id;
    },

    async uploadRevision(fileId, bytes, mimeType = DEFAULT_UPLOAD_MIME) {
      return api.uploadRevision(fileId, bytes, mimeType);
    },

    async createFile(parentId, name, bytes, mimeType = DEFAULT_UPLOAD_MIME) {
      const file = await api.uploadFile({ name, parents: [parentId] }, bytes, mimeType);
      return file.id;
    },

    async rename(fileId, name) {
      return api.updateFile(fileId, { name });
    },

    async move(fileId, toParent, fromParent) {
      return api.updateFile(fileId, {}, { addParents: toParent, removeParents: fromParent });
    },

    async trash(fileId) {
      return api.updateFile(fileId, { trashed: true });
    },
  };
}

/** One past the last index of a body, which is what a full delete stops at. */
export function endIndexOf(document: DocsDocument): number {
  return document.body?.content?.at(-1)?.endIndex ?? 2;
}

/**
 * The second batch: each footnote's body, in the segment the first batch made.
 *
 * `createFootnote` seeds the new segment with a space — which is what the
 * fixture's own footnote shows, and what the manual test found coming back as
 * a stray second paragraph — so the body replaces the segment rather than
 * being pushed in front of it. Shared with the round-trip test, which applies
 * the same two batches to a model.
 */
export function footnoteRequests(
  footnotes: readonly PlannedFootnote[],
  replies: readonly DocsWriteReply[],
  offset: number,
  document: DocsDocument,
): DocsWriteRequest[] {
  const out: DocsWriteRequest[] = [];
  for (const footnote of footnotes) {
    const id = replies[footnote.requestIndex + offset]?.createFootnote?.footnoteId;
    if (id === undefined) continue;
    // The segment's own last paragraph keeps its newline, as a body does.
    const end = document.footnotes?.[id]?.content?.at(-1)?.endIndex ?? 1;
    if (end > 1) {
      out.push({
        deleteContentRange: { range: { segmentId: id, startIndex: 0, endIndex: end - 1 } },
      });
    }
    out.push(...footnote.requests(id));
  }
  return out;
}
