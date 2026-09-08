/**
 * Everything the manifest decides: what is checked out, where it lands on disk,
 * and what is left out. Pure logic — no I/O, no source API, no git. Later
 * tickets call in here instead of reinterpreting MANUAL §4, §5 and §6.
 */
export { type AliasResult, type ResolvedObject, resolveAlias } from './alias.js';
export { assignNames, fileNameFor, type Sibling } from './filenames.js';
export { isIgnored } from './ignore.js';
export { parseManifest } from './parse.js';
export { serializeManifest } from './serialize.js';
export type { Kind, Manifest, ManifestError, ParseResult, Root } from './types.js';
export {
  isDirectoryPath,
  isInsideRepository,
  isUnderRoot,
  rootOf,
  territoryOf,
  type ValidationError,
  validatePath,
  validateRoots,
} from './validate.js';
