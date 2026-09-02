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
import type { IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { createNotionApi, createNotionClient, type NotionApi } from './api.js';
import { blocksToMarkdown } from './to-markdown.js';
import { type SkippedObject, type WalkedPage, walkRoot } from './walk.js';

/** Who last edited a document, for the commit a fetch writes (MANUAL §7). */
export interface Editor {
  id: string;
  name?: string;
  email?: string;
}

/** One Markdown file, ready to be written. */
export interface FetchedFile {
  /** Repo-relative, `/`-separated. */
  path: string;
  /** The whole file: frontmatter and body. */
  text: string;
  /** The body alone, for a caller that has its own frontmatter to write. */
  body: string;
  entry: IndexEntry;
  editor?: Editor;
  /**
   * Whether the source's last-edit time differs from the one in the index the
   * caller passed. A first fetch marks everything changed.
   */
  changed: boolean;
}

export interface FetchResult {
  files: FetchedFile[];
  /** The index entries for this root, in the same order as `files`. */
  entries: IndexEntry[];
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

/** The last editor of a page, resolved through the cached user lookup. */
async function editorOf(page: WalkedPage, api: NotionApi): Promise<Editor | undefined> {
  if (page.lastEditedBy === undefined) return undefined;
  const user = await api.user(page.lastEditedBy);
  const person = user?.person;
  const email =
    typeof person === 'object' && person !== null
      ? (person as { email?: unknown }).email
      : undefined;
  return {
    id: page.lastEditedBy,
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
