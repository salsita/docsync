/**
 * The Google Drive adapter, read half: one root in, files out.
 *
 * `fetchRoot` is the whole public surface, and it answers the same shape as the
 * Notion adapter's `fetchRoot` so that ticket 09 treats both alike. It walks
 * the root (`walk.ts`), converts each Google Doc (`to-markdown.ts`), puts the
 * frontmatter on (`../frontmatter.ts`), and downloads the bytes of everything
 * that is not a Doc. Nothing here decides what to do with them: no disk, no
 * git, no commit.
 *
 * The one difference from Notion is unavoidable and deliberate: a Drive root
 * holds files that are not Markdown, so a fetched file carries either `text`
 * or `bytes`. Only what changed is downloaded (MANUAL §7), so both are absent
 * on a file whose `changed` is false.
 */
import type { CredentialProvider } from '../auth/index.js';
import { serializeDocument } from '../frontmatter.js';
import type { Editor, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type {
  FetchedFile as SourceFetchedFile,
  FetchResult as SourceFetchResult,
} from '../source.js';
import { createGDriveApi, type DriveUser, type GDriveApi } from './api.js';
import { documentToMarkdown } from './to-markdown.js';
import { type SkippedObject, type WalkedFile, walkRoot } from './walk.js';

/**
 * One file, ready to be written. A Drive root holds files that are not
 * Markdown (MANUAL §6), so this is the shared shape as it stands: `text` or
 * `bytes`, and neither on a file whose `changed` is false.
 */
export type FetchedFile = SourceFetchedFile;

export interface FetchResult extends SourceFetchResult {
  /** Ignored files and Google types with no export, so a caller can say so. */
  skipped: SkippedObject[];
}

export interface FetchOptions {
  /** The API to use. Tests pass a fixture-backed one; a fetch passes nothing. */
  api?: GDriveApi;
  /** Handed to the real API when one is built. Tests of that path pass it. */
  fetch?: typeof fetch;
}

/** The API a real fetch talks to, built from the stored credential. */
export async function gdriveApi(
  provider: CredentialProvider,
  fetchImpl?: typeof fetch,
): Promise<GDriveApi> {
  return createGDriveApi(await provider.accessToken('gdocs'), { fetch: fetchImpl });
}

/**
 * Fetches one Drive root.
 *
 * `previous` is the index of the whole checkout as of the last fetch, which
 * does two things: it keeps filenames stable across fetches, and it is what
 * "changed" is measured against.
 */
export async function fetchRoot(
  root: Root,
  provider: CredentialProvider,
  previous: ReadonlyMap<string, IndexEntry> = new Map(),
  options: FetchOptions = {},
): Promise<FetchResult> {
  const api = options.api ?? (await gdriveApi(provider, options.fetch));

  // What the index remembers about Drive files anywhere in the checkout: their
  // paths, which keep names stable, and what they looked like last time.
  const known = [...previous.values()].filter((one) => one.src.source === 'gdocs');
  const paths = new Map(known.map((one): [string, string] => [one.src.id, one.path]));
  const before = new Map(known.map((one): [string, IndexEntry] => [one.src.id, one]));

  const walked = await walkRoot(api, root, paths);
  const files: FetchedFile[] = [];
  for (const file of walked.files) files.push(await toFile(file, api, before.get(file.id)));

  return { files, entries: files.map((file) => file.entry), skipped: walked.skipped };
}

async function toFile(
  file: WalkedFile,
  api: GDriveApi,
  previous: IndexEntry | undefined,
): Promise<FetchedFile> {
  const entry: IndexEntry = {
    path: file.path,
    src: file.ref,
    type: file.kind === 'doc' ? 'gdoc' : 'drive-file',
    lastEditedTime: file.modifiedTime,
    // A push may not change an export (MANUAL §7).
    ...(file.kind === 'export' ? { readOnly: true } : {}),
    ...(file.md5Checksum === undefined ? {} : { md5: file.md5Checksum }),
  };
  const changed =
    previous === undefined ||
    previous.lastEditedTime !== file.modifiedTime ||
    (file.md5Checksum !== undefined && previous.md5 !== file.md5Checksum);

  const common = {
    path: file.path,
    entry,
    changed,
    ...(editorOf(file.lastModifyingUser) === undefined
      ? {}
      : { editor: editorOf(file.lastModifyingUser) }),
  };
  // Only changed documents are downloaded (MANUAL §7).
  if (!changed) return common;

  if (file.kind === 'doc') {
    const body = documentToMarkdown(await api.getDocument(file.id));
    // The title is the Drive file name, which is what Drive shows and what a
    // push renames (MANUAL §6).
    return { ...common, text: serializeDocument({ id: file.ref, title: file.title }, body), body };
  }
  const bytes =
    file.kind === 'export'
      ? await api.export(file.id, file.exportMimeType ?? '')
      : await api.download(file.id);
  return { ...common, bytes };
}

/** Drive's last modifying user as the editor of the commit a fetch writes. */
function editorOf(user: DriveUser | undefined): Editor | undefined {
  if (user === undefined) return undefined;
  return {
    id: user.permissionId ?? '',
    ...(user.displayName === undefined ? {} : { name: user.displayName }),
    ...(user.emailAddress === undefined ? {} : { email: user.emailAddress }),
  };
}

export type {
  DocsDocument,
  DocsWriteReply,
  DocsWriteRequest,
  DriveFile,
  DriveUser,
  FileMetadata,
  GDriveApi,
  GDriveApiOptions,
  MoveOptions,
} from './api.js';
export {
  createGDriveApi,
  DEFAULT_UPLOAD_MIME,
  DOCS_ENDPOINT,
  DOCUMENT_MIME,
  DRIVE_ENDPOINT,
  FOLDER_MIME,
  UPLOAD_ENDPOINT,
} from './api.js';
export type {
  DocsRequest,
  PlannedFootnote,
  RequestPlan,
  Segment,
  SegmentFootnote,
} from './from-markdown.js';
export {
  BULLET_PRESETS,
  CODE_FONT,
  markdownToRequests,
  mdastToRequests,
  mdastToSegments,
  segmentsToRequests,
} from './from-markdown.js';
export type { PushOptions } from './push.js';
export { pushRoot } from './push.js';
export { CODE_FONTS, documentToMarkdown, documentToMdast } from './to-markdown.js';
export type { DriveKind, SkippedObject, WalkedFile, WalkResult } from './walk.js';
export { EXPORTS, walkRoot } from './walk.js';
export type { BodyResult, CreatedDoc, GDriveWriter } from './write.js';
export { createGDriveWriter, endIndexOf } from './write.js';
