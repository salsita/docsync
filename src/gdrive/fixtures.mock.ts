/**
 * The recorded Drive tree, as `scripts/record-gdrive-fixtures.ts` wrote it.
 *
 * Raw API responses, committed: every test above `api.ts` runs on these, so the
 * converter and the walk are exercised on what Google really answers and never
 * on a hand-written approximation. The image URL inside the Elements document
 * is signed and long expired, which does not matter — nothing downloads it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocsDocument, DriveComment, DriveFile, GDriveApi } from './api.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8')) as T;
}

interface Index {
  rootId: string;
  rootName: string;
  folders: string[];
  docs: string[];
  /** Docs whose suggestions view differs from the plain one, i.e. has any. */
  inlineDocs: string[];
  /** Docs with at least one comment thread, resolved ones included. */
  commented: string[];
  binaries: { id: string; file: string }[];
  exports: { id: string; file: string }[];
}

const index = load<Index>('index');

/** The root of the fixture tree: the Drive folder "Docsync test". */
export const ROOT_ID = index.rootId;

/** Every recorded Google Doc id, in the order the walk found them. */
export const DOC_IDS = index.docs;

/** The folder ids, root first. */
export const FOLDER_IDS = index.folders;

/** One recorded Doc, as `documents.get` answered it. */
export function fixtureDocument(id: string): DocsDocument {
  return load<DocsDocument>(`doc-${id}`);
}

/**
 * One recorded Doc as the suggestions view answers it. Identical to the plain
 * recording, apart from the view it echoes, for a document with none — which is
 * why only the documents that have one were recorded twice.
 */
export function fixtureInlineDocument(id: string): DocsDocument {
  return load<DocsDocument>(index.inlineDocs.includes(id) ? `doc-inline-${id}` : `doc-${id}`);
}

/** The recorded comment threads of one Doc, or none when it has no comments. */
export function fixtureComments(id: string): DriveComment[] {
  return index.commented.includes(id) ? load<DriveComment[]>(`comments-${id}`) : [];
}

/** One recorded folder listing, as `files.list` answered it. */
export function fixtureListing(id: string): DriveFile[] {
  return load<DriveFile[]>(`listing-${id}`);
}

/** The metadata of one recorded file, from its parent's listing or its own. */
export function fixtureFile(id: string): DriveFile {
  if (id === ROOT_ID) return load<DriveFile>(`file-${id}`);
  for (const folder of index.folders) {
    const found = fixtureListing(folder).find((file) => file.id === id);
    if (found !== undefined) return found;
  }
  throw new Error(`no recorded file ${id}`);
}

/** The bytes of one recorded binary or export. */
export function fixtureBytes(id: string): Uint8Array {
  const found = [...index.binaries, ...index.exports].find((one) => one.id === id);
  if (found === undefined) throw new Error(`no recorded bytes for ${id}`);
  return new Uint8Array(readFileSync(join(HERE, found.file)));
}

/**
 * A `GDriveApi` backed by the recorded files. Every id it is asked about must
 * have been recorded, which is the point: a test that walks off the fixture
 * tree fails loudly instead of reaching Google.
 */
export function fixtureApi(): GDriveApi {
  return {
    ...refusesToWrite(),
    async listFolder(id) {
      return fixtureListing(id);
    },
    async getFile(id) {
      return fixtureFile(id);
    },
    async getDocument(id, mode) {
      return mode === 'inline' ? fixtureInlineDocument(id) : fixtureDocument(id);
    },
    async comments(id) {
      return fixtureComments(id);
    },
    async download(id) {
      return fixtureBytes(id);
    },
    async export(id) {
      return fixtureBytes(id);
    },
  };
}

/**
 * The write half of the API, refusing. The fixture tree is a recording of the
 * owner's real Drive folder: a test that reaches a write here has a bug, and
 * it should say so rather than pretend the write happened.
 */
export function refusesToWrite(): Pick<
  GDriveApi,
  'batchUpdate' | 'createFile' | 'updateFile' | 'uploadRevision' | 'uploadFile' | 'copyFile'
> {
  const refuse = (name: string) => () => Promise.reject(new Error(`${name} on the fixture tree`));
  return {
    batchUpdate: refuse('batchUpdate'),
    createFile: refuse('createFile'),
    updateFile: refuse('updateFile'),
    uploadRevision: refuse('uploadRevision'),
    uploadFile: refuse('uploadFile'),
    copyFile: refuse('copyFile'),
  };
}
