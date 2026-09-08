import { Document, isMap, isSeq, type Node, type YAMLMap, YAMLSeq } from 'yaml';
import { formatSourceRef } from '../source-ref.js';
import type { Manifest, Root } from './types.js';

/**
 * Writes a manifest back out (MANUAL §4).
 *
 * Keys are always `src`, `path`, `ignore`, `comments`, `readonly`, `suggest`, in that
 * order. When
 * the manifest came from `parseManifest`, the original YAML document is written
 * through: a root whose value did not change keeps its own node, and with it
 * the user's comments, quoting and blank lines. Only changed and added roots
 * are rebuilt.
 */
export function serializeManifest(manifest: Manifest): string {
  const doc = manifest.doc ?? new Document({ version: 1, roots: [] });
  const previous = doc.get('roots', true);
  const previousItems = isSeq(previous) ? [...previous.items] : [];

  const items: Node[] = manifest.roots.map((root) => {
    const reusable = previousItems.find((item) => isMap(item) && rootNodeMatches(item, root));
    return (reusable as Node | undefined) ?? rootNode(doc, root);
  });

  if (isSeq(previous)) {
    // Mutating in place keeps the `roots:` key and any comment attached to it.
    previous.items = items;
  } else {
    const seq = new YAMLSeq<Node>();
    seq.items = items;
    doc.set('roots', seq);
  }
  doc.set('version', manifest.version);

  return doc.toString();
}

function rootNodeMatches(node: YAMLMap, root: Root): boolean {
  if (node.get('src') !== formatSourceRef(root.src)) return false;
  if (node.get('path') !== root.path) return false;
  const ignore = node.get('ignore', true);
  // `undefined` on both sides is a root that never mentioned `comments`.
  if (node.get('comments') !== root.comments) return false;
  if (node.get('readonly') !== root.readOnly) return false;
  if (node.get('suggest') !== root.suggest) return false;
  const values = isSeq(ignore) ? ignore.items.map((item) => scalarValue(item)) : [];
  return values.length === root.ignore.length && values.every((v, i) => v === root.ignore[i]);
}

function scalarValue(item: unknown): unknown {
  return item && typeof item === 'object' && 'value' in item ? item.value : item;
}

function rootNode(doc: Document, root: Root): Node {
  const value: Record<string, unknown> = {
    src: formatSourceRef(root.src),
    path: root.path,
  };
  if (root.ignore.length > 0) value.ignore = root.ignore;
  if (root.comments !== undefined) value.comments = root.comments;
  if (root.readOnly !== undefined) value.readonly = root.readOnly;
  if (root.suggest !== undefined) value.suggest = root.suggest;
  return doc.createNode(value) as Node;
}
