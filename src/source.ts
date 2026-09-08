/**
 * What a document store looks like from the outside: two functions, and a
 * table from a source name to them.
 *
 * The remote helper (ticket 09) and the CLI (ticket 10) drive Notion and Drive
 * through this one vocabulary and never learn which is which. The shared
 * shapes — what a fetch answers, what a push takes — live here rather than in
 * either adapter, so that neither module has to import the other and a third
 * source is a third row in the table.
 *
 * The adapters keep their own re-exports of these types, narrowed where the
 * adapter is more specific (a Notion file always has text; a Drive one may
 * have bytes instead).
 */
import type { CredentialProvider } from './auth/index.js';
import type { BlockCounts } from './diff/blocks.js';
import {
  describe as describeDrive,
  changedSince as driveChangedSince,
  fetchRoot as fetchDriveRoot,
  pushRoot as pushDriveRoot,
} from './gdrive/index.js';
import type { DocumentIndex, Editor, IndexEntry } from './index-file.js';
import type { Kind, Root } from './manifest/types.js';
import {
  describe as describeNotion,
  fetchRoot as fetchNotionRoot,
  changedSince as notionChangedSince,
  pushRoot as pushNotionRoot,
} from './notion/index.js';
import type { Source as SourceName, SourceRef } from './source-ref.js';

/** One file a fetch produced, ready to be written into a commit. */
export interface FetchedFile {
  /** Repo-relative, `/`-separated. */
  path: string;
  /** A Markdown document: frontmatter and body. Absent for a binary file. */
  text?: string;
  /** The body alone, for a caller that has its own frontmatter to write. */
  body?: string;
  /** A binary or an export, as bytes. Absent for a Markdown document. */
  bytes?: Uint8Array;
  /**
   * What the index records about this path. Absent for a file that is not a
   * document of its own: the comment sidecar (MANUAL §6), which is written into
   * the commit like any other file but has no identity to record.
   */
  entry?: IndexEntry;
  editor?: Editor;
  /**
   * Whether the source's last-edit time — or, for a binary, its checksum —
   * differs from the one in the index the caller passed. A first fetch marks
   * everything changed, and content is present exactly when this is true.
   *
   * Under a re-fetch (`all`) every document is downloaded and converted again,
   * so this is true for all of them and what the commit holds is decided by
   * the bytes: a blob identical to the one the last commit already has is no
   * change at all (MANUAL §7).
   */
  changed: boolean;
  /**
   * Whether the source itself moved: the last-edit time, or a binary's
   * checksum. Only a re-fetch sets it, because only there can a file be
   * downloaded without the source having moved; absent means the same as
   * `changed`. It is what keeps the attribution of MANUAL §7 truthful — a
   * commit that exists only because the conversion changed is docsync's own.
   */
  sourceChanged?: boolean;
}

/** Something at the source that is not checked out, so a caller can say so. */
export interface SkippedObject {
  id: string;
  title: string;
  /** The path it would have taken. */
  path: string;
  reason: string;
}

/** What one root's fetch answers. */
export interface FetchResult {
  files: FetchedFile[];
  /** The index entries for this root, in the same order as `files`. */
  entries: IndexEntry[];
  skipped: SkippedObject[];
}

/** What git says happened to one file. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** One changed file, as the helper reads it out of the pushed commits. */
export interface FileChange {
  kind: ChangeKind;
  /** Repo-relative path, `/`-separated, as of after the change. */
  path: string;
  /** Where a renamed file came from. */
  previousPath?: string;
  /**
   * The whole file, frontmatter included. Absent for a deletion, and absent
   * for a rename whose content did not change — which is what makes such a
   * rename one API call and nothing more.
   */
  text?: string;
  /**
   * A binary file's bytes, in place of `text`. Drive roots hold files that are
   * not Markdown (MANUAL §6); a Notion root never does.
   */
  bytes?: Uint8Array;
  /**
   * The whole file as the served commit held it — the version this change is a
   * diff *from*. Present for a `modified` document and for a `renamed` one
   * whose content changed; absent for an addition, a deletion, a binary, and a
   * path the served tree did not hold. Diff-based write-back (MANUAL §7) needs
   * it: it is the base the live document must equal and the text the new one is
   * diffed against.
   */
  previousText?: string;
  /**
   * The bytes of the files in this document's `<title>.assets/`, as the pushed
   * tree holds them, by repo-relative path (MANUAL §12 phase 2).
   *
   * Present on an added or modified Markdown document that has any. A push
   * uploads a file the source does not have yet, and only the adapter can say
   * which those are, so it is given all of them — the ones this push changed
   * and the ones that were already there — rather than only the diff's.
   */
  assets?: ReadonlyMap<string, Uint8Array>;
}

/**
 * Where a fetch or a push says what it is doing while it runs (MANUAL §7).
 *
 * One plain line per event, no carriage returns and no colour, because it is
 * the helper's stderr: git relays it live, `docsync` relays git, and the same
 * text has to read the same in a terminal, in a log and in a transcript. The
 * helper passes its own `log`, so `git --quiet` — `option verbosity 0` — is
 * what silences it (MANUAL §9). Nothing here is stored: the report files are
 * the record.
 */
export type Progress = (line: string) => void;

/** The one option both halves of a `Source` take. */
export interface ProgressOptions {
  progress?: Progress;
}

/** What a fetch takes on top of that. */
export interface FetchOptions extends ProgressOptions {
  /**
   * Download and convert every document under the root again, whatever its
   * last-edit time says: `docsync fetch --all` (MANUAL §5, §7). What comes out
   * byte for byte as it already is is not a change, so a re-fetch of an
   * unchanged checkout writes no commit.
   */
  all?: boolean;
}

/** What a push did to one document, for the CLI to print. */
export interface PushedDocument {
  path: string;
  title: string;
  action: 'created' | 'updated' | 'renamed' | 'trashed' | 'suggested';
  /**
   * How much of the document the push touched, for an update that was applied
   * as a patch (MANUAL §7). Absent for a creation, a rename and a deletion, and
   * for a source that does not patch yet.
   */
  blocks?: BlockCounts;
  /**
   * Pending suggestions the push wrote over, by id (MANUAL §7). Google Docs
   * only: the API can neither accept nor reject one, so an edit inside a
   * suggested range resolves it by overwriting it.
   */
  suggestions?: string[];
  /**
   * How many suggestions the push made on this document (MANUAL §7). Only on a
   * `suggested` action: under a root with `suggest: true` a Google Doc is
   * patched in suggesting mode, so the body is untouched until the client
   * accepts.
   */
  suggested?: number;
  /** Files this push uploaded to the source (MANUAL §12 phase 2). */
  uploaded?: number;
  /**
   * Files it would not upload, with the reason: over the source's limit, or a
   * kind of file the source cannot hold. Never partially uploaded.
   */
  skippedFiles?: { path: string; reason: string }[];
}

export type PushReport = PushedDocument[];

/**
 * What one source object is, without checking anything out (MANUAL §5).
 *
 * This is what `docsync resolve` prints and what `docsync add` needs before it
 * can write a root: `title`, `kind` and `ext` are exactly the `ResolvedObject`
 * that `resolveAlias` turns into a path, so an alias and a description meet in
 * one place and neither adapter has to know about `=<path>`.
 */
export interface SourceDescription {
  /** The ref as the source canonicalised it. */
  ref: SourceRef;
  title: string;
  /** `leaf` becomes one file, `container` a directory (MANUAL §6). */
  kind: Kind;
  /** Documents directly inside it. Zero for a leaf. */
  childCount: number;
  /** The extension a leaf takes on disk, dot included. `.md` for a document. */
  ext?: string;
  editor?: Editor;
  /** ISO 8601, as the source reported it. */
  lastEditedTime: string;
}

/** One document store, as the helper and the CLI use it. */
export interface Source {
  /**
   * Everything one root holds. `previous` is the index of the whole checkout
   * as of the last fetch: it keeps filenames stable and is what "changed" is
   * measured against.
   */
  fetchRoot(
    root: Root,
    provider: CredentialProvider,
    previous: ReadonlyMap<string, IndexEntry>,
    options?: FetchOptions,
  ): Promise<FetchResult>;

  /**
   * One root's diff, applied. `index` is the checkout as of the last fetch,
   * which is how a deleted file finds the object to trash.
   */
  pushRoot(
    root: Root,
    changes: readonly FileChange[],
    provider: CredentialProvider,
    index: DocumentIndex,
    options?: ProgressOptions,
  ): Promise<PushReport>;

  /**
   * What one object is, from its metadata alone. `docsync resolve` prints it
   * and `docsync add` turns it into a path, both before there is a checkout to
   * fetch into.
   */
  describe(ref: SourceRef, provider: CredentialProvider): Promise<SourceDescription>;

  /**
   * The paths under `root` whose source metadata has moved since `previous`,
   * the index of the last fetch: what `docsync status` says is "changed at
   * source". Nothing is downloaded — only the listing every adapter already
   * walks. A path that appeared and one that is gone both count as moved.
   */
  changedSince(
    root: Root,
    provider: CredentialProvider,
    previous: DocumentIndex,
  ): Promise<string[]>;
}

/** The registry: one `Source` per source name. */
export type SourceRegistry = Record<SourceName, Source>;

/**
 * The one table. A root's `src.source` picks the adapter, which is the only
 * place in the helper where a source name means anything.
 */
export const sources: SourceRegistry = {
  notion: {
    fetchRoot: fetchNotionRoot,
    pushRoot: pushNotionRoot,
    describe: describeNotion,
    changedSince: notionChangedSince,
  },
  gdocs: {
    fetchRoot: fetchDriveRoot,
    pushRoot: pushDriveRoot,
    describe: describeDrive,
    changedSince: driveChangedSince,
  },
};

/** Every source name, sorted, for a message that has to list them. */
export const sourceNames: SourceName[] = Object.keys(sources).sort() as SourceName[];

export type { Kind, SourceName, SourceRef };
