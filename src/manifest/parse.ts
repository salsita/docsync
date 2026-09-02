import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml';
import { parseSourceRef, type SourceRef } from '../source-ref.js';
import type { Manifest, ManifestError, ParseResult, Root } from './types.js';

const TOP_LEVEL_KEYS = new Set(['version', 'roots']);
const ROOT_KEYS = new Set(['src', 'path', 'ignore']);

/**
 * Parses a manifest file (MANUAL §4).
 *
 * Returns every problem it finds rather than stopping at the first, so that one
 * run of `docsync` can print the whole list. Paths are NFC-normalised; nothing
 * else about them is checked here — that is `validateRoots`.
 */
export function parseManifest(text: string): ParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: true });
  const errors: ManifestError[] = [];

  const lineOf = (node: Node | null | undefined): number => {
    const range = node?.range;
    if (!range) return 1;
    return lineCounter.linePos(range[0]).line;
  };
  const report = (node: Node | null | undefined, message: string): void => {
    errors.push({ line: lineOf(node), message });
  };

  for (const error of doc.errors) {
    errors.push({
      line: lineCounter.linePos(error.pos[0]).line,
      message: `YAML: ${error.message}`,
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  const contents = doc.contents;
  if (!isMap(contents)) {
    return { ok: false, errors: [{ line: 1, message: 'The manifest must be a mapping' }] };
  }

  for (const pair of contents.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (!TOP_LEVEL_KEYS.has(key)) {
      report(pair.key as Node, `unknown key "${key}"`);
    }
  }

  const version = contents.get('version', true);
  if (version === undefined) {
    report(contents, 'The manifest is missing "version"');
  } else {
    const value: unknown = isScalar(version) ? version.value : undefined;
    if (value !== 1) report(version as Node, 'unknown version, expected 1');
  }

  const roots: Root[] = [];
  const rootsNode = contents.get('roots', true);
  if (rootsNode === undefined) {
    report(contents, 'The manifest is missing "roots"');
  } else if (isScalar(rootsNode) && rootsNode.value === null) {
    // `roots:` with nothing after it is an empty checkout, which is valid.
  } else if (!isSeq(rootsNode)) {
    report(rootsNode as Node, '"roots" must be a list');
  } else {
    for (const item of rootsNode.items) {
      const root = parseRoot(item as Node, report);
      if (root) roots.push(root);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { version: 1, roots, doc } satisfies Manifest };
}

type Report = (node: Node | null | undefined, message: string) => void;

function parseRoot(node: Node, report: Report): Root | undefined {
  if (!isMap(node)) {
    report(node, 'A root must be a mapping');
    return undefined;
  }

  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (!ROOT_KEYS.has(key)) report(pair.key as Node, `unknown key "${key}"`);
  }

  let failed = false;

  const srcNode = node.get('src', true);
  let src: SourceRef | undefined;
  if (srcNode === undefined) {
    report(node, 'A root is missing "src"');
    failed = true;
  } else {
    const raw = isScalar(srcNode) ? srcNode.value : undefined;
    src = typeof raw === 'string' ? parseSourceRef(raw) : undefined;
    if (!src) {
      report(srcNode as Node, `"src" is not a source ref: ${String(raw)}`);
      failed = true;
    }
  }

  const pathNode = node.get('path', true);
  let path: string | undefined;
  if (pathNode === undefined) {
    report(node, 'A root is missing "path"');
    failed = true;
  } else {
    const raw = isScalar(pathNode) ? pathNode.value : undefined;
    if (typeof raw !== 'string') {
      report(pathNode as Node, '"path" must be a string');
      failed = true;
    } else {
      path = raw.normalize('NFC');
    }
  }

  const ignore: string[] = [];
  const ignoreNode = node.get('ignore', true);
  if (ignoreNode !== undefined) {
    if (!isSeq(ignoreNode)) {
      report(ignoreNode as Node, '"ignore" must be a list of strings');
      failed = true;
    } else {
      for (const item of ignoreNode.items) {
        const raw = isScalar(item) ? item.value : undefined;
        if (typeof raw !== 'string') {
          report(item as Node, '"ignore" must be a list of strings');
          failed = true;
        } else {
          ignore.push(raw);
        }
      }
    }
  }

  if (failed || !src || path === undefined) return undefined;
  return { src, path, ignore };
}
