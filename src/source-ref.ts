/**
 * Source refs address one object in one document store (MANUAL §1).
 *
 * This is the minimal version ticket 02 needs. Ticket 03 extends it with the
 * Notion and Drive URL forms that the manual accepts everywhere a ref is
 * accepted; until then only the literal `notion:<id>` / `gdocs:<id>` forms parse.
 */

/** A document store. */
export type Source = 'notion' | 'gdocs';

/** One object in one source. */
export interface SourceRef {
  source: Source;
  id: string;
}

const SOURCES: readonly string[] = ['notion', 'gdocs'];

// An id is anything non-empty without whitespace or a slash. Keeping slashes out
// is what lets an ignore list mix refs with gitignore patterns (MANUAL §4).
const REF = /^([a-z]+):([^\s/]+)$/;

/** Parses `notion:<id>` or `gdocs:<id>`. Returns undefined for anything else. */
export function parseSourceRef(text: string): SourceRef | undefined {
  const match = REF.exec(text);
  if (!match) return undefined;
  const [, source, id] = match;
  if (source === undefined || id === undefined) return undefined;
  if (!SOURCES.includes(source)) return undefined;
  return { source: source as Source, id };
}

/** The canonical text form of a ref, as stored in a manifest and in frontmatter. */
export function formatSourceRef(ref: SourceRef): string {
  return `${ref.source}:${ref.id}`;
}

/** Whether two refs address the same object. */
export function sourceRefEquals(a: SourceRef, b: SourceRef): boolean {
  return a.source === b.source && a.id === b.id;
}
