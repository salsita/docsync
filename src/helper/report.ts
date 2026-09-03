/**
 * The two report files a run leaves behind: `$GIT_DIR/docsync/last-fetch.json`
 * and `$GIT_DIR/docsync/last-push.json` (ticket 10).
 *
 * Git relays the helper's stderr to the user line by line, which is right for
 * progress and useless for a structured report: by the time `docsync push`
 * wants to print what happened to each document, the helper is a child process
 * of git and its output has already been interleaved with git's own. So the
 * helper writes the report as JSON next to the repository, and the CLI reads
 * it back after the git command returns.
 *
 * Writing a report is never allowed to fail a run — the fetch or the push has
 * already happened by then — so every write swallows its error and every read
 * answers `undefined` when there is nothing usable to read.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Editor } from '../index-file.js';
import type { PushedDocument, SkippedObject } from '../source.js';

/** The directory inside `$GIT_DIR` that holds both reports. */
export const REPORT_DIR = 'docsync';
export const FETCH_REPORT = 'last-fetch.json';
export const PUSH_REPORT = 'last-push.json';

/** One document a fetch found changed at the source. */
export interface FetchedDocument {
  /** Repo-relative, `/`-separated. */
  path: string;
  /** The source's last-edit time, ISO 8601, as the source reported it. */
  lastEditedTime: string;
  editor?: Editor;
}

/** What the last fetch did, for `docsync fetch` and `docsync pull` to print. */
export interface FetchReport {
  /** When the fetch ran, ISO 8601. */
  at: string;
  changed: FetchedDocument[];
  skipped: SkippedObject[];
}

/** What the last push did, for `docsync push` to print (MANUAL §7, §8). */
export interface PushReportFile {
  at: string;
  /** Every root's `PushReport`, concatenated in manifest order. */
  documents: PushedDocument[];
  /** What the post-push fetch left out, so the CLI can say so. */
  skipped: SkippedObject[];
}

/** Both writers over one `GIT_DIR`, as the helper's deps take them. */
export interface ReportWriter {
  fetch(report: FetchReport): Promise<void>;
  push(report: PushReportFile): Promise<void>;
}

async function write(gitDir: string, name: string, report: unknown): Promise<void> {
  try {
    const directory = join(gitDir, REPORT_DIR);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    // A report is a convenience. A repository that cannot hold one — a read-only
    // `$GIT_DIR`, a race with another run — must not turn a good fetch into a
    // failure, so this is the one place in the helper that swallows an error.
  }
}

async function read<T>(gitDir: string, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(join(gitDir, REPORT_DIR, name), 'utf8')) as T;
  } catch {
    // No report yet, or one written by a version that spelled it differently.
    return undefined;
  }
}

export async function writeFetchReport(gitDir: string, report: FetchReport): Promise<void> {
  return write(gitDir, FETCH_REPORT, report);
}

export async function writePushReport(gitDir: string, report: PushReportFile): Promise<void> {
  return write(gitDir, PUSH_REPORT, report);
}

export async function readFetchReport(gitDir: string): Promise<FetchReport | undefined> {
  return read<FetchReport>(gitDir, FETCH_REPORT);
}

export async function readPushReport(gitDir: string): Promise<PushReportFile | undefined> {
  return read<PushReportFile>(gitDir, PUSH_REPORT);
}

/** The writer the helper hands to a run, bound to that run's `GIT_DIR`. */
export function createReportWriter(gitDir: string): ReportWriter {
  return {
    fetch: (report) => writeFetchReport(gitDir, report),
    push: (report) => writePushReport(gitDir, report),
  };
}
