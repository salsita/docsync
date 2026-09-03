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
import type { DocsDocument, DriveFile, GDriveApi } from './api.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8')) as T;
}

interface Index {
  rootId: string;
  rootName: string;
  folders: string[];
  docs: string[];
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
    async listFolder(id) {
      return fixtureListing(id);
    },
    async getFile(id) {
      return fixtureFile(id);
    },
    async getDocument(id) {
      return fixtureDocument(id);
    },
    async download(id) {
      return fixtureBytes(id);
    },
    async export(id) {
      return fixtureBytes(id);
    },
  };
}
