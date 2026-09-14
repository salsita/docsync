/**
 * Source refs address one object in one document store (MANUAL §1, §13).
 *
 * There are two doors into this module, and the difference is only which
 * *spellings* they accept — both agree on what a valid id is, and
 * `parseSourceRefOrUrl` accepts a strict superset of `parseSourceRef`:
 *
 * - `parseSourceRef(text)` takes the literal `notion:<id>` / `gdocs:<id>` form
 *   only, and answers `undefined` for anything else. This is the door used from
 *   inside a manifest (`src:`) and an ignore list, where an entry that is not a
 *   ref is a perfectly good gitignore pattern rather than a mistake, so there
 *   is no message to report. `isSourceRef` is the boolean version.
 * - `parseSourceRefOrUrl(text)` additionally takes the Notion, Google Docs and
 *   Drive URLs people paste (MANUAL §13: "URLs are accepted everywhere a
 *   source ref is"), and answers a `SourceRefError` instead of `undefined`, so
 *   the CLI can say what it expected. Use this one for anything a human typed.
 *
 * Canonical ids: a Notion id is 32 lowercase hex digits without dashes, and a
 * Google id is verbatim, since Drive ids are opaque. One Google form carries a
 * second id inside the first: `gdocs:<docId>#<tabId>` is one tab of a Google
 * Doc (MANUAL §6, ticket 37), which `splitGDocsRef` takes apart and nothing
 * else has to. `formatSourceRef` prints
 * the canonical form, which is always a literal ref and never contains a
 * slash — which is what lets an ignore list mix refs with globs.
 *
 * Pure, no I/O.
 */

/** A document store. */
export type Source = 'notion' | 'gdocs';

/** One object in one source. */
export interface SourceRef {
  source: Source;
  id: string;
}

/** Why a piece of text is not a source ref. `input` is the text as given. */
export interface SourceRefError {
  input: string;
  message: string;
}

// A literal ref. The id may not hold whitespace or a slash: keeping slashes out
// is what lets an ignore list mix refs with gitignore patterns (MANUAL §4).
const REF = /^([A-Za-z]+):([^\s/]+)$/;

const NOTION_HEX = /^[0-9a-f]{32}$/i;
const NOTION_DASHED = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const GOOGLE_ID = /^[A-Za-z0-9_-]{20,}$/;

/**
 * A Google Docs tab id (MANUAL §6, ticket 37). Every one of them is `t.` and
 * then some, which is what lets `gdocs:<docId>#<tabId>` stay one token: the
 * fragment cannot be mistaken for the `#<startIndex>` a placeholder addresses a
 * structural element by.
 */
const GOOGLE_TAB_ID = /^t\.[A-Za-z0-9_-]+$/;

const GOOGLE_TAB_SHAPE = 'A Google Docs tab id starts with "t.".';

// The id inside a Notion URL path: a dashed UUID or a bare 32-hex run, in
// either case bounded so a longer hex run is not silently truncated.
const NOTION_ID_IN_PATH =
  /(?<![0-9a-f])(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-f])/gi;

const EXPECTED = 'Expected notion:<id>, gdocs:<id>, or a Notion / Google Docs / Drive URL.';
const NOTION_ID_SHAPE = 'A Notion id is 32 hex characters, dashed or not.';
const GOOGLE_ID_SHAPE = 'A Google id is at least 20 characters of A-Z a-z 0-9 _ and -.';
const NOTION_URL_SHAPE = 'A Notion URL must carry a 32-hex page id in its path.';
const GOOGLE_URL_SHAPE = 'A Google URL must carry a document, file or folder id.';

function fail(input: string, detail: string): SourceRefError {
  return { input, message: `Not a source ref: ${JSON.stringify(input)}. ${detail}` };
}

/** Undashes and lowercases a Notion id, or undefined if it is not one. */
function canonicalNotionId(id: string): string | undefined {
  if (!NOTION_HEX.test(id) && !NOTION_DASHED.test(id)) return undefined;
  return id.replaceAll('-', '').toLowerCase();
}

/** Whether a host is one Notion serves pages from. */
function isNotionHost(host: string): boolean {
  return (
    host === 'notion.so' ||
    host === 'www.notion.so' ||
    host === 'notion.com' ||
    host === 'www.notion.com' ||
    host === 'app.notion.com' ||
    host.endsWith('.notion.site')
  );
}

function notionFromUrl(input: string, url: URL): SourceRef | SourceRefError {
  // Query and fragment are dropped: a `?v=` view id and a `#<hex>` block anchor
  // are not the page id. The page id is the last one in the path.
  const found = url.pathname.match(NOTION_ID_IN_PATH);
  const last = found?.at(-1);
  if (last === undefined) return fail(input, NOTION_URL_SHAPE);
  return { source: 'notion', id: last.replaceAll('-', '').toLowerCase() };
}

function googleFromUrl(input: string, url: URL): SourceRef | SourceRefError {
  // Drop the `/u/<n>/` account segment, which appears at different depths
  // (`/document/u/0/d/<id>`, `/drive/u/0/folders/<id>`).
  const parts: string[] = [];
  for (const segment of url.pathname.split('/')) {
    if (segment === '') continue;
    if (parts.at(-1) === 'u' && /^\d+$/.test(segment)) parts.pop();
    else parts.push(segment);
  }

  // `/<kind>/d/<id>/…` covers documents, spreadsheets, presentations, drawings
  // and Drive files; `/drive/folders/<id>` a folder; `/open?id=<id>` the share
  // link Drive hands out.
  const d = parts.indexOf('d');
  const folders = parts.indexOf('folders');
  let id: string | undefined;
  if (d >= 0) id = parts[d + 1];
  else if (folders >= 0) id = parts[folders + 1];
  else if (parts.includes('open')) id = url.searchParams.get('id') ?? undefined;

  if (id === undefined || !GOOGLE_ID.test(id)) return fail(input, GOOGLE_URL_SHAPE);
  return { source: 'gdocs', id };
}

/**
 * Parses the literal `notion:<id>` / `gdocs:<id>` form, ignoring surrounding
 * whitespace. Returns undefined for anything else, URLs included; use
 * `parseSourceRefOrUrl` when the text came from a person.
 */
export function parseSourceRef(text: string): SourceRef | undefined {
  const parsed = parseLiteral(text);
  return parsed === undefined || isSourceRefError(parsed) ? undefined : parsed;
}

/**
 * Parses a literal ref or a Notion / Google Docs / Drive URL into a canonical
 * ref, or explains why the text is neither.
 */
export function parseSourceRefOrUrl(text: string): SourceRef | SourceRefError {
  const literal = parseLiteral(text);
  if (literal !== undefined) return literal;

  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return fail(text, EXPECTED);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail(text, EXPECTED);

  const host = url.hostname.toLowerCase();
  if (isNotionHost(host)) return notionFromUrl(text, url);
  if (host === 'docs.google.com' || host === 'drive.google.com') return googleFromUrl(text, url);
  return fail(text, EXPECTED);
}

/**
 * The literal-ref half of both parsers: a ref, an error when the scheme is a
 * known source but the id is malformed, or undefined when this is not a
 * literal ref at all and a URL is still worth trying.
 */
function parseLiteral(text: string): SourceRef | SourceRefError | undefined {
  const match = REF.exec(text.trim());
  if (!match) return undefined;
  const [, source = '', id = ''] = match;

  if (source === 'notion') {
    const canonical = canonicalNotionId(id);
    return canonical === undefined
      ? fail(text, NOTION_ID_SHAPE)
      : { source: 'notion', id: canonical };
  }
  if (source === 'gdocs') {
    // `<docId>` or `<docId>#<tabId>`, and nothing else: a second `#` is not a
    // ref at all (ticket 37).
    const [docId = '', tabId, ...rest] = id.split('#');
    if (!GOOGLE_ID.test(docId)) return fail(text, GOOGLE_ID_SHAPE);
    if (rest.length > 0) return fail(text, GOOGLE_TAB_SHAPE);
    if (tabId === undefined) return { source: 'gdocs', id: docId };
    return GOOGLE_TAB_ID.test(tabId)
      ? { source: 'gdocs', id: `${docId}#${tabId}` }
      : fail(text, GOOGLE_TAB_SHAPE);
  }
  return undefined;
}

/** Narrows a parse result to its failure case. */
export function isSourceRefError(value: SourceRef | SourceRefError): value is SourceRefError {
  return 'message' in value;
}

/**
 * Whether text is a literal source ref. The cheap test used by ignore-list
 * parsing (MANUAL §4) to tell a ref entry from a gitignore pattern. It agrees
 * with `parseSourceRef`, so a URL is not a source ref by this test.
 */
export function isSourceRef(text: string): boolean {
  return parseSourceRef(text) !== undefined;
}

/** The canonical text form of a ref, as stored in a manifest and in frontmatter. */
export function formatSourceRef(ref: SourceRef): string {
  return `${ref.source}:${ref.id}`;
}

/**
 * The path Google serves a native type from. The keys are Drive's own mime
 * types (`gdrive/walk.ts` names the same ones); anything else Drive holds is
 * a file, and a folder is a folder.
 */
const GOOGLE_PATHS: Record<string, string> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheets',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google-apps.drawing': 'drawings',
};

const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

/**
 * Where a person opens this object: the `url:` of the frontmatter (MANUAL §6),
 * and what an agent quotes in a report. Derived from the id alone, so it costs
 * no request and no index field. `mimeType` is what Drive reported for the
 * file; it decides nothing on Notion, whose bare-id URL redirects to the real
 * one, workspace slug and all.
 */
export function sourceUrl(ref: SourceRef, mimeType?: string): string {
  if (ref.source === 'notion') return `https://www.notion.so/${ref.id}`;
  if (mimeType === GOOGLE_FOLDER) return `https://drive.google.com/drive/folders/${ref.id}`;
  const { docId, tabId } = splitGDocsRef(ref);
  // Only a Google Doc has tabs, so a tab ref is one whatever Drive said the
  // file was — and the URL opens on that tab (MANUAL §6, ticket 37).
  if (tabId !== undefined) {
    return `https://docs.google.com/document/d/${docId}/edit?tab=${tabId}`;
  }
  const kind = mimeType === undefined ? undefined : GOOGLE_PATHS[mimeType];
  return kind === undefined
    ? `https://drive.google.com/file/d/${docId}/view`
    : `https://docs.google.com/${kind}/d/${docId}/edit`;
}

/** A `gdocs:` ref taken apart: the Doc, and the tab of it when it names one. */
export interface GDocsTarget {
  docId: string;
  /** The tab, for a ref of the form `gdocs:<docId>#<tabId>` (MANUAL §6). */
  tabId?: string;
}

/**
 * Splits a `gdocs:` ref into the Doc and the tab (ticket 37).
 *
 * The id is one token everywhere it is stored — frontmatter, the index, a
 * manifest — and this is the one place that takes it apart, so that nothing
 * else has to know that the separator is a `#`.
 */
export function splitGDocsRef(ref: SourceRef): GDocsTarget {
  const at = ref.id.indexOf('#');
  if (at === -1) return { docId: ref.id };
  return { docId: ref.id.slice(0, at), tabId: ref.id.slice(at + 1) };
}

/** The Doc a ref names, tab or no tab: what a manifest and an ignore list mean. */
export function docRefOf(ref: SourceRef): SourceRef {
  return { source: ref.source, id: splitGDocsRef(ref).docId };
}

/** The ref of one tab, or of the Doc itself when there is no tab to name. */
export function tabRef(docId: string, tabId: string | undefined): SourceRef {
  return { source: 'gdocs', id: tabId === undefined || tabId === '' ? docId : `${docId}#${tabId}` };
}

/** Whether two refs address the same object. */
export function sourceRefEquals(a: SourceRef, b: SourceRef): boolean {
  return a.source === b.source && a.id === b.id;
}
