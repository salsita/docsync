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
  DEFAULT_UPLOAD_MIME,
  DOCUMENT_MIME,
  type DocsDocument,
  type DocsWriteRequest,
  type DriveFile,
  FOLDER_MIME,
  type GDriveApi,
} from './api.js';
import { mdastToRequests } from './from-markdown.js';

/** What writing one body did, for the push report. */
export interface BodyResult {
  /** What the API cannot create and the push therefore left behind. */
  dropped: string[];
  /** How many batches it took: one, or two when there are footnotes. */
  batches: number;
}

export interface CreatedDoc extends BodyResult {
  id: string;
}

/** The write operations, over an injected API so tests need no network. */
export interface GDriveWriter {
  /** Clears a Doc's body and writes the Markdown in its place. */
  replaceBody(documentId: string, tree: Root): Promise<BodyResult>;
  /** A new Doc under a folder, with its body. Answers the new file's id. */
  createDoc(parentId: string, name: string, tree: Root): Promise<CreatedDoc>;
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

    const replies = await api.batchUpdate(documentId, [...head, ...plan.requests]);
    const second: DocsWriteRequest[] = [];
    for (const footnote of plan.footnotes) {
      const id = replies[footnote.requestIndex + head.length]?.createFootnote?.footnoteId;
      if (id !== undefined) second.push(...footnote.requests(id));
    }
    if (second.length === 0) return { dropped: plan.dropped, batches: 1 };

    await api.batchUpdate(documentId, second);
    return { dropped: plan.dropped, batches: 2 };
  }

  return {
    async replaceBody(documentId, tree) {
      return writeBody(documentId, tree, await api.getDocument(documentId));
    },

    async createDoc(parentId, name, tree) {
      const file = await api.createFile({ name, mimeType: DOCUMENT_MIME, parents: [parentId] });
      // A new document is empty, so there is nothing to delete first.
      return { id: file.id, ...(await writeBody(file.id, tree, undefined)) };
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
