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
import { formatSidecar, isSidecarPath, sidecarPathOf } from '../comments/format.js';
import { serializeDocument } from '../frontmatter.js';
import type { DocumentIndex, Editor, IndexEntry } from '../index-file.js';
import { isUnderRoot } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type {
  SourceDescription,
  FetchedFile as SourceFetchedFile,
  FetchResult as SourceFetchResult,
} from '../source.js';
import type { SourceRef } from '../source-ref.js';
import { createGDriveApi, type DriveUser, type GDriveApi } from './api.js';
import { threadsOf } from './comments.js';
import { documentToMarkdown } from './to-markdown.js';
import { EXPORTS, FOLDER_MIME, type SkippedObject, type WalkedFile, walkRoot } from './walk.js';

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
  /** What a comment sidecar's `fetched:` is stamped with. Default: now. */
  now?: () => Date;
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
  const fetched = stamp(options.now?.() ?? new Date());
  for (const file of walked.files) {
    refuseSidecar(file.path);
    // Comments are opt-in per root, because reading them costs a request per
    // document on every fetch (MANUAL §4, §7).
    files.push(...(await toFiles(file, api, before.get(file.id), fetched, root.comments === true)));
  }

  return {
    files,
    // A sidecar is written into the commit like any file and is nobody's
    // identity, so it has no entry of its own (MANUAL §6).
    entries: files.flatMap((file) => (file.entry === undefined ? [] : [file.entry])),
    skipped: walked.skipped,
  };
}

/** `2026-09-03T16:31:07Z`: to the second, which is all a sidecar prints. */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/**
 * A file at the source whose name would collide with a sidecar. The suffix has
 * to mean one thing (MANUAL §6), so this is refused rather than checked out.
 */
function refuseSidecar(path: string): void {
  if (!isSidecarPath(path)) return;
  throw new Error(
    `${path}: the .comments.md suffix is docsync's own, for the comment sidecar; rename the document at the source`,
  );
}

/**
 * What one Drive object is, from its metadata alone (MANUAL §5).
 *
 * A folder is a container and its child count is one listing; everything else
 * is a leaf that brings its own extension, which is what `resolveAlias` needs
 * to tell `specs/auth.md` from `specs/auth/`. Nothing is downloaded.
 */
export async function describe(
  ref: SourceRef,
  provider: CredentialProvider,
  options: FetchOptions = {},
): Promise<SourceDescription> {
  const api = options.api ?? (await gdriveApi(provider, options.fetch));
  const file = await api.getFile(ref.id);
  const folder = file.mimeType === FOLDER_MIME;
  const editor = editorOf(file.lastModifyingUser);

  return {
    ref: { source: 'gdocs', id: file.id },
    title: file.name,
    kind: folder ? 'container' : 'leaf',
    childCount: folder ? (await api.listFolder(file.id)).length : 0,
    ...(folder ? {} : { ext: extensionOf(file.mimeType, file.name) }),
    ...(editor === undefined ? {} : { editor }),
    lastEditedTime: file.modifiedTime ?? '',
  };
}

/**
 * The paths under one root whose Drive metadata has moved since `previous`,
 * the index of the last fetch (MANUAL §5, `docsync status`).
 *
 * The walk lists; it does not download, so this stays one listing per folder
 * however large the documents are. A binary's checksum counts as metadata,
 * since Drive moves a file's modified time without moving its content and the
 * other way round. A file that is gone from the source counts too.
 */
export async function changedSince(
  root: Root,
  provider: CredentialProvider,
  previous: DocumentIndex,
  options: FetchOptions = {},
): Promise<string[]> {
  const api = options.api ?? (await gdriveApi(provider, options.fetch));
  const known = [...previous.values()].filter((entry) => entry.src.source === 'gdocs');
  const walked = await walkRoot(
    api,
    root,
    new Map(known.map((one): [string, string] => [one.src.id, one.path])),
  );

  const before = new Map(known.map((one): [string, IndexEntry] => [one.src.id, one]));
  const changed: string[] = [];
  for (const file of walked.files) {
    const was = before.get(file.id);
    if (
      was === undefined ||
      was.lastEditedTime !== file.modifiedTime ||
      (file.md5Checksum !== undefined && was.md5 !== file.md5Checksum)
    ) {
      changed.push(file.path);
    }
  }

  const found = new Set(walked.files.map((file) => file.id));
  for (const entry of known) {
    if (!found.has(entry.src.id) && isUnderRoot(root.path, entry.path)) changed.push(entry.path);
  }
  return [...new Set(changed)].sort();
}

/** The extension a leaf takes on disk: `.md`, an export's, or the name's own. */
function extensionOf(mimeType: string, name: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return '.md';
  const exported = EXPORTS[mimeType];
  if (exported !== undefined) return exported.ext;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * One walked file as the files it becomes: the document itself, and, on a root
 * with `comments: true`, its comment sidecar when it has an open thread or a
 * pending suggestion (MANUAL §4, §6).
 */
async function toFiles(
  file: WalkedFile,
  api: GDriveApi,
  previous: IndexEntry | undefined,
  fetched: string,
  comments: boolean,
): Promise<FetchedFile[]> {
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
    changed,
    ...(editorOf(file.lastModifyingUser) === undefined
      ? {}
      : { editor: editorOf(file.lastModifyingUser) }),
  };

  if (file.kind !== 'doc') {
    // Only changed files are downloaded (MANUAL §7).
    if (!changed) return [{ ...common, entry }];
    const bytes =
      file.kind === 'export'
        ? await api.export(file.id, file.exportMimeType ?? '')
        : await api.download(file.id);
    return [{ ...common, entry, bytes }];
  }

  // With comments off, a Doc costs what it did before ticket 17: its body when
  // it changed, and not one request more (MANUAL §7).
  if (!comments) {
    if (!changed) return [{ ...common, entry }];
    const body = documentToMarkdown(await api.getDocument(file.id, 'inline'));
    return [
      {
        ...common,
        entry,
        text: serializeDocument({ id: file.ref, title: file.title }, body),
        body,
      },
    ];
  }

  // A comment moves nothing the walk can see, so every Doc's threads are read
  // on every fetch (MANUAL §6). The document itself is read when it changed, or
  // when it owes a sidecar: to place a thread the sidecar needs the body.
  const threadList = await api.comments(file.id);
  const open = threadList.filter((one) => one.resolved !== true && one.deleted !== true);
  if (!changed && open.length === 0 && previous?.suggested !== true) {
    return [{ ...common, entry }];
  }

  const document = await api.getDocument(file.id, 'inline');
  const body = documentToMarkdown(document);
  const threads = threadsOf(document, threadList, body);
  const suggested = threads.some((thread) => thread.kind === 'suggestion');

  const document_: FetchedFile = {
    ...common,
    entry: { ...entry, ...(suggested ? { suggested: true } : {}) },
    // The title is the Drive file name, which is what Drive shows and what a
    // push renames (MANUAL §6).
    ...(changed
      ? { text: serializeDocument({ id: file.ref, title: file.title }, body), body }
      : {}),
  };
  if (threads.length === 0) return [document_];
  return [
    document_,
    {
      path: sidecarPathOf(file.path),
      text: formatSidecar({ document: file.ref, fetched, threads }),
      changed: true,
    },
  ];
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
