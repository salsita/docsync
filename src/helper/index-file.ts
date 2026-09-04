/**
 * `.docsync/index.yaml` as text: what the helper writes into every commit and
 * reads back out of the last one (MANUAL §6).
 *
 * The types live in `src/index-file.ts`, where the adapters found them; this
 * module is the file itself. The text is stable — entries sorted by path,
 * fields in one order — so that an index written twice for the same checkout
 * is the same blob, and a diff of it reads as a diff of the checkout.
 */
import { parse as parseYaml, Scalar, stringify as stringifyYaml } from 'yaml';
import type { DocumentIndex, DocumentType, IndexEntry } from '../index-file.js';
import { formatSourceRef, parseSourceRef, type SourceRef } from '../source-ref.js';

export type { DocumentIndex, DocumentType, Editor, IndexEntry } from '../index-file.js';

/** Where the index lives in the tree, repo-relative. */
export const INDEX_PATH = '.docsync/index.yaml';

const TYPES: ReadonlySet<string> = new Set<DocumentType>([
  'notion-page',
  'gdoc',
  'drive-file',
  'asset',
]);

function quoted(text: string): Scalar {
  const scalar = new Scalar(text);
  scalar.type = Scalar.QUOTE_SINGLE;
  return scalar;
}

/** The index as YAML: a list of mappings, sorted by path. */
export function serializeIndex(entries: Iterable<IndexEntry>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rows = sorted.map((entry) => ({
    path: entry.path,
    src: formatSourceRef(entry.src),
    type: entry.type,
    lastEditedTime: entry.lastEditedTime,
    ...(entry.readOnly === undefined ? {} : { readOnly: entry.readOnly }),
    // Quoted: an MD5 that happens to be all digits would otherwise read back
    // as a number.
    ...(entry.md5 === undefined ? {} : { md5: quoted(entry.md5) }),
    ...(entry.suggested === undefined ? {} : { suggested: entry.suggested }),
    // An asset belongs to a document and is compared by its bytes (MANUAL §12).
    ...(entry.document === undefined ? {} : { document: entry.document }),
    // Quoted for the same reason an MD5 is: a hex digest can be all digits.
    ...(entry.checksum === undefined ? {} : { checksum: quoted(entry.checksum) }),
  }));
  // `lineWidth: 0` so that a long path is never folded onto a second line.
  return stringifyYaml(rows, { lineWidth: 0 });
}

/**
 * An asset's `src` names the object inside its document, not a file: Notion
 * gives a block id, Google Docs an inline object id such as `kix.237gfdkhknqt`,
 * which is no file id at all. Only the source has to be one docsync knows.
 */
function parseAssetRef(text: string): SourceRef | undefined {
  const match = /^(notion|gdocs):(\S+)$/.exec(text.trim());
  return match === null
    ? undefined
    : { source: match[1] as SourceRef['source'], id: match[2] ?? '' };
}

function fail(what: string): never {
  throw new Error(`${INDEX_PATH}: ${what}`);
}

/** The index as the helper holds it, keyed by path. Throws on a malformed file. */
export function parseIndex(text: string): DocumentIndex {
  const parsed: unknown = text.trim() === '' ? [] : parseYaml(text);
  if (!Array.isArray(parsed)) return fail('expected a list of entries');

  const entries = new Map<string, IndexEntry>();
  for (const [at, row] of (parsed as unknown[]).entries()) {
    const where = `entry ${at + 1}`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      fail(`${where} is not a mapping`);
    }
    const fields = row as Record<string, unknown>;
    const path = fields.path;
    if (typeof path !== 'string') fail(`${where}: path must be a string`);
    if (typeof fields.type !== 'string' || !TYPES.has(fields.type)) {
      fail(`${where}: type must be one of ${[...TYPES].join(', ')}`);
    }
    const src =
      typeof fields.src === 'string'
        ? fields.type === 'asset'
          ? parseAssetRef(fields.src)
          : parseSourceRef(fields.src)
        : undefined;
    if (src === undefined) fail(`${where}: src must be a source ref`);
    if (typeof fields.lastEditedTime !== 'string') {
      fail(`${where}: lastEditedTime must be a string`);
    }
    if (fields.readOnly !== undefined && typeof fields.readOnly !== 'boolean') {
      fail(`${where}: readOnly must be true or false`);
    }
    if (fields.md5 !== undefined && typeof fields.md5 !== 'string') {
      fail(`${where}: md5 must be a string`);
    }
    if (fields.suggested !== undefined && typeof fields.suggested !== 'boolean') {
      fail(`${where}: suggested must be true or false`);
    }
    if (fields.document !== undefined && typeof fields.document !== 'string') {
      fail(`${where}: document must be a string`);
    }
    if (fields.checksum !== undefined && typeof fields.checksum !== 'string') {
      fail(`${where}: checksum must be a string`);
    }
    entries.set(path, {
      path,
      src,
      type: fields.type as DocumentType,
      lastEditedTime: fields.lastEditedTime,
      ...(fields.readOnly === undefined ? {} : { readOnly: fields.readOnly }),
      ...(fields.md5 === undefined ? {} : { md5: fields.md5 }),
      ...(fields.suggested === undefined ? {} : { suggested: fields.suggested }),
      ...(fields.document === undefined ? {} : { document: fields.document }),
      ...(fields.checksum === undefined ? {} : { checksum: fields.checksum }),
    });
  }
  return entries;
}
