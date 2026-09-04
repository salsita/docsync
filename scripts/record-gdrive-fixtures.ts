/**
 * Record the Google Drive fixture tree, once, with the owner's own token.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/record-gdrive-fixtures.ts
 *
 * Walks the folder "Docsync test" (ticket 07) and writes the raw API responses
 * to `src/gdrive/__fixtures__/`, which is what every test above `api.ts` runs
 * on: one listing per folder, the Docs API document JSON per Google Doc, the
 * small binaries as bytes, and the Sheet's `.xlsx` export.
 *
 * Strictly read-only: `files.list`, `files.get`, `files.export`,
 * `documents.get` and `comments.list`. It cannot create, move or trash
 * anything in Drive.
 *
 * Per Google Doc it records the document twice — without suggestions, which is
 * what a fetch reads, and with them inline, which is what a push and the
 * comment sidecar read (ticket 16, ticket 17) — and the open comment threads.
 * The inline copy is written only when it differs from the plain one, so a
 * document with no pending suggestion costs no second fixture.
 *
 * An inline image of a Google Doc is recorded twice as well: the document's
 * JSON, whose `contentUri` is good for about half an hour, and the *bytes*
 * behind it, saved as `asset-<objectId><ext>` (ticket 14). The bytes are what
 * the fetch tests compare against, so a stale URI costs nothing.
 *
 * Re-run only deliberately.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialProvider } from '../dist/auth/index.js';

const ROOT_ID = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gdrive', '__fixtures__');

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

/** Google types exported rather than downloaded, and what they export as. */
const EXPORTS = {
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
  },
  'application/vnd.google-apps.drawing': { mime: 'image/svg+xml', ext: '.svg' },
};

const FIELDS = 'id,name,mimeType,modifiedTime,lastModifyingUser,md5Checksum,size';

const token = await createCredentialProvider().accessToken('gdocs');

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${response.status} on ${url}: ${await response.text()}`);
  return response;
}

async function json<T>(url: string): Promise<T> {
  return (await (await get(url)).json()) as T;
}

async function write(name: string, value: unknown): Promise<void> {
  await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  ${name}.json`);
}

async function writeBytes(name: string, bytes: Uint8Array): Promise<void> {
  await writeFile(join(OUT, name), bytes);
  console.log(`  ${name} (${bytes.length} bytes)`);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
}

/** One page-collapsed listing of a folder, exactly as `files.list` answers. */
async function listFolder(id: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      q: `'${id}' in parents and trashed=false`,
      fields: `nextPageToken,files(${FIELDS})`,
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken !== undefined) query.set('pageToken', pageToken);
    const page = await json<{ files: DriveFile[]; nextPageToken?: string }>(
      `https://www.googleapis.com/drive/v3/files?${query}`,
    );
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return files;
}

/** One comment thread, as `comments.list` answers it with `fields=*`. */
interface DriveComment {
  id: string;
}

/**
 * Every open comment thread on one file, replies included, across every page.
 * `includeDeleted=false` leaves out the tombstones (MANUAL §6); `fields=*` is
 * what makes Drive answer `quotedFileContent`, `resolved` and `replies` at all.
 */
async function listComments(id: string): Promise<DriveComment[]> {
  const comments: DriveComment[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      fields: '*',
      includeDeleted: 'false',
      pageSize: '100',
    });
    if (pageToken !== undefined) query.set('pageToken', pageToken);
    const page = await json<{ comments?: DriveComment[]; nextPageToken?: string }>(
      `https://www.googleapis.com/drive/v3/files/${id}/comments?${query}`,
    );
    comments.push(...(page.comments ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return comments;
}

const folders: string[] = [];
const docs: string[] = [];
const inlineDocs: string[] = [];
const commented: string[] = [];
let requests = 0;
const binaries: { id: string; file: string }[] = [];
const exports: { id: string; file: string }[] = [];
const assets: { doc: string; object: string; uri: string; file: string }[] = [];

/** The extension a content type implies, for an object that carries no name. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
};

/**
 * The bytes behind every inline image of one Doc. Read-only: one authenticated
 * `GET` of a URI the Docs API itself handed us, and nothing else.
 */
async function recordImages(docId: string, document: unknown): Promise<void> {
  const objects = (document as { inlineObjects?: Record<string, Record<string, never>> })
    .inlineObjects;
  for (const [objectId, object] of Object.entries(objects ?? {})) {
    const embedded = (
      object as {
        inlineObjectProperties?: { embeddedObject?: { imageProperties?: { contentUri?: string } } };
      }
    ).inlineObjectProperties?.embeddedObject;
    const uri = embedded?.imageProperties?.contentUri;
    if (uri === undefined) continue;
    const response = await get(uri);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const file = `asset-${objectId.replaceAll('.', '-')}${IMAGE_EXTENSIONS[type] ?? ''}`;
    await writeBytes(file, bytes);
    assets.push({ doc: docId, object: objectId, uri, file });
  }
}

async function record(folderId: string, path: string): Promise<void> {
  const files = await listFolder(folderId);
  folders.push(folderId);
  await write(`listing-${folderId}`, files);

  for (const file of files) {
    console.log(`${file.mimeType.padEnd(46)} ${path}${file.name}`);
    if (file.mimeType === FOLDER) {
      await record(file.id, `${path}${file.name}/`);
      continue;
    }
    if (file.mimeType === DOC) {
      const document = await json(
        `https://docs.googleapis.com/v1/documents/${file.id}?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`,
      );
      const inline = await json(
        `https://docs.googleapis.com/v1/documents/${file.id}?suggestionsViewMode=SUGGESTIONS_INLINE`,
      );
      const comments = await listComments(file.id);
      requests += 3;
      docs.push(file.id);
      await write(`doc-${file.id}`, document);
      await recordImages(file.id, document);
      // Every response echoes the view it was asked for, which is the one
      // difference a document with no pending suggestion has.
      const same = (value: unknown): string =>
        JSON.stringify({ ...(value as object), suggestionsViewMode: undefined });
      if (same(inline) !== same(document)) {
        inlineDocs.push(file.id);
        await write(`doc-inline-${file.id}`, inline);
      }
      if (comments.length > 0) {
        commented.push(file.id);
        await write(`comments-${file.id}`, comments);
      }
      continue;
    }
    const exported = EXPORTS[file.mimeType as keyof typeof EXPORTS];
    if (exported !== undefined) {
      const response = await get(
        `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exported.mime)}`,
      );
      const name = `export-${file.id}${exported.ext}`;
      await writeBytes(name, new Uint8Array(await response.arrayBuffer()));
      exports.push({ id: file.id, file: name });
      continue;
    }
    const response = await get(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`,
    );
    const dot = file.name.lastIndexOf('.');
    const name = `binary-${file.id}${dot > 0 ? file.name.slice(dot) : ''}`;
    await writeBytes(name, new Uint8Array(await response.arrayBuffer()));
    binaries.push({ id: file.id, file: name });
  }
}

await mkdir(OUT, { recursive: true });
console.log(`Recording Drive folder ${ROOT_ID}:`);
const root = await json<DriveFile>(
  `https://www.googleapis.com/drive/v3/files/${ROOT_ID}?fields=${FIELDS}&supportsAllDrives=true`,
);
await write(`file-${ROOT_ID}`, root);
await record(ROOT_ID, '');
await write('index', {
  rootId: ROOT_ID,
  rootName: root.name,
  folders,
  docs,
  inlineDocs,
  commented,
  binaries,
  exports,
  assets,
});
console.log(`${requests} document and comment requests for ${docs.length} Docs`);
