import makeIgnore from 'ignore';
import { parseSourceRef, type SourceRef, sourceRefEquals } from '../source-ref.js';
import type { Root } from './types.js';

/**
 * Whether one candidate document is excluded by its root's ignore list (MANUAL §4).
 *
 * `relPath` is the on-disk path relative to the root's directory, `/`-separated.
 * `ancestors` is the chain of objects between the root and the candidate, which
 * is what lets a source-ref entry ignore a whole subtree.
 *
 * The root object itself is never ignored, however the patterns are written:
 * unsubscribing from a root is `docsync remove`, not an ignore.
 */
export function isIgnored(
  root: Root,
  relPath: string,
  ref: SourceRef,
  ancestors: readonly SourceRef[] = [],
): boolean {
  const path = relPath.normalize('NFC');
  if (path === '' || path === '.') return false;
  if (sourceRefEquals(ref, root.src)) return false;

  const globs: string[] = [];
  const refs: SourceRef[] = [];
  for (const entry of root.ignore) {
    const parsed = parseSourceRef(entry);
    if (parsed) refs.push(parsed);
    else globs.push(entry);
  }

  // A ref entry is an identity, not a path, so no negation pattern can undo it.
  for (const ignored of refs) {
    if (sourceRefEquals(ref, ignored)) return true;
    if (ancestors.some((ancestor) => sourceRefEquals(ancestor, ignored))) return true;
  }

  if (globs.length === 0) return false;
  return makeIgnore().add(globs).ignores(path);
}
