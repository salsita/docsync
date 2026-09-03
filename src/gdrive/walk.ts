/**
 * Root ref to file tree (MANUAL §4, §6).
 *
 * Drive gives the tree directly — a folder listing per folder — so this module
 * is mostly about deciding, for every file, what it becomes on disk: a Markdown
 * document, an export, bytes, or nothing. Along the way it decides every path,
 * with names from `src/manifest/`, so that collisions, hostile titles and
 * stable renaming are decided in exactly one place, and it drops what the
 * root's ignore list excludes.
 *
 * It lists; it does not download. `index.ts` fetches the content of what this
 * module found, which is what keeps a fetch that changes nothing cheap.
 */
import { assignNames, fileNameFor, isIgnored } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type { SourceRef } from '../source-ref.js';
import type { DriveFile, DriveUser, GDriveApi } from './api.js';

/** Drive's own type for a folder, which is a container and never a document. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCUMENT_MIME = 'application/vnd.google-apps.document';

/** Google-native types that are checked out as an export, and as what (MANUAL §6). */
export const EXPORTS: Record<string, { mimeType: string; ext: string }> = {
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx',
  },
  'application/vnd.google-apps.drawing': { mimeType: 'image/svg+xml', ext: '.svg' },
};

/** What a file becomes on disk. */
export type DriveKind = 'doc' | 'export' | 'binary';

/** One Drive file that will become one file in the checkout. */
export interface WalkedFile {
  id: string;
  ref: SourceRef;
  /** The Drive file name, which is the document's title (MANUAL §6). */
  title: string;
  /** Repo-relative path, `/`-separated. */
  path: string;
  kind: DriveKind;
  mimeType: string;
  /** What to ask `files.export` for. Exports only. */
  exportMimeType?: string;
  /** ISO 8601, as Drive reports it. Empty when Drive did not say. */
  modifiedTime: string;
  lastModifyingUser?: DriveUser;
  /** Binaries only; the cheap second half of change detection. */
  md5Checksum?: string;
}

/** Something under the root that is deliberately not checked out. */
export interface SkippedObject {
  id: string;
  title: string;
  /** The path it would have taken, so a report can name it. */
  path: string;
  /** `unsupported`: a Google type with no export. `ignored`: the ignore list. */
  reason: 'unsupported' | 'ignored';
}

export interface WalkResult {
  /** Every file to check out, in the order the walk found them. */
  files: WalkedFile[];
  skipped: SkippedObject[];
}

/**
 * Walks one root. `previous` maps a file id to the repo-relative path it had at
 * the last fetch, which is what keeps a name (`Notes (2).md`) attached to the
 * same file even when a sibling appears or disappears.
 */
export async function walkRoot(
  api: GDriveApi,
  root: Root,
  previous: ReadonlyMap<string, string> = new Map(),
): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const skipped: SkippedObject[] = [];

  const rootFile = await api.getFile(root.src.id);

  // A root that is one file is one document; a root that is a folder is a
  // directory holding its children (MANUAL §4).
  if (rootFile.mimeType !== FOLDER_MIME) {
    const kind = kindOf(rootFile.mimeType);
    const path = root.path.endsWith('/')
      ? `${root.path}${fileNameFor(rootFile.name, extensionFor(rootFile, kind))}`
      : root.path;
    if (kind === undefined) {
      skipped.push({ id: rootFile.id, title: rootFile.name, path, reason: 'unsupported' });
    } else {
      files.push(walkedFile(rootFile, kind, path));
    }
    return { files, skipped };
  }

  // Ignore patterns are relative to the root object (MANUAL §4), which for a
  // folder root is the directory the folder's children land in.
  const base = root.path.endsWith('/') ? root.path : `${root.path}/`;

  /**
   * Lists one folder, names its children, and walks the folders among them.
   * `ancestors` is the chain of folders between the root and this one, both
   * excluded, which is what lets a source-ref ignore entry exclude a subtree.
   * The root itself is never ignored (MANUAL §4), so it is never in the chain.
   */
  async function visit(id: string, directory: string, ancestors: readonly SourceRef[]) {
    const listing = await api.listFolder(id);
    const kinds = new Map(
      listing.map((file): [string, DriveKind | undefined] => [
        file.id,
        file.mimeType === FOLDER_MIME ? undefined : kindOf(file.mimeType),
      ]),
    );

    const names = assignNames(
      listing.map((file) => ({
        id: file.id,
        title: file.name,
        ext: file.mimeType === FOLDER_MIME ? '' : extensionFor(file, kinds.get(file.id)),
      })),
      namesIn(previous, directory),
    );

    for (const file of listing) {
      const name = names.get(file.id) ?? fileNameFor(file.name, '');
      const path = `${directory}${name}`;
      const ref: SourceRef = { source: 'gdocs', id: file.id };
      // A folder is matched as a directory, so that `Sub/` excludes it.
      const relative = path.slice(base.length) + (file.mimeType === FOLDER_MIME ? '/' : '');

      if (isIgnored(root, relative, ref, ancestors)) {
        skipped.push({ id: file.id, title: file.name, path, reason: 'ignored' });
        continue;
      }
      if (file.mimeType === FOLDER_MIME) {
        await visit(file.id, `${path}/`, [...ancestors, ref]);
        continue;
      }
      const kind = kinds.get(file.id);
      if (kind === undefined) {
        // A form, a site, a map, a shortcut: nothing to download and nothing to
        // export (ticket 07).
        skipped.push({ id: file.id, title: file.name, path, reason: 'unsupported' });
        continue;
      }
      files.push(walkedFile(file, kind, path));
    }
  }

  await visit(root.src.id, base, []);
  return { files, skipped };
}

/** What one Drive file becomes, or undefined when it becomes nothing. */
function kindOf(mimeType: string): DriveKind | undefined {
  if (mimeType === DOCUMENT_MIME) return 'doc';
  if (EXPORTS[mimeType] !== undefined) return 'export';
  // Every other Google-native type — forms, sites, maps, shortcuts, scripts —
  // has neither bytes to download nor a useful export.
  return mimeType.startsWith('application/vnd.google-apps.') ? undefined : 'binary';
}

/** The extension the file takes on disk. A binary carries its own. */
function extensionFor(file: DriveFile, kind: DriveKind | undefined): string {
  if (kind === 'doc') return '.md';
  if (kind === 'export') return EXPORTS[file.mimeType]?.ext ?? '';
  return '';
}

function walkedFile(file: DriveFile, kind: DriveKind, path: string): WalkedFile {
  const exported = EXPORTS[file.mimeType];
  return {
    id: file.id,
    ref: { source: 'gdocs', id: file.id },
    title: file.name,
    path,
    kind,
    mimeType: file.mimeType,
    ...(kind === 'export' && exported !== undefined ? { exportMimeType: exported.mimeType } : {}),
    modifiedTime: file.modifiedTime ?? '',
    ...(file.lastModifyingUser === undefined ? {} : { lastModifyingUser: file.lastModifyingUser }),
    ...(file.md5Checksum === undefined ? {} : { md5Checksum: file.md5Checksum }),
  };
}

/** The previous names of the files in one directory, by file id. */
function namesIn(
  previous: ReadonlyMap<string, string>,
  directory: string,
): Map<string, string> | undefined {
  const names = new Map<string, string>();
  for (const [id, path] of previous) {
    const cut = path.lastIndexOf('/') + 1;
    if (path.slice(0, cut) === directory) names.set(id, path.slice(cut));
  }
  return names.size === 0 ? undefined : names;
}
