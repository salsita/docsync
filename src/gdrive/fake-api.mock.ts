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
  DocsDocument,
  DocsWriteRequest,
  DriveFile,
  FileMetadata,
  GDriveApi,
  MoveOptions,
} from './api.js';
import { createDocsModel, type DocsModel } from './docs-model.mock.js';
import { documentToMarkdown } from './to-markdown.js';

/** One file in the fake Drive. */
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed?: boolean;
  bytes?: Uint8Array;
}

export interface FakeDrive extends GDriveApi {
  /** Every file, by id, including the ones a push made. */
  files: Map<string, FakeFile>;
  /** Bytes by URI, for the images a document already holds. */
  hosted: Map<string, Uint8Array>;
  /** The shares that exist right now, as `<fileId>:<permissionId>`. */
  permissions: Set<string>;
  /** Every operation, in order: `createFile Notes`, `trash doc1`, … */
  calls: string[];
  /** One document's body as Markdown, for asserting what a push wrote. */
  markdown(id: string): string;
}

const DOCUMENT = 'application/vnd.google-apps.document';

/** A Drive holding the files given, with an empty document behind each Doc. */
export function createFakeDrive(seed: readonly Partial<FakeFile>[] = []): FakeDrive {
  const files = new Map<string, FakeFile>();
  const documents = new Map<string, DocsModel>();
  const hosted = new Map<string, Uint8Array>();
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
    };
    files.set(file.id, file);
    if (file.mimeType === DOCUMENT) documents.set(file.id, createDocsModel(file.id, file.name));
  }

  function metadata(file: FakeFile): DriveFile {
    return { id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: '' };
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
    if (file.mimeType === DOCUMENT) documents.set(file.id, createDocsModel(file.id, file.name));
    calls.push(`create ${file.name}`);
    return metadata(file);
  }

  return {
    files,
    calls,
    hosted,
    permissions,

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

    markdown(id) {
      const model = documents.get(id);
      if (model === undefined) throw new Error(`no document ${id}`);
      // The body as everyone but a reviewer sees it: what a suggestion proposes
      // is not in it (MANUAL §6).
      return documentToMarkdown(model.document('preview'));
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

    async getDocument(id, mode = 'preview'): Promise<DocsDocument> {
      const model = documents.get(id);
      if (model === undefined) throw new Error(`no document ${id}`);
      // Inline is the view a push and a comment sidecar read: the pending
      // suggestions are on the runs they touch (MANUAL §6, §7).
      return model.document(mode);
    },

    async comments() {
      // The fake Drive holds no comments; a push never reads one.
      return [];
    },

    async download(id) {
      return get(id).bytes ?? new Uint8Array();
    },

    async export() {
      throw new Error('the fake Drive does not export');
    },

    async batchUpdate(documentId, requests, options = {}): Promise<BatchUpdateResult> {
      const model = documents.get(documentId);
      if (model === undefined) throw new Error(`no document ${documentId}`);
      const suggesting = options.suggest === true;
      calls.push(`batchUpdate ${documentId}${suggesting ? ' suggest' : ''}`);
      const replies = model.apply(requests as DocsWriteRequest[], { suggest: suggesting });
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
