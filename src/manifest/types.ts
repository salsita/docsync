import type { Document } from 'yaml';
import type { SourceRef } from '../source-ref.js';

/**
 * What a source object is, as far as the local layout is concerned.
 *
 * A `leaf` becomes one file; a `container` becomes a directory. Only a Drive
 * folder is a container: a Notion page is a document with or without children,
 * and its children go in the sibling directory of the same stem (MANUAL §6).
 */
export type Kind = 'leaf' | 'container';

/** One source ref checked out under one local path (MANUAL §4). */
export interface Root {
  src: SourceRef;
  /** Repo-relative, `/`-separated, NFC-normalised. A trailing `/` means directory. */
  path: string;
  /** gitignore patterns and source refs. Empty when the root has no ignore list. */
  ignore: string[];
}

/** A parsed manifest. */
export interface Manifest {
  version: 1;
  roots: Root[];
  /**
   * The YAML document this manifest was parsed from, when it was parsed from
   * text. `serializeManifest` writes through it so that the user's comments and
   * scalar styles survive `add` and `remove`. Not part of the manifest's value:
   * two manifests with equal `version` and `roots` mean the same thing.
   */
  doc?: Document;
}

/** One problem found in a manifest file, with the line it is on (1-based). */
export interface ManifestError {
  line: number;
  message: string;
}

/** The result of parsing a manifest: either a manifest or every error in the file. */
export type ParseResult = { ok: true; manifest: Manifest } | { ok: false; errors: ManifestError[] };
