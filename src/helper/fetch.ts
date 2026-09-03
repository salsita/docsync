/**
 * A fetch, as one synthesized commit (MANUAL §7).
 *
 * Every root's `fetchRoot` is called with the index the last served commit
 * holds; what comes back is written into a tree — changed files as new
 * blobs, unchanged ones by the sha the last commit already has, so nothing is
 * downloaded twice — with `.docsync/index.yaml` beside them. If the tree
 * differs from the parent's, one commit is written: authored by the last
 * editor at their edit time, committed by docsync now, with one line per
 * changed path. Nothing here touches a ref or the working tree; that is the
 * caller's.
 */
import type { CredentialProvider } from '../auth/index.js';
import { isSidecarPath, sameButForFetched } from '../comments/format.js';
import type { Editor, IndexEntry } from '../index-file.js';
import type { Manifest } from '../manifest/types.js';
import type { FetchedFile, SkippedObject, SourceRegistry } from '../source.js';
import type { Git, Identity } from './git.js';
import { INDEX_PATH, parseIndex, serializeIndex } from './index-file.js';
import type { FetchReport, ReportWriter } from './report.js';
import { buildTree, type FileTree, readTree, type TreeFile } from './tree.js';

export interface FetchDeps {
  git: Git;
  sources: SourceRegistry;
  provider: CredentialProvider;
  /** Progress, one line at a time, for stderr. */
  log: (line: string) => void;
  now: () => Date;
  /**
   * Where a run's two report files go, so that `docsync fetch`, `pull` and
   * `push` can print what happened rather than parse git's relayed stderr
   * (ticket 10). Absent in a test that does not care.
   */
  report?: ReportWriter;
}

export interface FetchOutcome {
  /** The commit that now holds the source state: a new one, or `parent`. */
  commit: string;
  changed: boolean;
  /** What this fetch found, as `last-fetch.json` records it. */
  report: FetchReport;
}

/** Who commits a fetch. The author is the source's last editor. */
export const COMMITTER = { name: 'docsync', email: 'docsync@salsita.com' } as const;

/**
 * A fetched file that is a document of the checkout, so it has a last-edit time
 * and an editor to credit. A comment sidecar has neither (MANUAL §6).
 */
type Dated = FetchedFile & { entry: IndexEntry };

/**
 * Fetches every root of `manifest` on top of `parent`, the last served
 * commit, or from nothing when there is none yet.
 */
export async function fetchCommit(
  deps: FetchDeps,
  manifest: Manifest,
  parent: string | undefined,
): Promise<FetchOutcome> {
  const { git } = deps;
  const previousTree: FileTree = parent === undefined ? new Map() : await readTree(git, parent);
  const previousIndex = await readIndex(git, previousTree);

  const files = new Map<string, TreeFile>();
  const entries: IndexEntry[] = [];
  const changedDocuments: FetchReport['changed'] = [];
  const skipped: SkippedObject[] = [];
  /** The changed document the fetch commit is authored by, once it is found. */
  let latest: Dated | undefined;

  for (const root of manifest.roots) {
    const source = deps.sources[root.src.source];
    const result = await source.fetchRoot(root, deps.provider, previousIndex);
    const changed = result.files.filter((file) => file.changed && file.entry !== undefined).length;
    deps.log(`${root.src.source}: ${changed === 0 ? 'unchanged' : `${changed} changed`}`);

    for (const file of result.files) {
      files.set(file.path, { sha: await blobFor(git, file, previousTree) });
      // A comment sidecar is a file of the commit and not a document of the
      // checkout: it has no entry, no editor and no last-edit time (MANUAL §6).
      const entry = file.entry;
      if (!file.changed || entry === undefined) continue;
      changedDocuments.push({
        path: file.path,
        lastEditedTime: entry.lastEditedTime,
        ...(file.editor === undefined ? {} : { editor: file.editor }),
      });
      const dated = { ...file, entry };
      if (file.editor !== undefined && (latest === undefined || after(dated, latest))) {
        latest = dated;
      }
    }
    entries.push(...result.entries);
    skipped.push(...result.skipped);
  }
  files.set(INDEX_PATH, { sha: await git.hashObject(Buffer.from(serializeIndex(entries))) });

  const now = deps.now().toISOString();
  const report: FetchReport = { at: now, changed: changedDocuments, skipped };
  await deps.report?.fetch(report);

  const changedPaths = diff(previousTree, files);
  if (changedPaths.length === 0 && parent !== undefined) {
    return { commit: parent, changed: false, report };
  }
  const documents = changedPaths.filter((path) => path !== INDEX_PATH);

  const commit = await git.commitTree({
    tree: await buildTree(git, files),
    parents: parent === undefined ? [] : [parent],
    message: message(parent === undefined, documents),
    author: authorOf(latest, now),
    committer: { ...COMMITTER, date: now },
  });
  return { commit, changed: true, report };
}

/** The index the last commit holds, or an empty one when there is no commit. */
async function readIndex(git: Git, tree: FileTree) {
  const blob = tree.get(INDEX_PATH);
  if (blob === undefined) return new Map<string, IndexEntry>();
  return parseIndex((await git.catBlob(blob.sha)).toString('utf8'));
}

/** A changed file's new blob; an unchanged one's blob from the last commit. */
async function blobFor(git: Git, file: FetchedFile, previous: FileTree): Promise<string> {
  const kept = previous.get(file.path);
  // A sidecar is rebuilt on every fetch, because a comment moves no last-edit
  // time to compare (MANUAL §6). When only its `fetched:` line moved, the blob
  // the last commit has is kept, so a fetch that found nothing commits nothing.
  if (file.entry === undefined && kept !== undefined && file.text !== undefined) {
    const before = (await git.catBlob(kept.sha)).toString('utf8');
    if (sameButForFetched(before, file.text)) return kept.sha;
  }
  if (!file.changed) {
    if (kept === undefined) {
      throw new Error(
        `${file.path}: the source reports it unchanged, but the last fetch did not write it`,
      );
    }
    return kept.sha;
  }
  const content = file.text === undefined ? file.bytes : Buffer.from(file.text, 'utf8');
  if (content === undefined) {
    throw new Error(`${file.path}: the source reports it changed but sent no content`);
  }
  return git.hashObject(content);
}

/** Whether `a` was edited after `b`. Ties go to the one seen first. */
function after(a: Dated, b: Dated): boolean {
  return a.entry.lastEditedTime > b.entry.lastEditedTime;
}

/** Every path whose blob differs between two trees, sorted. */
function diff(before: FileTree, after: FileTree): string[] {
  const paths = new Set<string>();
  for (const [path, file] of after) if (before.get(path)?.sha !== file.sha) paths.add(path);
  for (const path of before.keys()) if (!after.has(path)) paths.add(path);
  return [...paths].sort();
}

/** `Add 3 documents` on the first commit, `Update …` after, one path per line. */
function message(first: boolean, paths: string[]): string {
  // A source can move a last-edit time without moving the content, which
  // changes the index and nothing else.
  if (paths.length === 0) return 'Update the index\n';
  const noun = paths.length === 1 ? 'document' : 'documents';
  // Nothing was edited: someone commented, or answered a comment (MANUAL §6).
  if (!first && paths.every((path) => isSidecarPath(path))) {
    return `Update comments on ${paths.length} ${noun}\n\n${paths.join('\n')}\n`;
  }
  const verb = first ? 'Add' : 'Update';
  return `${verb} ${paths.length} ${noun}\n\n${paths.join('\n')}\n`;
}

/**
 * The last editor of the most recently edited changed document that names
 * one, at their edit time; docsync itself when no changed document does.
 */
function authorOf(latest: Dated | undefined, now: string): Identity {
  const editor = latest?.editor;
  if (latest === undefined || editor === undefined) return { ...COMMITTER, date: now };
  return {
    name: editor.name ?? editor.id,
    email: editor.email ?? `${editor.id}@${latest.entry.src.source}`,
    date: latest.entry.lastEditedTime,
  };
}

export type { Editor };
