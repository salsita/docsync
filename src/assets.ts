/**
 * Files the source hosts, on disk (MANUAL §6 "Layout", §12 phase 2).
 *
 * An image or a file inside a Notion page or a Google Doc becomes a real file
 * in `<title>.assets/` beside `<title>.md`, linked relatively from the body.
 * This module owns everything about that which is not a source's own business:
 * where the directory is, what a file in it is called, how the name stays the
 * same across fetches, what the link looks like, and what the index records.
 *
 * Pure and source-agnostic: no API, no disk, no downloads. `src/notion/assets.ts`
 * and `src/gdrive/assets.ts` do the fetching and the uploading and come here
 * for every decision either of them would otherwise have to make twice.
 */
import { createHash } from 'node:crypto';
import { parseDocument } from './frontmatter.js';
import type { DocumentIndex, IndexEntry } from './index-file.js';
import { assignNames, type Sibling } from './manifest/filenames.js';
import { PushError } from './push-types.js';
import type { FileChange } from './source.js';

/** What a document's assets directory is called, beside the document itself. */
export const ASSETS_SUFFIX = '.assets';

/** The extension a Markdown document takes. */
const MD = '.md';

/**
 * Which block a link becomes on Notion, by extension (MANUAL §6 dialect
 * table). An `![]()` link is an image whatever the extension says; everything
 * else is a `pdf`, a `video` or a plain `file`.
 */
export const MEDIA_EXTENSIONS = {
  pdf: new Set(['.pdf']),
  video: new Set(['.mp4', '.mov', '.avi', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpeg']),
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic', '.tif', '.tiff']),
} as const;

/** The extension a content type implies, for an object that has no name. */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/zip': '.zip',
};

/** The content type a file's extension implies, for an upload. */
const MIME_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);

/** What a file with this extension is uploaded as. */
export function mimeTypeOf(name: string, fallback = 'application/octet-stream'): string {
  return MIME_TYPES[extensionOf(name).toLowerCase()] ?? fallback;
}

/** `Specs/Auth.md` → `Specs/Auth.assets`. */
export function assetsDirOf(documentPath: string): string {
  return `${stemOf(documentPath)}${ASSETS_SUFFIX}`;
}

/** Whether a repo-relative path is a file inside some document's assets. */
export function isAssetPath(path: string): boolean {
  return documentOfAssetsDir(path) !== undefined;
}

/**
 * The document whose assets a path holds, or `undefined` when it holds none.
 * The inverse of `assetsDirOf`, and the one place that decides what counts:
 * a directory named `<stem>.assets` with at least one segment inside it.
 */
export function documentOfAssetsDir(path: string): string | undefined {
  const at = path.indexOf(`${ASSETS_SUFFIX}/`);
  if (at <= 0) return undefined;
  const directory = path.slice(0, at);
  // `.assets` has to be the whole of a path segment's tail, not a coincidence
  // inside a name: `Specs/assets/x` is somebody's own folder.
  const stem = directory.slice(directory.lastIndexOf('/') + 1);
  if (stem === '') return undefined;
  return `${directory}${MD}`;
}

/** The sha-256 of some bytes, hex, which is what the index records. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What one hosted file is called at the source, in the pieces a name takes. */
export interface NameHint {
  /** The source's own file name, where it has one (Notion's `name`). */
  name?: string;
  /** The URL it is served from, whose last segment is the next best thing. */
  url?: string;
  /** The content type, which is where an extension comes from when nothing else is. */
  contentType?: string;
  /** Position among the document's assets, 1-based: `image-3.png`. */
  position?: number;
}

/** A filename in the two pieces `assignNames` wants: a stem and an extension. */
export interface NameParts {
  title: string;
  /** Including the dot. Empty when nothing says what the file is. */
  ext: string;
}

/**
 * The name a hosted file wants on disk, before collisions are resolved: the
 * source's own name where it has one, the URL's last path segment where it
 * does not, and `image-<n>` from the content type for a Google Docs inline
 * object, which has neither (MANUAL §12).
 */
export function nameHintFor(hint: NameHint): NameParts {
  const raw = hint.name ?? lastSegmentOf(hint.url) ?? '';
  const fromType =
    hint.contentType === undefined ? '' : (EXTENSIONS[baseType(hint.contentType)] ?? '');
  if (raw === '') {
    return { title: `image-${hint.position ?? 1}`, ext: fromType };
  }
  const ext = extensionOf(raw);
  return ext === '' ? { title: raw, ext: fromType } : { title: raw.slice(0, -ext.length), ext };
}

/** One asset of a document, as the source describes it before it is named. */
export interface AssetHint extends NameHint {
  /** The source's id for it: a Notion block id, a Docs inline object id. */
  id: string;
}

/**
 * Where every asset of one document goes, keyed by source id.
 *
 * `previous` is the whole index of the last fetch. An asset keeps the name it
 * had for as long as its hint still derives to it, which is what keeps a
 * second fetch from rewriting a link, and the name is looked up by *id*, so
 * the assets of a document that moved follow it to the new directory.
 */
export function assignAssetNames(
  documentPath: string,
  hints: readonly AssetHint[],
  previous: Iterable<IndexEntry>,
): Map<string, string> {
  const directory = assetsDirOf(documentPath);
  const kept = new Map<string, string>();
  for (const entry of previous) {
    if (entry.type !== 'asset') continue;
    kept.set(entry.src.id, entry.path.slice(entry.path.lastIndexOf('/') + 1));
  }
  const siblings: Sibling[] = hints.map((hint) => {
    const { title, ext } = nameHintFor(hint);
    return { id: hint.id, title, ext };
  });
  const names = assignNames(siblings, kept);
  return new Map([...names].map(([id, name]) => [id, `${directory}/${name}`]));
}

/**
 * The link a document writes to one of its own assets: relative to the
 * document, with the characters a Markdown link cannot hold escaped, so that
 * `a photo.png` is one link and not a link followed by a word.
 */
export function linkToAsset(documentPath: string, assetPath: string): string {
  const from = documentPath.split('/').slice(0, -1).join('/');
  const relative = from === '' ? assetPath : assetPath.slice(from.length + 1);
  return relative.split('/').map(encodeSegment).join('/');
}

/**
 * The path a link in a document points at, when it points inside that
 * document's own assets directory; `undefined` for anything else — an absolute
 * URL, a link to another document, a path that climbs out of the checkout.
 */
export function resolveAssetPath(documentPath: string, url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURI(url);
  } catch {
    // A link with a stray `%` is not a path we wrote.
    return undefined;
  }
  const parts = documentPath.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const path = parts.join('/');
  return isAssetPath(path) ? path : undefined;
}

/** A path without its extension. */
export function stemOf(path: string): string {
  const ext = extensionOf(path);
  return ext === '' ? path : path.slice(0, -ext.length);
}

/** The extension of a filename, dot included, or `''` when it has none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/** The last path segment of a URL, unescaped, with any query left off. */
function lastSegmentOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const segment = path.slice(path.lastIndexOf('/') + 1);
  if (segment === '') return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `image/png; charset=x` is `image/png`. */
function baseType(contentType: string): string {
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** One path segment, escaped for a Markdown link destination. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll('%2F', '/');
}

/**
 * Every file in `<title>.assets/` one Markdown tree links, by repo-relative
 * path (MANUAL §12 phase 2). An image link and a plain link both count; an
 * absolute URL and a link to another document do not.
 */
export function assetLinksOf(nodes: readonly unknown[], documentPath: string): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly unknown[]): void => {
    for (const node of list) {
      if (typeof node !== 'object' || node === null) continue;
      const one = node as { type?: string; url?: string; children?: unknown[] };
      if ((one.type === 'image' || one.type === 'link') && typeof one.url === 'string') {
        const path = resolveAssetPath(documentPath, one.url);
        if (path !== undefined) out.add(path);
      }
      if (Array.isArray(one.children)) walk(one.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * A file deleted while the document still links it (MANUAL §12 phase 2).
 *
 * The link would point at nothing, and a push that let it through would leave
 * the page pointing at a file the checkout no longer has. It is refused before
 * anything is written, naming the path — as is the reverse case, a file
 * deleted for a document this push does not touch at all, which cannot have
 * dropped the link.
 */
export function refuseOrphanedLinks(
  assetChanges: readonly FileChange[],
  documentChanges: readonly FileChange[],
  index: DocumentIndex,
): void {
  const texts = new Map<string, string>();
  for (const change of documentChanges) {
    if (change.text !== undefined) texts.set(change.path, change.text);
  }
  const deletedDocuments = new Set(
    documentChanges.filter((one) => one.kind === 'deleted').map((one) => one.path),
  );

  for (const change of assetChanges) {
    if (change.kind !== 'deleted') continue;
    const document = index.get(change.path)?.document ?? documentOfAssetsDir(change.path) ?? '';
    if (deletedDocuments.has(document)) continue;
    const text = texts.get(document);
    if (text !== undefined) {
      const links = assetLinksOf(parseDocument(text).body.children, document);
      if (!links.has(change.path)) continue;
    }
    throw new PushError(
      `${change.path}: the file is gone but ${document} still links it; ` +
        'delete the link as well, or restore the file',
      change.path,
    );
  }
}
