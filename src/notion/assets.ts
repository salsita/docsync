/**
 * The files a Notion page hosts itself (MANUAL §6, §12 phase 2).
 *
 * Notion serves an uploaded image or file from a **signed URL that expires
 * after an hour**, so the URL is worthless in a checkout: the file itself has
 * to be on disk. This module is the half of that which knows about Notion —
 * which blocks hold a hosted file, when one is worth downloading again, and
 * how the bytes are read — while `src/assets.ts` decides where the file goes
 * and what it is called.
 *
 * What it never does is download something it already has. A block carries a
 * `last_edited_time`; if it has not moved and the index already names the file,
 * nothing goes on the wire (MANUAL §7).
 */
import { type AssetHint, assignAssetNames, checksumOf, mimeTypeOf } from '../assets.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import { PushError } from '../push-types.js';
import type { FetchedFile } from '../source.js';
import { DownloadError, type NotionApi, type NotionBlock, type RawObject } from './api.js';
import { bareId } from './to-markdown.js';

/** Block types that can hold a file, hosted or external (MANUAL §6). */
export const MEDIA_BLOCKS: ReadonlySet<string> = new Set(['image', 'file', 'pdf', 'video']);

/** Blocks that are documents of their own; their files are theirs, not ours. */
const OWN_FILE: ReadonlySet<string> = new Set(['child_page', 'child_database']);

/** What one page's assets came to: the files to write and the links to use. */
export interface PageAssets {
  /** One per hosted file, in document order. Bytes only on a changed one. */
  files: FetchedFile[];
  /** Repo-relative asset path by undashed block id, for `to-markdown.ts`. */
  links: Map<string, string>;
}

/** The body of a block: `block[block.type]`, whatever shape it has. */
function bodyOf(block: NotionBlock): RawObject {
  const body = block[block.type];
  return typeof body === 'object' && body !== null ? (body as RawObject) : {};
}

/**
 * The URL a block's file is served from, when Notion hosts it. A block whose
 * file is `external` is a link and stays one (MANUAL §6).
 */
export function hostedUrlOf(block: NotionBlock): string | undefined {
  const body = bodyOf(block);
  if (body.type !== 'file') return undefined;
  const file = body.file;
  if (typeof file !== 'object' || file === null) return undefined;
  const url = (file as RawObject).url;
  return typeof url === 'string' ? url : undefined;
}

/** Every block of a page that holds a file Notion hosts, in document order. */
export function hostedBlocks(blocks: readonly NotionBlock[]): NotionBlock[] {
  const out: NotionBlock[] = [];
  for (const block of blocks) {
    if (OWN_FILE.has(block.type)) continue;
    if (MEDIA_BLOCKS.has(block.type) && hostedUrlOf(block) !== undefined) out.push(block);
    if (block.children !== undefined) out.push(...hostedBlocks(block.children));
  }
  return out;
}

/**
 * The bytes behind one block, with the one retry an expiring URL deserves.
 *
 * A walk of a large page can take longer than the hour a signed URL is good
 * for, so a download that comes back refused is tried once more against the
 * block re-read from the API, which mints a fresh URL (MANUAL §12 phase 2).
 */
export async function downloadBlockFile(api: NotionApi, block: NotionBlock): Promise<Uint8Array> {
  const url = hostedUrlOf(block);
  if (url === undefined) throw new Error(`block ${block.id} hosts no file`);
  try {
    return await api.download(url);
  } catch (error) {
    if (!(error instanceof DownloadError)) throw error;
    const fresh = hostedUrlOf(await api.block(block.id));
    if (fresh === undefined || fresh === url) throw error;
    return api.download(fresh);
  }
}

/**
 * Every file one page hosts, as files to write and links to write them as.
 *
 * `previous` is the index of the last fetch, whole: an asset is found in it by
 * the *block id*, so the file keeps its name when the page is renamed and its
 * bytes when nothing about the block moved.
 */
export async function fetchPageAssets(
  api: NotionApi,
  page: { path: string; blocks: readonly NotionBlock[] },
  previous: DocumentIndex,
): Promise<PageAssets> {
  const blocks = hostedBlocks(page.blocks);
  if (blocks.length === 0) return { files: [], links: new Map() };

  const known = new Map<string, IndexEntry>();
  for (const entry of previous.values()) {
    if (entry.type === 'asset' && entry.src.source === 'notion') known.set(entry.src.id, entry);
  }

  const hints: AssetHint[] = blocks.map((block, at) => {
    const body = bodyOf(block);
    return {
      id: bareId(block.id),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(hostedUrlOf(block) === undefined ? {} : { url: hostedUrlOf(block) }),
      position: at + 1,
    };
  });
  const names = assignAssetNames(page.path, hints, known.values());

  const files: FetchedFile[] = [];
  const links = new Map<string, string>();
  for (const block of blocks) {
    const id = bareId(block.id);
    const path = names.get(id);
    if (path === undefined) continue;
    const was = known.get(id);
    const lastEditedTime = String(block.last_edited_time ?? '');
    // The block's time is what says the file moved; its URL says nothing,
    // because Notion signs a new one every hour (MANUAL §12 phase 2). A file
    // that changed place has to be written again wherever it landed.
    const changed = was === undefined || was.path !== path || was.lastEditedTime !== lastEditedTime;

    if (!changed) {
      files.push({ path, entry: { ...was, path }, changed: false });
      links.set(id, path);
      continue;
    }
    const bytes = await downloadBlockFile(api, block);
    files.push({
      path,
      bytes,
      entry: {
        path,
        src: { source: 'notion', id },
        type: 'asset',
        lastEditedTime,
        document: page.path,
        checksum: checksumOf(bytes),
      },
      changed: true,
    });
    links.set(id, path);
  }
  return { files, links };
}

/**
 * The largest file Notion will take, whatever the workspace plan allows above
 * it. A file over this is reported and skipped, never partially uploaded
 * (MANUAL §12 phase 2).
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

/** What one push's uploads came to. */
export interface UploadResult {
  /** The file upload id per repo-relative asset path. */
  uploads: Map<string, string>;
  /** What was not uploaded, and why. */
  skipped: { path: string; reason: string }[];
}

/**
 * Uploads the files a push has to point a block at (MANUAL §12 phase 2).
 *
 * A file over the limit, or one the source refuses, is reported and left
 * alone rather than failing the push: the rest of the document still goes.
 */
export async function uploadAssets(
  api: NotionApi,
  paths: Iterable<string>,
  bytesOf: ReadonlyMap<string, Uint8Array>,
  path: string,
): Promise<UploadResult> {
  const uploads = new Map<string, string>();
  const skipped: { path: string; reason: string }[] = [];
  for (const one of paths) {
    const bytes = bytesOf.get(one);
    if (bytes === undefined) {
      throw new PushError(
        `${one}: this link points at a file that is not in the checkout; add the file or remove the link`,
        path,
      );
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      skipped.push({ path: one, reason: `over Notion's ${MAX_UPLOAD_BYTES} byte limit` });
      continue;
    }
    const name = one.slice(one.lastIndexOf('/') + 1);
    try {
      uploads.set(one, await api.upload(name, bytes, mimeTypeOf(name)));
    } catch (error) {
      // Notion refuses a file the workspace plan has no room for. That is
      // one file's problem, not the document's.
      skipped.push({ path: one, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { uploads, skipped };
}

/**
 * The block body that points an existing media block at a new upload: the same
 * block, the same id, the same comments, a different file (MANUAL §7).
 */
export function fileUploadBody(type: string, uploadId: string, name: string): RawObject {
  return {
    [type]: {
      type: 'file_upload',
      file_upload: { id: uploadId },
      ...(type === 'image' ? {} : { name }),
    },
  };
}
