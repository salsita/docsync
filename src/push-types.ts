/**
 * What a push takes and what it answers, for every adapter (MANUAL §7, §8).
 *
 * These four types and the error started in `src/notion/push.ts` (ticket 06);
 * ticket 08 gave Drive a `pushRoot` of the same shape, so both adapters import
 * them from here. Ticket 09 moved the types themselves next to the `Source`
 * interface they are part of (`src/source.ts`); this module stays as the door
 * the adapters already use, and keeps `PushError`, which is a value.
 */
export type { ChangeKind, FileChange, PushedDocument, PushReport } from './source.js';

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
