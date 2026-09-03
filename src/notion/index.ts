/**
 * The Notion adapter, read half: one root in, files out.
 *
 * `fetchRoot` is the whole public surface. It walks the root (`walk.ts`),
 * converts each page (`to-markdown.ts`), and puts the frontmatter on
 * (`../frontmatter.ts`), answering the files to write and the index entries
 * ticket 09 records. Nothing here decides what to do with them: no disk, no
 * git, no commit.
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
import { createNotionApi, createNotionClient, type NotionApi, type RawObject } from './api.js';
import { pageThreads } from './comments.js';
import { bareId, blocksToMarkdown } from './to-markdown.js';
import { type SkippedObject, titleOf, type WalkedPage, walkRoot } from './walk.js';

/**
 * One Markdown file, ready to be written. A Notion root holds nothing but
 * Markdown, so the shared shape's optional `text` is always there. `body` is
 * the page without its frontmatter, and a comment sidecar has none.
 */
export interface FetchedFile extends SourceFetchedFile {
  text: string;
}

export interface FetchResult extends SourceFetchResult {
  files: FetchedFile[];
  /** Databases and ignored pages, so a caller can say what it left out. */
  skipped: SkippedObject[];
}

export interface FetchOptions {
  /** The API to use. Tests pass a fixture-backed one; a fetch passes nothing. */
  api?: NotionApi;
  /** What a comment sidecar's `fetched:` is stamped with. Default: now. */
  now?: () => Date;
}

/** The API a real fetch talks to, built from the stored credential. */
export async function notionApi(provider: CredentialProvider): Promise<NotionApi> {
  return createNotionApi(createNotionClient(await provider.accessToken('notion')));
}

/**
 * Fetches one Notion root.
 *
 * `previous` is the index of the whole checkout as of the last fetch, which
 * does two things: it keeps filenames stable across fetches, and it lets a
 * mention of a page in *another* root still resolve to a relative link.
 */
export async function fetchRoot(
  root: Root,
  provider: CredentialProvider,
  previous: ReadonlyMap<string, IndexEntry> = new Map(),
  options: FetchOptions = {},
): Promise<FetchResult> {
  return fetchWith(options.api ?? (await notionApi(provider)), root, previous, options);
}

async function fetchWith(
  api: NotionApi,
  root: Root,
  previous: ReadonlyMap<string, IndexEntry>,
  options: FetchOptions = {},
): Promise<FetchResult> {
  // What the index remembers about Notion pages anywhere in the checkout: their
  // paths, so a mention of a page in another root still resolves, and their
  // last-edit times, which is what makes a page "changed".
  const known = [...previous.values()].filter((entry) => entry.src.source === 'notion');
  const pages = new Map(known.map((one): [string, string] => [one.src.id, one.path]));
  const times = new Map(known.map((one): [string, string] => [one.src.id, one.lastEditedTime]));

  // The walk gets the paths as they were, so a page keeps the name it had.
  const walked = await walkRoot(api, root, new Map(pages));
  for (const page of walked.pages) pages.set(page.id, page.path);

  const files: FetchedFile[] = [];
  const fetched = `${(options.now?.() ?? new Date()).toISOString().slice(0, 19)}Z`;
  for (const page of walked.pages) {
    refuseSidecar(page.path);
    files.push(...(await toFiles(page, api, pages, times.get(page.id), fetched)));
  }

  return {
    files,
    // A sidecar is nobody's identity, so it has no entry of its own (MANUAL §6).
    entries: files.flatMap((file) => (file.entry === undefined ? [] : [file.entry])),
    skipped: walked.skipped,
  };
}

/**
 * A page whose title would give it the sidecar suffix. The suffix has to mean
 * one thing (MANUAL §6), so this is refused rather than checked out.
 */
function refuseSidecar(path: string): void {
  if (!isSidecarPath(path)) return;
  throw new Error(
    `${path}: the .comments.md suffix is docsync's own, for the comment sidecar; rename the page at the source`,
  );
}

/** One page as the files it becomes: the page, and its sidecar when it has one. */
async function toFiles(
  page: WalkedPage,
  api: NotionApi,
  pages: ReadonlyMap<string, string>,
  previousTime: string | undefined,
  fetched: string,
): Promise<FetchedFile[]> {
  const body = blocksToMarkdown(page.blocks, { pages, from: page.path });
  const entry: IndexEntry = {
    path: page.path,
    src: page.ref,
    type: 'notion-page',
    lastEditedTime: page.lastEditedTime,
  };

  const file: FetchedFile = {
    path: page.path,
    text: serializeDocument({ id: page.ref, title: page.title }, body),
    body,
    entry,
    editor: await editorOf(page, api),
    changed: previousTime !== page.lastEditedTime,
  };

  // A comment moves nothing the walk can see, so every page's threads are read
  // on every fetch, changed or not (MANUAL §6).
  const threads = await pageThreads(api, page.id, page.blocks, body);
  if (threads.length === 0) return [file];
  return [
    file,
    {
      path: sidecarPathOf(page.path),
      text: formatSidecar({ document: page.ref, fetched, threads }),
      changed: true,
    },
  ];
}

/**
 * What one page is, from its own object and its direct blocks (MANUAL §5).
 *
 * Every page is a document, children or not: on disk it is `<title>.md`, and a
 * page with child pages owns the directory `<title>/` beside it as well
 * (MANUAL §6). Only a Drive folder is a `container`, so the kind here is always
 * `leaf` and the child count is what says whether there is a directory too.
 * Nothing is converted and no subtree is walked — this runs before there is a
 * checkout, and `docsync add` must be cheap.
 */
export async function describe(
  ref: SourceRef,
  provider: CredentialProvider,
  options: FetchOptions = {},
): Promise<SourceDescription> {
  const api = options.api ?? (await notionApi(provider));
  const id = bareId(ref.id);
  const [page, blocks] = await Promise.all([api.page(id), api.children(id)]);
  const childCount = blocks.filter((block) => block.type === 'child_page').length;
  const editor = await editorFor(userIdOf(page.last_edited_by), api);

  return {
    ref: { source: 'notion', id },
    title: titleOf(page),
    kind: 'leaf',
    childCount,
    // Every Notion page is a Markdown document (MANUAL §6).
    ext: '.md',
    ...(editor === undefined ? {} : { editor }),
    lastEditedTime: String(page.last_edited_time ?? ''),
  };
}

/**
 * The paths under one root whose last-edit time differs from `previous`, the
 * index of the last fetch (MANUAL §5, `docsync status`).
 *
 * The walk is the same one a fetch does, and it stops there: page bodies are
 * never converted and nothing is downloaded. A page that appeared since the
 * last fetch and one that is gone from the source both count as changed, since
 * both are things the next fetch will move.
 */
export async function changedSince(
  root: Root,
  provider: CredentialProvider,
  previous: DocumentIndex,
  options: FetchOptions = {},
): Promise<string[]> {
  const api = options.api ?? (await notionApi(provider));
  const known = [...previous.values()].filter((entry) => entry.src.source === 'notion');
  const walked = await walkRoot(
    api,
    root,
    new Map(known.map((one): [string, string] => [one.src.id, one.path])),
  );

  const times = new Map(known.map((one): [string, string] => [one.src.id, one.lastEditedTime]));
  const changed = walked.pages
    .filter((page) => times.get(page.id) !== page.lastEditedTime)
    .map((page) => page.path);

  // A document the last fetch had and the source no longer offers is a change
  // too: the next fetch removes it.
  const found = new Set(walked.pages.map((page) => page.id));
  for (const entry of known) {
    if (!found.has(entry.src.id) && isUnderRoot(root.path, entry.path)) changed.push(entry.path);
  }
  return [...new Set(changed)].sort();
}

/** The id inside a `{ object: 'user', id }` reference on a page object. */
function userIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as RawObject).id;
  return typeof id === 'string' ? id : undefined;
}

/** The last editor of a page, resolved through the cached user lookup. */
async function editorOf(page: WalkedPage, api: NotionApi): Promise<Editor | undefined> {
  return editorFor(page.lastEditedBy, api);
}

async function editorFor(userId: string | undefined, api: NotionApi): Promise<Editor | undefined> {
  if (userId === undefined) return undefined;
  const user = await api.user(userId);
  const person = user?.person;
  const email =
    typeof person === 'object' && person !== null
      ? (person as { email?: unknown }).email
      : undefined;
  return {
    id: userId,
    name: typeof user?.name === 'string' ? user.name : undefined,
    email: typeof email === 'string' ? email : undefined,
  };
}

export type { NotionApi, NotionBlock } from './api.js';
export { createNotionApi, createNotionClient, NOTION_VERSION } from './api.js';
export type { BlockInput, FromMarkdownOptions, RichTextInput } from './from-markdown.js';
export { markdownToBlocks, mdastToBlocks, PushError } from './from-markdown.js';
export type { ChangeKind, FileChange, PushedDocument, PushReport } from './push.js';
export { pushRoot } from './push.js';
export { blocksToMarkdown, blocksToMdast } from './to-markdown.js';
export type { SkippedObject, WalkedPage } from './walk.js';
export { walkRoot } from './walk.js';
export type { NotionWriter } from './write.js';
export { createNotionWriter } from './write.js';
export type { Editor };
