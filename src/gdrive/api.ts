/**
 * The only part of the Drive adapter that talks to Google.
 *
 * Two endpoints, plain `fetch`, no SDK (ticket 07): Drive v3 lists, downloads
 * and exports files, Docs v1 reads a Google Doc's document model. Everything
 * above it (`walk.ts`, `to-markdown.ts`) sees plain recorded JSON, which is why
 * those modules are tested entirely on the fixtures in `__fixtures__/` and
 * never open a socket.
 *
 * The types below spell the slice of the two APIs this adapter is written
 * against, in the shape the fixtures record. They are deliberately partial:
 * fields we do not read are simply absent, and every one we do read is
 * optional, because a document written by another editor can leave any of them
 * out.
 */

export const DRIVE_ENDPOINT = 'https://www.googleapis.com/drive/v3';
export const DOCS_ENDPOINT = 'https://docs.googleapis.com/v1';
/** Uploads have their own host; the metadata endpoints will not take bytes. */
export const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3';

/** A Google Doc's mime type, which is what `files.create` is told to make. */
export const DOCUMENT_MIME = 'application/vnd.google-apps.document';

/** A Drive folder's mime type. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** What a binary with no mime type of its own is uploaded as. */
export const DEFAULT_UPLOAD_MIME = 'application/octet-stream';

/** How many times a throttled or failed request is retried. */
const MAX_RETRIES = 3;

/** Backoff used when Google does not say how long to wait. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * The `files.list` field mask (ticket 07 decisions): identity, the change
 * detection metadata, and who to credit the fetch commit to. Asking for less
 * than `*` keeps the listing small and the fixtures readable.
 */
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,lastModifyingUser,md5Checksum,size';

/** Whoever last touched a file, as Drive reports them. */
export interface DriveUser {
  displayName?: string;
  emailAddress?: string;
  permissionId?: string;
}

/** One Drive file or folder, with the fields `FILE_FIELDS` asks for. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** ISO 8601. The change detector (ticket 07 decisions). */
  modifiedTime?: string;
  lastModifyingUser?: DriveUser;
  /** Binaries only; Google's own types have no checksum. */
  md5Checksum?: string;
  size?: string;
}

/** A colour, as every Docs style spells one. Read only to be ignored. */
export interface OptionalColor {
  color?: { rgbColor?: { red?: number; green?: number; blue?: number } };
}

/** The character-level styling of one text run. */
export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  weightedFontFamily?: { fontFamily?: string; weight?: number };
  link?: { url?: string; bookmarkId?: string; headingId?: string };
  foregroundColor?: OptionalColor;
  backgroundColor?: OptionalColor;
  fontSize?: { magnitude?: number; unit?: string };
}

export interface TextRun {
  content?: string;
  textStyle?: TextStyle;
  /**
   * Pending suggestions on the run, present only when the document was asked
   * for with them inline. A run carrying insertion ids is not in the version
   * the suggestion was made against; one carrying deletion ids still is
   * (MANUAL §7).
   */
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
}

/** One piece of a paragraph. Exactly one field is set. */
export interface ParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: TextRun;
  /** A manual page break, which sits *inside* a paragraph. */
  pageBreak?: { textStyle?: TextStyle };
  horizontalRule?: { textStyle?: TextStyle };
  footnoteReference?: { footnoteId?: string; footnoteNumber?: string };
  inlineObjectElement?: { inlineObjectId?: string; textStyle?: TextStyle };
  /** Equations, columns breaks and person chips, none of which we can carry. */
  equation?: Record<string, unknown>;
  columnBreak?: Record<string, unknown>;
  person?: Record<string, unknown>;
  richLink?: Record<string, unknown>;
}

export interface Paragraph {
  elements?: ParagraphElement[];
  paragraphStyle?: { namedStyleType?: string; headingId?: string };
  /** Present exactly when the paragraph is a list item. */
  bullet?: { listId?: string; nestingLevel?: number; textStyle?: TextStyle };
}

export interface TableCell {
  startIndex?: number;
  endIndex?: number;
  content?: StructuralElement[];
  tableCellStyle?: { rowSpan?: number; columnSpan?: number };
}

export interface TableRow {
  startIndex?: number;
  endIndex?: number;
  tableCells?: TableCell[];
}

export interface Table {
  rows?: number;
  columns?: number;
  tableRows?: TableRow[];
}

/** One element of a body, a footnote or a table cell. One field is set. */
export interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: Table;
  tableOfContents?: Record<string, unknown>;
  sectionBreak?: Record<string, unknown>;
}

/** How one nesting level of a list is drawn. What tells the three lists apart. */
export interface NestingLevel {
  /** `●`, `○`, `■` … for a bullet list. Absent on the others. */
  glyphSymbol?: string;
  /** `DECIMAL`, `ALPHA`, `UPPER_ROMAN` … for a numbered list. */
  glyphType?: string;
  /** `%0.` for a numbered list, a bare `%0` for a checklist. */
  glyphFormat?: string;
  startNumber?: number;
}

export interface DocsList {
  listProperties?: { nestingLevels?: NestingLevel[] };
}

export interface Footnote {
  footnoteId?: string;
  content?: StructuralElement[];
}

export interface InlineObject {
  objectId?: string;
  inlineObjectProperties?: {
    embeddedObject?: {
      title?: string;
      description?: string;
      imageProperties?: Record<string, unknown>;
      embeddedDrawingProperties?: Record<string, unknown>;
    };
  };
}

/** A Google Doc, as `documents.get` answers it. */
export interface DocsDocument {
  documentId?: string;
  title?: string;
  body?: { content?: StructuralElement[] };
  lists?: Record<string, DocsList>;
  footnotes?: Record<string, Footnote>;
  inlineObjects?: Record<string, InlineObject>;
}

/** One `batchUpdate` request. The API's own JSON, not a wrapper. */
export type DocsWriteRequest = Record<string, unknown>;

/**
 * One reply to one request, in the same order. Only the one field this adapter
 * reads is spelled: a footnote's segment id, which nothing else can tell us.
 */
export interface DocsWriteReply {
  createFootnote?: { footnoteId?: string };
}

/** Whoever wrote a comment, as Drive reports them. */
export interface DriveCommentAuthor {
  displayName?: string;
  emailAddress?: string;
}

/** One reply inside a thread. `action` is set on a reply that only resolved it. */
export interface DriveReply {
  id?: string;
  createdTime?: string;
  author?: DriveCommentAuthor;
  content?: string;
  deleted?: boolean;
  action?: string;
}

/** One comment thread, as `comments.list` answers it with `fields=*`. */
export interface DriveComment {
  id?: string;
  createdTime?: string;
  author?: DriveCommentAuthor;
  content?: string;
  deleted?: boolean;
  resolved?: boolean;
  /** The text the comment is attached to. Absent on a whole-file comment. */
  quotedFileContent?: { mimeType?: string; value?: string };
  /** Drive's own anchor id, which the Docs document model does not spell. */
  anchor?: string;
  replies?: DriveReply[];
}

/** What `documents.get` does with pending suggestions. */
export type SuggestionsMode = 'preview' | 'inline';

/** The metadata half of a create or an update: what Drive calls a File. */
export interface FileMetadata {
  name?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
}

/** Where a file moves to, and what it moves out of. */
export interface MoveOptions {
  addParents?: string;
  removeParents?: string;
}

/** What `createGDriveApi` hands out. */
export interface GDriveApi {
  /** Every non-trashed child of a folder, across every page of results. */
  listFolder(id: string): Promise<DriveFile[]>;
  /** One file's metadata, with the same fields as a listing entry. */
  getFile(id: string): Promise<DriveFile>;
  /**
   * A Google Doc's document model. `mode` is what to do with pending
   * suggestions: leave them out, which is what a fetch wants, or bring them
   * inline, which is what a push needs to derive the version it diffs from
   * (MANUAL §7, ticket 16).
   */
  getDocument(id: string, mode?: SuggestionsMode): Promise<DocsDocument>;
  /**
   * Every comment thread on a file, replies included, deleted ones left out
   * (MANUAL §6). One request per document per fetch: a comment does not move
   * the document's last-edit time, so there is nothing cheaper to compare.
   */
  comments(id: string): Promise<DriveComment[]>;
  /** A binary file's bytes, as stored. */
  download(id: string): Promise<Uint8Array>;
  /**
   * The bytes behind a URI the Docs API handed us: an inline image's
   * `contentUri`, which is authenticated and good for about half an hour
   * (MANUAL §12 phase 2). The content type comes back with them, because it is
   * the only thing that says what the file is called.
   */
  downloadUri(uri: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** A Google-native file converted to `mimeType` (Sheets, Slides, Drawings). */
  export(id: string, mimeType: string): Promise<Uint8Array>;
  /** One document, one batch, one reply per request (MANUAL §7). */
  batchUpdate(documentId: string, requests: readonly DocsWriteRequest[]): Promise<DocsWriteReply[]>;
  /** A file with metadata and no content: a Doc, a folder. */
  createFile(metadata: FileMetadata): Promise<DriveFile>;
  /** A file's metadata, including a move (`addParents`) and the trash flag. */
  updateFile(id: string, metadata: FileMetadata, move?: MoveOptions): Promise<DriveFile>;
  /** A new revision of an existing file: same id, same sharing, same comments. */
  uploadRevision(id: string, bytes: Uint8Array, mimeType?: string): Promise<DriveFile>;
  /** A new file with content, metadata and bytes in one multipart request. */
  uploadFile(metadata: FileMetadata, bytes: Uint8Array, mimeType?: string): Promise<DriveFile>;
  /** A copy of a file. Used by the manual test, which never writes an original. */
  copyFile(id: string, metadata: FileMetadata): Promise<DriveFile>;
  /**
   * Shares a file, and answers the permission's id (MANUAL §12 phase 2).
   *
   * `insertInlineImage` takes a public URI and nothing else, so an image a
   * push inserts is world-readable for exactly as long as that one request
   * takes. `deletePermission` takes it back.
   */
  createPermission(id: string, permission: { type: string; role: string }): Promise<string>;
  /** Takes a share back. */
  deletePermission(id: string, permissionId: string): Promise<void>;
}

export interface GDriveApiOptions {
  /** Injected in tests. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected so the retry tests do not wait. Default: real time. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The API a real fetch talks to. `accessToken` is a token that is good now;
 * `CredentialProvider` renews it, and nothing here knows how.
 */
export function createGDriveApi(accessToken: string, options: GDriveApiOptions = {}): GDriveApi {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;

  /** One request, retried for as long as the policy allows. */
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
      });
      if (response.ok) return response;
      if (attempt >= MAX_RETRIES || !isRetryable(response.status))
        throw await failure(url, response);
      await sleep(retryAfterMs(response) ?? RETRY_DELAYS_MS[attempt] ?? 4000);
    }
  }

  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await (await call(url, init)).json()) as T;
  }

  async function bytes(url: string): Promise<Uint8Array> {
    return new Uint8Array(await (await call(url)).arrayBuffer());
  }

  /** A request whose body is JSON, which is every write but an upload. */
  function withJson(method: string, body: unknown): RequestInit {
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  /** The query every file write carries: what to answer with, and shared drives. */
  function fileQuery(extra: Record<string, string> = {}): string {
    return String(
      new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true', ...extra }),
    );
  }

  return {
    async listFolder(id) {
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({
          q: `'${id}' in parents and trashed=false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: '100',
          // Shared drives must work from day one (ticket 07 decisions).
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        if (pageToken !== undefined) query.set('pageToken', pageToken);
        const page = await json<{ files?: DriveFile[]; nextPageToken?: string }>(
          `${DRIVE_ENDPOINT}/files?${query}`,
        );
        files.push(...(page.files ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return files;
    },

    async getFile(id) {
      const query = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' });
      return json<DriveFile>(`${DRIVE_ENDPOINT}/files/${id}?${query}`);
    },

    async getDocument(id, mode = 'preview') {
      // Suggestions are never part of the body (MANUAL §6), so a fetch leaves
      // them out at the source rather than filtering them out afterwards. A
      // push asks for them inline: it has to know they are there, and it has
      // to see the document as it is to address it (ticket 16).
      const view = mode === 'inline' ? 'SUGGESTIONS_INLINE' : 'PREVIEW_WITHOUT_SUGGESTIONS';
      return json<DocsDocument>(`${DOCS_ENDPOINT}/documents/${id}?suggestionsViewMode=${view}`);
    },

    async comments(id) {
      const found: DriveComment[] = [];
      let pageToken: string | undefined;
      do {
        // `fields=*` is what makes Drive answer `quotedFileContent`, `resolved`
        // and `replies` at all; the default mask carries none of them.
        const query = new URLSearchParams({
          fields: '*',
          includeDeleted: 'false',
          pageSize: '100',
        });
        if (pageToken !== undefined) query.set('pageToken', pageToken);
        const page = await json<{ comments?: DriveComment[]; nextPageToken?: string }>(
          `${DRIVE_ENDPOINT}/files/${id}/comments?${query}`,
        );
        found.push(...(page.comments ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return found;
    },

    async download(id) {
      return bytes(`${DRIVE_ENDPOINT}/files/${id}?alt=media&supportsAllDrives=true`);
    },

    async downloadUri(uri) {
      const response = await call(uri);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() ?? '',
      };
    },

    async export(id, mimeType) {
      return bytes(`${DRIVE_ENDPOINT}/files/${id}/export?mimeType=${encodeURIComponent(mimeType)}`);
    },

    async batchUpdate(documentId, requests) {
      const answer = await json<{ replies?: DocsWriteReply[] }>(
        `${DOCS_ENDPOINT}/documents/${documentId}:batchUpdate`,
        withJson('POST', { requests }),
      );
      return answer.replies ?? [];
    },

    async createFile(metadata) {
      return json<DriveFile>(`${DRIVE_ENDPOINT}/files?${fileQuery()}`, withJson('POST', metadata));
    },

    async updateFile(id, metadata, move = {}) {
      const extra: Record<string, string> = {};
      if (move.addParents !== undefined) extra.addParents = move.addParents;
      if (move.removeParents !== undefined) extra.removeParents = move.removeParents;
      return json<DriveFile>(
        `${DRIVE_ENDPOINT}/files/${id}?${fileQuery(extra)}`,
        withJson('PATCH', metadata),
      );
    },

    async uploadRevision(id, content, mimeType = DEFAULT_UPLOAD_MIME) {
      return json<DriveFile>(
        `${UPLOAD_ENDPOINT}/files/${id}?${fileQuery({ uploadType: 'media' })}`,
        { method: 'PATCH', headers: { 'content-type': mimeType }, body: content },
      );
    },

    async uploadFile(metadata, content, mimeType = DEFAULT_UPLOAD_MIME) {
      const { body, contentType } = multipart(metadata, content, mimeType);
      return json<DriveFile>(`${UPLOAD_ENDPOINT}/files?${fileQuery({ uploadType: 'multipart' })}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });
    },

    async createPermission(id, permission) {
      const query = new URLSearchParams({ fields: 'id', supportsAllDrives: 'true' });
      const made = await json<{ id?: string }>(
        `${DRIVE_ENDPOINT}/files/${id}/permissions?${query}`,
        withJson('POST', permission),
      );
      return String(made.id ?? '');
    },

    async deletePermission(id, permissionId) {
      const query = new URLSearchParams({ supportsAllDrives: 'true' });
      await call(`${DRIVE_ENDPOINT}/files/${id}/permissions/${permissionId}?${query}`, {
        method: 'DELETE',
      });
    },

    async copyFile(id, metadata) {
      return json<DriveFile>(
        `${DRIVE_ENDPOINT}/files/${id}/copy?${fileQuery()}`,
        withJson('POST', metadata),
      );
    },
  };
}

/** The boundary of every multipart upload. Fixed, so a test can name it. */
export const UPLOAD_BOUNDARY = 'docsync-boundary';

/**
 * Metadata and bytes in one `multipart/related` body, which is how Drive takes
 * a new file with content in a single request.
 */
function multipart(
  metadata: FileMetadata,
  content: Uint8Array,
  mimeType: string,
): { body: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${UPLOAD_BOUNDARY}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n--${UPLOAD_BOUNDARY}\r\ncontent-type: ${mimeType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${UPLOAD_BOUNDARY}--\r\n`);
  const body = new Uint8Array(head.length + content.length + tail.length);
  body.set(head, 0);
  body.set(content, head.length);
  body.set(tail, head.length + content.length);
  return { body, contentType: `multipart/related; boundary=${UPLOAD_BOUNDARY}` };
}

/** Throttling and Google's own failures are worth another try; nothing else. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `Retry-After` in milliseconds, when the response carries a readable one. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** The error a failed request becomes: the status, the URL and Google's message. */
async function failure(url: string, response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    // A non-JSON body (an HTML error page, or bytes) says nothing more than the
    // status already does.
  }
  return new Error(`Google API ${response.status} on ${url}${detail === '' ? '' : `: ${detail}`}`);
}
