/**
 * The images a Google Doc holds (MANUAL §6, §12 phase 2).
 *
 * Docs keeps an inline image as an object with a `contentUri` that is
 * authenticated and lives about half an hour, so, like Notion's, it is
 * worthless in a checkout: the bytes go on disk in `<title>.assets/` and the
 * body links them. This module is the half of that which knows about Docs;
 * `src/assets.ts` decides where each file goes and what it is called.
 *
 * Docs stamps no time on an object, so there is nothing to compare but the
 * bytes. The rule of MANUAL §12 follows from that: the images of a **changed**
 * document are downloaded and compared by checksum, and the file is rewritten
 * only when they differ; a document that did not change downloads nothing at
 * all.
 */
import { type AssetHint, assignAssetNames, checksumOf } from '../assets.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { FetchedFile } from '../source.js';
import type { DocsDocument, GDriveApi, ParagraphElement, StructuralElement } from './api.js';

/** What one document's images came to: the files to write, and the links. */
export interface DocumentAssets {
  files: FetchedFile[];
  /** Repo-relative asset path by inline object id, for `to-markdown.ts`. */
  links: Map<string, string>;
}

/**
 * The inline objects of a document that are images, in document order.
 *
 * Order matters: it is what `image-<n>` counts, so the name of an image does
 * not depend on how a JSON map happened to be keyed.
 */
export function imageObjects(doc: DocsDocument): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const element = (one: ParagraphElement): void => {
    const id = one.inlineObjectElement?.inlineObjectId;
    if (id === undefined || seen.has(id)) return;
    const embedded = doc.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject;
    if (embedded?.imageProperties === undefined) return;
    seen.add(id);
    out.push(id);
  };
  const content = (elements: readonly StructuralElement[] | undefined): void => {
    for (const structural of elements ?? []) {
      for (const one of structural.paragraph?.elements ?? []) element(one);
      for (const row of structural.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) content(cell.content);
      }
    }
  };

  content(doc.body?.content);
  for (const footnote of Object.values(doc.footnotes ?? {})) content(footnote.content);
  return out;
}

/** The `contentUri` of one inline image, when the document has one. */
export function contentUriOf(doc: DocsDocument, objectId: string): string | undefined {
  const properties =
    doc.inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject?.imageProperties;
  const uri = (properties as { contentUri?: unknown } | undefined)?.contentUri;
  return typeof uri === 'string' ? uri : undefined;
}

/**
 * The asset entries of a document nobody read this time: the ones the last
 * fetch left, moved to wherever the document is now.
 *
 * A document whose modified time did not move downloads nothing (MANUAL §12
 * phase 2), so its files are carried into the new commit by the blobs the last
 * one already holds.
 */
export function keptAssets(previous: DocumentIndex, documentPath: string): FetchedFile[] {
  const out: FetchedFile[] = [];
  for (const entry of previous.values()) {
    if (entry.type !== 'asset' || entry.document !== documentPath) continue;
    out.push({ path: entry.path, entry, changed: false });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Every image of one document, downloaded and compared.
 *
 * `previous` is the index of the last fetch, whole: an image is found in it by
 * its **object id**, so it keeps its name when the document is renamed and its
 * blob when the bytes are the ones already checked out.
 */
export async function fetchDocumentAssets(
  api: GDriveApi,
  doc: DocsDocument,
  documentPath: string,
  previous: DocumentIndex,
): Promise<DocumentAssets> {
  const objects = imageObjects(doc);
  if (objects.length === 0) return { files: [], links: new Map() };

  const known = new Map<string, IndexEntry>();
  for (const entry of previous.values()) {
    if (entry.type === 'asset' && entry.src.source === 'gdocs') known.set(entry.src.id, entry);
  }

  // Docs has no name and no time for an object, so the bytes have to be read
  // before the file can even be named: the content type is the only thing that
  // says what it is.
  const downloaded: { id: string; bytes: Uint8Array; contentType: string }[] = [];
  for (const id of objects) {
    const uri = contentUriOf(doc, id);
    if (uri === undefined) continue;
    const { bytes, contentType } = await api.downloadUri(uri);
    downloaded.push({ id, bytes, contentType });
  }

  const hints: AssetHint[] = downloaded.map((one, at) => ({
    id: one.id,
    contentType: one.contentType,
    position: at + 1,
  }));
  const names = assignAssetNames(documentPath, hints, known.values());

  const files: FetchedFile[] = [];
  const links = new Map<string, string>();
  for (const one of downloaded) {
    const path = names.get(one.id);
    if (path === undefined) continue;
    const checksum = checksumOf(one.bytes);
    const was = known.get(one.id);
    // Same bytes in the same place is the same file: the commit keeps the blob
    // it already has, and the diff stays quiet.
    const changed = was === undefined || was.path !== path || was.checksum !== checksum;
    const entry: IndexEntry = {
      path,
      src: { source: 'gdocs', id: one.id },
      type: 'asset',
      // Docs stamps no time on an inline object; the checksum is the identity.
      lastEditedTime: '',
      document: documentPath,
      checksum,
    };
    files.push(
      changed ? { path, bytes: one.bytes, entry, changed: true } : { path, entry, changed: false },
    );
    links.set(one.id, path);
  }
  return { files, links };
}
