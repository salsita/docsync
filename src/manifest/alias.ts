import { fileNameFor } from './filenames.js';
import type { Kind } from './types.js';
import { validatePath } from './validate.js';

/** What resolving a source ref at its source told us about the object. */
export interface ResolvedObject {
  title: string;
  kind: Kind;
  /**
   * The extension a leaf's own file takes, dot included. Defaults to `.md`,
   * which is right for a Notion page and a Google Doc; other Drive files bring
   * their own (MANUAL §6).
   */
  ext?: string;
}

/** Either the root path to store, or why the alias cannot produce one. */
export type AliasResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * Turns the `=<path>` alias of `docsync add` into the root path (MANUAL §5).
 *
 * A trailing slash means "under here, named by the source title"; no trailing
 * slash means "exactly this name". The resolved path is what the manifest
 * stores, so a later title change at the source does not move the root.
 *
 * Only a `container` — a Drive folder — becomes a directory. A Notion page is
 * a document whether or not it has children, since its children live in the
 * sibling directory of the same stem, so a page that gains one does not move.
 */
export function resolveAlias(alias: string | undefined, resolved: ResolvedObject): AliasResult {
  const ext = resolved.ext ?? '.md';
  const prefix = (alias ?? '').normalize('NFC');
  let path: string;

  if (prefix === '' || prefix.endsWith('/')) {
    const name =
      resolved.kind === 'leaf'
        ? fileNameFor(resolved.title, ext)
        : `${fileNameFor(resolved.title, '')}/`;
    path = `${prefix}${name}`;
  } else {
    const last = prefix.slice(prefix.lastIndexOf('/') + 1);
    // A leading dot is a hidden file, not an extension.
    const namesAFile = last.includes('.') && !last.startsWith('.');
    if (resolved.kind === 'container') {
      if (namesAFile) {
        return {
          ok: false,
          message: `"${prefix}" names a file, but a folder cannot be a file; drop the extension`,
        };
      }
      path = `${prefix}/`;
    } else {
      if (!namesAFile) {
        return {
          ok: false,
          message: `"${prefix}" needs an extension to name a document, or a trailing "/" to name the directory to put it in`,
        };
      }
      path = prefix;
    }
  }

  const message = validatePath(path);
  if (message !== undefined) return { ok: false, message };
  return { ok: true, path };
}
