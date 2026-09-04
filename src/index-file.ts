/**
 * `.docsync/index.yaml`: what is checked out, by path (MANUAL §6).
 *
 * Only the type for now. Ticket 09 writes and reads the file; ticket 05 and
 * ticket 07 produce the entries, which is why the shape lives here rather than
 * inside either adapter.
 */
import type { SourceRef } from './source-ref.js';

/**
 * What kind of document a path holds. A Markdown document carries its identity
 * in its own frontmatter as well; a binary file has nowhere to put it, which is
 * what the index is for.
 */
export type DocumentType = 'notion-page' | 'gdoc' | 'drive-file' | 'asset';

/** One checked-out document. */
export interface IndexEntry {
  /** Repo-relative, `/`-separated. The key: one document per path. */
  path: string;
  src: SourceRef;
  type: DocumentType;
  /** The source's last-edit time, ISO 8601, as the source reported it. */
  lastEditedTime: string;
  /**
   * A push may not change this file: a Sheet, Slides or Drawing export, which
   * is a rendering of something the dialect cannot carry back (MANUAL §7).
   */
  readOnly?: boolean;
  /**
   * Drive's MD5 of a binary file's bytes. The second half of change detection
   * for files whose modified time can move without the content moving.
   */
  md5?: string;
  /**
   * Whether the document carried a pending suggestion at the last fetch (MANUAL
   * §6). A suggestion moves the document's last-edit time and a comment does
   * not, so this is what lets the next fetch know that an unchanged document
   * still owes a sidecar without downloading it to find out.
   */
  suggested?: boolean;
  /**
   * The document this file is an attachment of, repo-relative (MANUAL §12
   * phase 2). Set on an `asset` entry and on nothing else: it is what makes a
   * file in `<title>.assets/` belong to `<title>.md`, so a push knows which
   * document to patch and a rename takes the assets with it.
   */
  document?: string;
  /**
   * The sha-256 of an asset's bytes, hex. Change detection for a file the
   * source stamps no time on, and what says whether a push must upload.
   */
  checksum?: string;
}

/**
 * Who last edited a document, for the commit a fetch writes (MANUAL §7). Both
 * adapters answer this shape, so a caller credits a commit the same way
 * whether the document came from Notion or from Drive.
 */
export interface Editor {
  id: string;
  name?: string;
  email?: string;
}

/** The index as the helper holds it while it works: entries by path. */
export type DocumentIndex = ReadonlyMap<string, IndexEntry>;
