import type { Root } from './types.js';

/** One problem with a root's path, and which root it is. */
export interface ValidationError {
  /** Index into the array passed to `validateRoots`. */
  rootIndex: number;
  path: string;
  message: string;
}

/** Whether a path names a directory (trailing `/`) or a single file (MANUAL §4). */
export function isDirectoryPath(path: string): boolean {
  return path.endsWith('/');
}

/**
 * The directory a root owns.
 *
 * For a directory root that is the path itself. For a file root it is the
 * sibling directory with the same stem: a leaf that later gains children keeps
 * its file and puts the children in `<stem>/` (MANUAL §5), so the two together
 * are the root's territory.
 */
export function territoryOf(path: string): string {
  const normalized = path.normalize('NFC');
  if (isDirectoryPath(normalized)) return normalized.slice(0, -1);
  const cut = normalized.lastIndexOf('.');
  const slash = normalized.lastIndexOf('/');
  return cut > slash + 1 ? normalized.slice(0, cut) : normalized;
}

/**
 * Checks one path's syntax (MANUAL §4). Returns a message, or undefined if it is fine.
 */
export function validatePath(path: string): string | undefined {
  const normalized = path.normalize('NFC');
  if (normalized === '') return 'a path must not be empty';
  if (normalized.startsWith('/')) return 'a path must be relative, with no leading "/"';
  if (normalized.includes('\\')) return 'a path must not contain a backslash; always use "/"';

  const segments = normalized.split('/');
  // A trailing slash is the directory marker, not an empty segment.
  if (segments[segments.length - 1] === '') segments.pop();

  for (const segment of segments) {
    if (segment === '') return 'a path must not contain an empty segment';
    if (segment === '.') return 'a path must not contain a "." segment';
    if (segment === '..') return 'a path must not contain a ".." segment';
    if (segment.startsWith('.')) return 'a path segment must not start with a dot';
  }

  if (!isDirectoryPath(normalized)) {
    const last = segments[segments.length - 1] ?? '';
    // `.` at position 0 was rejected above, so any dot here starts a real extension.
    if (!last.includes('.')) {
      return 'a file root needs an extension; add one, or a trailing "/" for a directory';
    }
  }
  return undefined;
}

/**
 * Checks every root's path and every pair of roots for overlap (MANUAL §4).
 *
 * Returns all errors, in root order. Comparison is case-insensitive because
 * macOS and Windows are, and NFC-insensitive because macOS decomposes.
 * A root with a bad path is not compared against the others.
 */
export function validateRoots(roots: readonly Root[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const checked: Array<{ index: number; path: string; key: string; territory: string }> = [];

  roots.forEach((root, index) => {
    const message = validatePath(root.path);
    if (message !== undefined) {
      errors.push({ rootIndex: index, path: root.path, message });
      return;
    }

    const path = root.path.normalize('NFC');
    const key = path.toLowerCase();
    const territory = territoryOf(path).toLowerCase();
    const bare = key.endsWith('/') ? key.slice(0, -1) : key;

    for (const other of checked) {
      if (other.key === key) {
        errors.push({
          rootIndex: index,
          path: root.path,
          message:
            other.path === path
              ? `duplicate path "${root.path}"`
              : `paths "${other.path}" and "${root.path}" differ only in case`,
        });
        break;
      }
      const otherBare = other.key.endsWith('/') ? other.key.slice(0, -1) : other.key;
      if (isUnder(bare, other.territory) || isUnder(otherBare, territory)) {
        errors.push({
          rootIndex: index,
          path: root.path,
          message: `path "${root.path}" overlaps "${other.path}"`,
        });
        break;
      }
    }

    checked.push({ index, path, key, territory });
  });

  return errors;
}

/** Whether `path` sits strictly inside the directory `dir`, comparing whole segments. */
function isUnder(path: string, dir: string): boolean {
  return path.length > dir.length + 1 && path.startsWith(`${dir}/`);
}
