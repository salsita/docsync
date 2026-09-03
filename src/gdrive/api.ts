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
  content?: StructuralElement[];
  tableCellStyle?: { rowSpan?: number; columnSpan?: number };
}

export interface TableRow {
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

/** What `createGDriveApi` hands out. */
export interface GDriveApi {
  /** Every non-trashed child of a folder, across every page of results. */
  listFolder(id: string): Promise<DriveFile[]>;
  /** One file's metadata, with the same fields as a listing entry. */
  getFile(id: string): Promise<DriveFile>;
  /** A Google Doc's document model, with suggestions left out. */
  getDocument(id: string): Promise<DocsDocument>;
  /** A binary file's bytes, as stored. */
  download(id: string): Promise<Uint8Array>;
  /** A Google-native file converted to `mimeType` (Sheets, Slides, Drawings). */
  export(id: string, mimeType: string): Promise<Uint8Array>;
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
  async function call(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) return response;
      if (attempt >= MAX_RETRIES || !isRetryable(response.status))
        throw await failure(url, response);
      await sleep(retryAfterMs(response) ?? RETRY_DELAYS_MS[attempt] ?? 4000);
    }
  }

  async function json<T>(url: string): Promise<T> {
    return (await (await call(url)).json()) as T;
  }

  async function bytes(url: string): Promise<Uint8Array> {
    return new Uint8Array(await (await call(url)).arrayBuffer());
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

    async getDocument(id) {
      // Suggestions are never part of the body (MANUAL §6), so they are left
      // out at the source rather than filtered out afterwards.
      return json<DocsDocument>(
        `${DOCS_ENDPOINT}/documents/${id}?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`,
      );
    },

    async download(id) {
      return bytes(`${DRIVE_ENDPOINT}/files/${id}?alt=media&supportsAllDrives=true`);
    },

    async export(id, mimeType) {
      return bytes(`${DRIVE_ENDPOINT}/files/${id}/export?mimeType=${encodeURIComponent(mimeType)}`);
    },
  };
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
