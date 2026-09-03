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
import { bareId, blocksToMarkdown } from './to-markdown.js';
import { type SkippedObject, titleOf, type WalkedPage, walkRoot } from './walk.js';

/**
 * One Markdown file, ready to be written. A Notion page is always Markdown, so
 * the shared shape's optional `text` and `body` are always there.
 */
export interface FetchedFile extends SourceFetchedFile {
  text: string;
  body: string;
}

export interface FetchResult extends SourceFetchResult {
  files: FetchedFile[];
  /** Databases and ignored pages, so a caller can say what it left out. */
  skipped: SkippedObject[];
}

export interface FetchOptions {
  /** The API to use. Tests pass a fixture-backed one; a fetch passes nothing. */
  api?: NotionApi;
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
  return fetchWith(options.api ?? (await notionApi(provider)), root, previous);
}

async function fetchWith(
  api: NotionApi,
  root: Root,
  previous: ReadonlyMap<string, IndexEntry>,
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
  for (const page of walked.pages) {
    files.push(await toFile(page, api, pages, times.get(page.id)));
  }

  return { files, entries: files.map((file) => file.entry), skipped: walked.skipped };
}

async function toFile(
  page: WalkedPage,
  api: NotionApi,
  pages: ReadonlyMap<string, string>,
  previousTime: string | undefined,
): Promise<FetchedFile> {
  const body = blocksToMarkdown(page.blocks, { pages, from: page.path });
  const entry: IndexEntry = {
    path: page.path,
    src: page.ref,
    type: 'notion-page',
    lastEditedTime: page.lastEditedTime,
  };

  return {
    path: page.path,
    text: serializeDocument({ id: page.ref, title: page.title }, body),
    body,
    entry,
    editor: await editorOf(page, api),
    changed: previousTime !== page.lastEditedTime,
  };
}

/**
 * What one page is, from its own object and its direct blocks (MANUAL §5).
 *
 * A page with child pages is a container: on disk it is `<title>.md` and the
 * directory `<title>/` beside it, which is what `resolveAlias` needs to know.
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
    kind: childCount === 0 ? 'leaf' : 'container',
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
