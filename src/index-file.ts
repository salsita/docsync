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
export type DocumentType = 'notion-page' | 'gdoc' | 'drive-file';

/** One checked-out document. */
export interface IndexEntry {
  /** Repo-relative, `/`-separated. The key: one document per path. */
  path: string;
  src: SourceRef;
  type: DocumentType;
  /** The source's last-edit time, ISO 8601, as the source reported it. */
  lastEditedTime: string;
}

/** The index as the helper holds it while it works: entries by path. */
export type DocumentIndex = ReadonlyMap<string, IndexEntry>;
