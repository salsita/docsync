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
import { formatSidecar, isSidecarPath, sidecarPathOf, type Thread } from '../comments/format.js';
import { serializeDocument } from '../frontmatter.js';
import type { DocumentIndex, Editor, IndexEntry } from '../index-file.js';
import { isUnderRoot } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type {
  SourceDescription,
  FetchedFile as SourceFetchedFile,
  FetchOptions as SourceFetchOptions,
  FetchResult as SourceFetchResult,
} from '../source.js';
import { type SourceRef, sourceUrl, splitGDocsRef, tabRef } from '../source-ref.js';
import {
  COMMENTS_PREVIEW_HINT,
  commentsRefused,
  createGDriveApi,
  type DocsDocument,
  type DriveComment,
  type DriveUser,
  type GDriveApi,
} from './api.js';
import { fetchDocumentAssets, keptAssets } from './assets.js';
import { placeThreads } from './comments.js';
import { flattenTabs, tabNames, tabPaths } from './tabs.js';
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

export interface FetchOptions extends SourceFetchOptions {
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
  const { paths, directories } = driveMemory(previous);

  // What it is doing, while it does it (MANUAL §7). The walk is one listing
  // per folder and downloads nothing, so it is announced as a whole.
  const progress = options.progress ?? noop;
  progress(`listing ${root.path}`);

  const walked = await walkRoot(api, root, paths, new Set(directories.keys()));
  return convertWalk(walked, api, root, previous, options);
}

/**
 * What the index remembers about the Drive files of a checkout (ticket 37).
 *
 * Their paths, which keep filenames stable across fetches, the directories the
 * tabbed Docs among them were checked out as, and the entries themselves, which
 * are what "changed" is measured against. Files only: an asset has no listing of
 * its own and moves with the document that holds it (MANUAL §12 phase 2), and a
 * tab file moves with its Doc — what the walk names is the Doc, which the index
 * holds either as a file (`Notes.md`) or as a directory (`Notes/`).
 */
export function driveMemory(previous: ReadonlyMap<string, IndexEntry>): {
  paths: Map<string, string>;
  directories: Map<string, string>;
  before: Map<string, IndexEntry>;
} {
  const docs = [...previous.values()].filter(
    (one) =>
      one.src.source === 'gdocs' &&
      one.type !== 'asset' &&
      splitGDocsRef(one.src).tabId === undefined,
  );
  const directories = new Map<string, string>();
  for (const one of docs) if (one.path.endsWith('/')) directories.set(one.src.id, one.path);
  return {
    paths: new Map(
      docs.map((one): [string, string] => [
        one.src.id,
        one.path.endsWith('/') ? one.path.slice(0, -1) : one.path,
      ]),
    ),
    directories,
    before: new Map(docs.map((one): [string, IndexEntry] => [one.src.id, one])),
  };
}

/**
 * The files one walk becomes: the whole read half of a Drive fetch, minus the
 * walk itself.
 *
 * Exported for the calendar adapter (ticket 38), which builds its own
 * `WalkedFile` list — an event's attachments rather than a folder's children —
 * and needs tabs, assets, comments and sidecars to come out exactly as a Drive
 * root's do. Nothing here knows where the list came from.
 */
export async function convertWalk(
  walked: { files: WalkedFile[]; skipped: SkippedObject[] },
  api: GDriveApi,
  root: Root,
  previous: ReadonlyMap<string, IndexEntry> = new Map(),
  options: FetchOptions = {},
): Promise<FetchResult> {
  const { directories, before } = driveMemory(previous);
  const progress = options.progress ?? noop;
  const files: FetchedFile[] = [];
  const fetched = stamp(options.now?.() ?? new Date());
  const comments = root.comments === true;
  // Under a suggest root every Doc is read on every fetch (MANUAL §4, §7):
  // Drive moves no `modifiedTime` for a suggestion made, accepted or rejected
  // in Docs, and a suggesting push leaves the body behind for the fetch to put
  // back.
  const suggest = root.suggest === true;
  // A re-fetch downloads every document again, whatever Drive's metadata says
  // (MANUAL §7), so every one of them is counted.
  const all = options.all === true;
  const read = (file: WalkedFile): boolean =>
    all || hasChanged(file, before.get(file.id)) || (suggest && file.kind === 'doc');
  // Only the documents that are downloaded are counted; the walk is over, so
  // the total is known before the first one is named.
  const total = all ? walked.files.length : walked.files.filter((file) => read(file)).length;
  let done = 0;

  // The directories the fetch is about to write into: a tabbed Doc may not
  // take a name another file of this root already occupies (MANUAL §6).
  const occupied = new Set(
    walked.files.map((one) => one.path.slice(0, one.path.lastIndexOf('/') + 1)),
  );
  // A tabbed Doc's directory has no file of its own, so its entry cannot come
  // from one (ticket 37).
  const directoryEntries: IndexEntry[] = [];
  // Shared by every document of this root: the first refusal of the preview's
  // `commentsViewMode` is the last time it is asked for (MANUAL §7, ticket 40).
  const preview = { available: true };

  for (const file of walked.files) {
    refuseSidecar(file.path);
    if (read(file)) progress(`${++done}/${total} ${file.path}`);
    // On a root with comments a Doc's threads are read whether it moved or
    // not, and that is the slow half of such a fetch (MANUAL §6, §7).
    if (comments && file.kind === 'doc') progress(`comments ${file.path}`);
    // Comments are opt-in per root, because reading them costs a request per
    // document on every fetch (MANUAL §4, §7).
    const made = await toFiles(file, api, before.get(file.id), fetched, comments, previous, all, {
      suggest,
      directory: directories.get(file.id),
      occupied,
      preview,
      progress,
    });
    files.push(...made.files);
    directoryEntries.push(...made.entries);
  }

  return {
    files,
    // A sidecar is written into the commit like any file and is nobody's
    // identity, so it has no entry of its own (MANUAL §6).
    entries: [
      ...files.flatMap((file) => (file.entry === undefined ? [] : [file.entry])),
      ...directoryEntries,
    ],
    skipped: walked.skipped,
  };
}

/** A progress hook that is not there. */
function noop(): void {}

/**
 * Whether a walked file differs from what the last fetch recorded of it.
 *
 * Drive moves a binary's modified time without moving its bytes and the other
 * way round, so a checksum counts as metadata too (MANUAL §7).
 */
function hasChanged(file: WalkedFile, previous: IndexEntry | undefined): boolean {
  return (
    previous === undefined ||
    previous.lastEditedTime !== file.modifiedTime ||
    (file.md5Checksum !== undefined && previous.md5 !== file.md5Checksum)
  );
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
  // Files only: an asset has no listing of its own and moves with its document
  // (MANUAL §12 phase 2). Tab files only move with theirs: what the walk names
  // is the Doc, which the index holds as a file or as a directory (ticket 37).
  const known = [...previous.values()].filter(
    (entry) =>
      entry.src.source === 'gdocs' &&
      entry.type !== 'asset' &&
      splitGDocsRef(entry.src).tabId === undefined,
  );
  const tabbed = new Set(known.filter((one) => one.path.endsWith('/')).map((one) => one.src.id));
  const walked = await walkRoot(
    api,
    root,
    new Map(
      known.map((one): [string, string] => [
        one.src.id,
        one.path.endsWith('/') ? one.path.slice(0, -1) : one.path,
      ]),
    ),
    tabbed,
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
      // A tabbed Doc is reported as its directory, which is what it is on
      // disk: every tab file inside it is written again (ticket 37).
      changed.push(tabbed.has(file.id) ? `${file.path}/` : file.path);
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

/** What a tabbed Doc needs beyond the walk to become files (ticket 37). */
interface DocContext {
  /** Under a suggest root every Doc is read on every fetch (MANUAL §7). */
  suggest: boolean;
  /**
   * The directory this Doc was checked out as at the last fetch, trailing
   * slash and all, when it holds several tabs. Absent for a Doc that was one
   * file — which includes a Doc that has only now gained a tab.
   */
  directory?: string;
  /** Every directory this root is writing into, so a new one takes a free name. */
  occupied: ReadonlySet<string>;
  /**
   * Whether the Developer Preview's `commentsViewMode` is still worth asking
   * for (MANUAL §7, ticket 40). One refusal turns it off for the rest of the
   * root, so a project that is not enrolled pays for one refused read and
   * hears one line about it, not one per document.
   */
  preview: { available: boolean };
  /** Where that one line goes. */
  progress: (line: string) => void;
}

/** One walked file as the files it becomes, and the entries no file carries. */
interface ToFiles {
  files: FetchedFile[];
  /** A tabbed Doc’s directory entry, which has no file (ticket 37). */
  entries: IndexEntry[];
}

/**
 * One walked file as the files it becomes: the document itself — one file per
 * tab when the Doc has several (MANUAL §6, ticket 37) — and, on a root with
 * `comments: true`, a comment sidecar per tab file that has an open thread or a
 * pending suggestion (MANUAL §4, §6).
 */
async function toFiles(
  file: WalkedFile,
  api: GDriveApi,
  previous: IndexEntry | undefined,
  fetched: string,
  comments: boolean,
  index: ReadonlyMap<string, IndexEntry>,
  all: boolean,
  context: DocContext,
): Promise<ToFiles> {
  const entry: IndexEntry = {
    path: file.path,
    src: file.ref,
    type: file.kind === 'doc' ? 'gdoc' : 'drive-file',
    lastEditedTime: file.modifiedTime,
    // A push may not change an export (MANUAL §7).
    ...(file.kind === 'export' ? { readOnly: true } : {}),
    ...(file.md5Checksum === undefined ? {} : { md5: file.md5Checksum }),
  };
  const moved = hasChanged(file, previous);
  // A Doc under a suggest root is read and written on every fetch, whatever
  // Drive's metadata says (MANUAL §7): that is how a suggestion shows up and
  // how the body comes back to the source text after a suggesting push.
  const always = context.suggest && file.kind === 'doc';
  // Under `--all` everything is downloaded and converted again; what came out
  // differently is for the caller's blob comparison to say (MANUAL §7).
  const changed = all || moved || always;

  const common = {
    changed,
    // Nobody edited it: what the bytes say decides whether this is a change at
    // all, and the report does not blame the last editor for it (MANUAL §7).
    ...(all || always ? { sourceChanged: moved } : {}),
    ...(editorOf(file.lastModifyingUser) === undefined
      ? {}
      : { editor: editorOf(file.lastModifyingUser) }),
  };

  if (file.kind !== 'doc') {
    // Only changed files are downloaded (MANUAL §7).
    if (!changed) return { files: [{ ...common, path: file.path, entry }], entries: [] };
    const bytes =
      file.kind === 'export'
        ? await api.export(file.id, file.exportMimeType ?? '')
        : await api.download(file.id);
    return { files: [{ ...common, path: file.path, entry, bytes }], entries: [] };
  }

  // The tab files the last fetch wrote for this Doc, by tab id. They are what a
  // Doc nobody read this time is carried over as, and what keeps a tab's
  // filename — a `(2)` suffix included — attached to the same tab.
  const knownTabs = tabEntriesOf(index, file.id);

  /** A Doc nobody downloaded: the files the last fetch left, by the index. */
  const carried = (): ToFiles => {
    if (context.directory === undefined) {
      return {
        files: [{ ...common, path: file.path, entry }, ...keptAssets(index, file.path)],
        entries: [],
      };
    }
    const files: FetchedFile[] = [];
    for (const one of knownTabs.values()) {
      files.push({ ...common, path: one.path, entry: one }, ...keptAssets(index, one.path));
    }
    return { files, entries: [directoryEntry(context.directory, file)] };
  };

  // With comments off, a Doc costs what it did before ticket 17: its body when
  // it changed, and not one request more (MANUAL §7).
  if (!comments) {
    // A document that did not change downloads nothing at all, images
    // included; the files it already has are carried over (MANUAL §12).
    if (!changed) return carried();
    return tabbedFiles(await api.getDocument(file.id, 'inline'), []);
  }

  // A comment moves nothing the walk can see, so every Doc's threads are read
  // on every fetch (MANUAL §6). The document itself is read when it changed, or
  // when it owes a sidecar: to place a thread the sidecar needs the body.
  const threadList = await api.comments(file.id);
  const open = threadList.filter((one) => one.resolved !== true && one.deleted !== true);
  if (!changed && open.length === 0 && previous?.suggested !== true) return carried();

  return tabbedFiles(await readWithDiscussions(), threadList);

  /**
   * The read a sidecar is built from (MANUAL §6, §7, ticket 40).
   *
   * The discussion on a suggestion and the exact comment anchors come with the
   * body, under the Developer Preview's `commentsViewMode`, so this costs no
   * request the fetch was not already making. A project that is not enrolled
   * has the parameter refused; the read is made again without it, once, and
   * the sidecar is built from Drive's threads placed by quote, as before.
   */
  async function readWithDiscussions(): Promise<DocsDocument> {
    if (!context.preview.available) return api.getDocument(file.id, 'inline');
    try {
      return await api.getDocument(file.id, 'inline', { comments: true });
    } catch (error) {
      if (!commentsRefused(error)) throw error;
      context.preview.available = false;
      context.progress(COMMENTS_PREVIEW_HINT);
      return api.getDocument(file.id, 'inline');
    }
  }

  /**
   * The Doc, tab by tab.
   *
   * One tab and no children is what it always was: `<title>.md`, `id:
   * gdocs:<docId>`, one sidecar, one assets directory. Several tabs is a
   * directory of tab files, each of them a document in its own right — its own
   * id, title, URL, sidecar and assets (MANUAL §6, ticket 37).
   */
  async function tabbedFiles(
    document: DocsDocument,
    threadList: readonly DriveComment[],
  ): Promise<ToFiles> {
    const tabs = flattenTabs(document);
    const multi = tabs.length > 1;
    const directory = multi ? directoryFor(file, context) : undefined;
    const names = multi ? tabNames(tabs, namesOf(knownTabs)) : new Map<string, string>();
    const places = multi ? tabPaths(tabs, names, directory ?? '') : new Map<string, string>();

    // Everything each tab is, before a single file is built: a comment thread
    // is placed in the first tab whose body holds its quote, so the bodies of
    // all of them have to exist first (MANUAL §6).
    const read = [];
    for (const tab of tabs) {
      const path = multi ? (places.get(tab.id ?? '') ?? file.path) : documentPath(file.path);
      // A tab file names its tab; a Doc of one tab is the Doc (ticket 37).
      const ref = multi ? tabRef(file.id, tab.id) : file.ref;
      // A document nobody edited keeps the files it has: it is read for its
      // anchors and its suggestions, not for its images (MANUAL §12 phase 2).
      const assets =
        all || moved
          ? await fetchDocumentAssets(api, tab.doc, path, index)
          : { files: keptAssets(index, path), links: linksOf(index, path) };
      const body = documentToMarkdown(tab.doc, { assets: assets.links, from: path });
      read.push({ tab, path, ref, assets, body });
    }

    // With comments off a Doc has no sidecar at all, suggestions included
    // (MANUAL §4): nothing is placed, and nothing is read for it.
    const threads = comments
      ? placeThreads(
          read.map((one) => ({ doc: one.tab.doc, body: one.body })),
          threadList,
          // What the preview answered, when it did: the threads under the same
          // ids Drive gives them, and the discussions on the suggestions
          // (MANUAL §6, ticket 40).
          document,
        )
      : read.map((): Thread[] => []);

    const files: FetchedFile[] = [];
    for (const [at, one] of read.entries()) {
      const mine = threads[at] ?? [];
      const suggested = mine.some((thread) => thread.kind === 'suggestion');
      files.push({
        ...common,
        path: one.path,
        entry: {
          path: one.path,
          src: one.ref,
          type: 'gdoc',
          lastEditedTime: file.modifiedTime,
          ...(suggested ? { suggested: true } : {}),
        },
        // The title is the tab's, or the Drive file name for a Doc of one tab,
        // which is what Drive shows and what a push renames (MANUAL §6).
        ...(changed
          ? {
              text: serializeDocument(
                {
                  id: one.ref,
                  title: multi ? one.tab.title : file.title,
                  url: sourceUrl(one.ref, file.mimeType),
                },
                one.body,
              ),
              body: one.body,
            }
          : {}),
      });
      files.push(...one.assets.files);
      if (mine.length === 0) continue;
      files.push({
        path: sidecarPathOf(one.path),
        text: formatSidecar({ document: one.ref, fetched, threads: mine }),
        changed: true,
      });
    }
    return {
      files,
      entries: directory === undefined ? [] : [directoryEntry(`${directory}/`, file)],
    };
  }
}

/**
 * The index entry of a tabbed Doc's directory (ticket 37).
 *
 * A nested tab's depth varies, so the paths alone cannot say where the Doc's
 * directory starts; this is what a push reads to find the Doc, its title and
 * its Drive parent without guessing.
 */
function directoryEntry(path: string, file: WalkedFile): IndexEntry {
  return {
    path,
    src: { source: 'gdocs', id: file.id },
    type: 'gdoc',
    lastEditedTime: file.modifiedTime,
  };
}

/**
 * Where a tabbed Doc's directory goes.
 *
 * The one the last fetch used, or — for a Doc that has just gained a tab —
 * the name its file had, which is what makes the transition a rename git can
 * follow. A directory another file of this root already occupies takes the
 * numeric suffix two files of one title take (MANUAL §6).
 */
function directoryFor(file: WalkedFile, context: DocContext): string {
  if (context.directory !== undefined) return context.directory.slice(0, -1);
  const base = file.path.endsWith('.md') ? file.path.slice(0, -'.md'.length) : file.path;
  let name = base;
  for (let n = 2; context.occupied.has(`${name}/`); n += 1) name = `${base} (${n})`;
  return name;
}

/** A Doc of one tab is a `.md` file, whatever name the walk gave it. */
function documentPath(path: string): string {
  return path.endsWith('.md') ? path : `${path}.md`;
}

/** The tab files of one Doc that the last fetch wrote, by tab id. */
function tabEntriesOf(
  index: ReadonlyMap<string, IndexEntry>,
  docId: string,
): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  for (const entry of index.values()) {
    if (entry.src.source !== 'gdocs' || entry.type !== 'gdoc') continue;
    const { docId: id, tabId } = splitGDocsRef(entry.src);
    if (id === docId && tabId !== undefined) out.set(tabId, entry);
  }
  return out;
}

/** The filename each tab had at the last fetch, for `tabNames`. */
function namesOf(entries: ReadonlyMap<string, IndexEntry>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [tabId, entry] of entries) {
    names.set(tabId, entry.path.slice(entry.path.lastIndexOf('/') + 1));
  }
  return names;
}

/** The links an unchanged document's images already have, by object id. */
function linksOf(
  index: ReadonlyMap<string, IndexEntry>,
  documentPath: string,
): Map<string, string> {
  const links = new Map<string, string>();
  for (const entry of index.values()) {
    if (entry.type === 'asset' && entry.document === documentPath) {
      links.set(entry.src.id, entry.path);
    }
  }
  return links;
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
