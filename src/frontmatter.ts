/**
 * The YAML frontmatter docsync owns on every Markdown document (MANUAL §6).
 *
 * Three keys — `id`, `title` and `url`, in that order — and nothing else: keys
 * the user adds are dropped on the next fetch, so this module drops them on the
 * way in too rather than pretending to preserve them. Shared by both adapters — a
 * Notion page and a Google Doc carry the same block, differing only in the
 * source of the ref.
 *
 * Everything goes through the one pipeline in `markdown.ts`, so a document is
 * canonical as a whole and not only below the frontmatter.
 */
import type { Root, Yaml } from 'mdast';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseMarkdown, stringifyMarkdown } from './markdown.js';
import { formatSourceRef, parseSourceRef, type SourceRef } from './source-ref.js';

/** What docsync keeps in a document's frontmatter. */
export interface Frontmatter {
  /** The identity of the document. Absent in a file the user has just created. */
  id?: SourceRef;
  /** The title as the source shows it. */
  title?: string;
  /**
   * Where the document opens at the source, derived from the id (MANUAL §6).
   * Written on every fetch and never read back: docsync owns it as it owns
   * `id`, and a file whose `url` was edited or deleted is not a change to
   * push, not a rename, and not an error — the next fetch writes it again.
   */
  url?: string;
}

/** A document read off disk: its frontmatter, if any, and its body as mdast. */
export interface ParsedDocument {
  frontmatter?: Frontmatter;
  body: Root;
}

/** The frontmatter block as an mdast node, ready to head a document. */
function frontmatterNode(frontmatter: Frontmatter): Yaml {
  const fields: Record<string, string> = {};
  if (frontmatter.id) fields.id = formatSourceRef(frontmatter.id);
  if (frontmatter.title !== undefined) fields.title = frontmatter.title;
  if (frontmatter.url !== undefined) fields.url = frontmatter.url;
  // `yaml` adds the trailing newline that the `---` fence supplies itself.
  return { type: 'yaml', value: stringifyYaml(fields).trimEnd() };
}

/**
 * The full text of one Markdown document: frontmatter, then the body in
 * canonical form. The body may be given as text or as a tree; text is parsed
 * first so that the result is canonical either way.
 */
export function serializeDocument(frontmatter: Frontmatter, body: Root | string): string {
  const tree = typeof body === 'string' ? parseMarkdown(body) : body;
  return stringifyMarkdown({
    type: 'root',
    children: [frontmatterNode(frontmatter), ...tree.children],
  });
}

/**
 * Splits a document into its frontmatter and its body.
 *
 * Frontmatter counts only as the first thing in the file; a `---` fence further
 * down is a thematic break, which is exactly how CommonMark reads it. A file
 * without frontmatter is a new document (MANUAL §6), so `frontmatter` is
 * `undefined` rather than empty — an empty one means the block was there but
 * said nothing docsync understands.
 */
export function parseDocument(text: string): ParsedDocument {
  const tree = parseMarkdown(text);
  const [first, ...rest] = tree.children;
  if (first?.type !== 'yaml') return { body: tree };

  return {
    frontmatter: readFields(first.value),
    body: { type: 'root', children: rest },
  };
}

/**
 * The keys docsync reads, ignoring anything else in the block — `url` very
 * much included. It is written by a fetch and derived from the id, so what a
 * file says it is means nothing (MANUAL §6).
 */
function readFields(yaml: string): Frontmatter {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    // A frontmatter block we cannot read is not a reason to refuse the file:
    // it means the same as no frontmatter, and push will say so.
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const fields = parsed as Record<string, unknown>;
  const frontmatter: Frontmatter = {};
  if (typeof fields.id === 'string') {
    const ref = parseSourceRef(fields.id);
    if (ref) frontmatter.id = ref;
  }
  if (typeof fields.title === 'string') frontmatter.title = fields.title;
  return frontmatter;
}
