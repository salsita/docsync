/**
 * What a push takes and what it answers, for every adapter (MANUAL §7, §8).
 *
 * These four types and the error started in `src/notion/push.ts` (ticket 06);
 * ticket 08 gave Drive a `pushRoot` of the same shape, so they live here and
 * both adapters import them. Ticket 09 drives both through this one vocabulary
 * and never has to know which source a root belongs to.
 */

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
}

/** What a push did to one document, for the CLI to print (ticket 10). */
export interface PushedDocument {
  path: string;
  title: string;
  action: 'created' | 'updated' | 'renamed' | 'trashed';
}

export type PushReport = PushedDocument[];

/** A file we cannot push, with the place in it that says why (MANUAL §7). */
export class PushError extends Error {
  readonly path: string | undefined;
  readonly line: number | undefined;

  constructor(message: string, path?: string, line?: number) {
    const where = path === undefined ? '' : ` (${path}${line === undefined ? '' : `:${line}`})`;
    super(`${message}${where}`);
    this.name = 'PushError';
    this.path = path;
    this.line = line;
  }
}
