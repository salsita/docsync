/**
 * The 05 + 06 round trip, over the whole recorded fixture tree.
 *
 * Two properties, and they are the reason the two converters share one mdast
 * pipeline rather than each owning a Markdown printer:
 *
 * 1. **Markdown is canonical.** Blocks → Markdown → blocks → Markdown is
 *    byte-identical. This is what MANUAL §6 promises: fetching a document and
 *    pushing it unchanged leaves no diff on the next fetch.
 * 2. **Blocks survive.** Blocks → Markdown → blocks is the tree Notion holds,
 *    projected through `notionShape` below onto the fields we actually control.
 *
 * `notionShape` is the honest part of this test. It drops exactly what a push
 * cannot carry, and every drop is a documented loss, not a convenience.
 */
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import { flattenBlocks } from '../diff/blocks.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { parseMarkdown, stringifyMarkdown } from '../markdown.js';
import type { NotionBlock, RawObject } from './api.js';
import { createFakeApi } from './fake-api.mock.js';
import { fixtureApi, fixtureBlocks, ROOT_ID } from './fixtures.mock.js';
import { markdownToBlocks } from './from-markdown.js';
import { fetchRoot } from './index.js';
import { pushRoot } from './push.js';
import { blocksToMarkdown } from './to-markdown.js';

/**
 * Blocks that are documents of their own, or that the dialect writes as a
 * placeholder. A placeholder carries a block id and no content, so push does
 * not recreate the block (MANUAL §7, "phase 1 write-back is full replace").
 */
const NOT_RECREATED = new Set([
  'child_page',
  'child_database',
  'table_of_contents',
  'column_list',
  'column',
  'synced_block',
  'breadcrumb',
  'bookmark',
  'embed',
  'button',
  'link_preview',
]);

/**
 * The fields a push controls. Everything else — ids, timestamps, `parent`,
 * `created_by`, `last_edited_by`, `has_children`, `archived`, `in_trash`,
 * `object`, the `list_format` Notion derives, a file block's `name`, a date's
 * `time_zone`, the user object Notion expands a user mention into, and the
 * `plain_text`/`href` it computes for every rich-text run — is Notion's.
 *
 * `pdf` and `video` blocks are compared as `file`: the dialect writes all three
 * as `[name](url)` and MANUAL §6 says a bare link block becomes a `file` block
 * on push, so their type is a documented loss.
 */
function notionShape(blocks: readonly RawObject[] | undefined): unknown[] {
  return (blocks ?? [])
    .filter((block) => !NOT_RECREATED.has(String(block.type)) && !isEmptyParagraph(block))
    .map((block) => {
      const type = String(block.type);
      const kind = type === 'pdf' || type === 'video' ? 'file' : type;
      const body = (block[type] ?? {}) as RawObject;
      return {
        type: kind,
        body: shapeBody(body),
        children: notionShape((block.children ?? body.children) as RawObject[] | undefined),
      };
    });
}

/**
 * An empty paragraph writes no Markdown at all, so nothing brings it back. The
 * fixture root page holds one, above its child pages.
 */
function isEmptyParagraph(block: RawObject): boolean {
  if (block.type !== 'paragraph' || block.has_children === true) return false;
  const rich = (block.paragraph as RawObject).rich_text;
  return Array.isArray(rich) && rich.length === 0;
}

/** The body of one block, reduced to what a create request can say. */
function shapeBody(body: RawObject): RawObject {
  const shaped: RawObject = {};
  if ('rich_text' in body) shaped.rich_text = shapeRichText(body.rich_text);
  if ('caption' in body) shaped.caption = shapeRichText(body.caption);
  if ('cells' in body) {
    shaped.cells = (body.cells as unknown[][]).map((cell) => shapeRichText(cell));
  }
  if ('checked' in body) shaped.checked = body.checked === true;
  if ('is_toggleable' in body) shaped.is_toggleable = body.is_toggleable === true;
  if ('language' in body) shaped.language = body.language;
  if ('expression' in body) shaped.expression = body.expression;
  if ('table_width' in body) shaped.table_width = body.table_width;
  if ('has_column_header' in body) shaped.has_column_header = body.has_column_header === true;
  if ('has_row_header' in body) shaped.has_row_header = body.has_row_header === true;
  if ('external' in body) shaped.url = (body.external as RawObject | null)?.url;
  // A file Notion hosts is the same file whether the round trip reads it back
  // as a signed URL or writes it as an upload: what a push controls is that
  // there is one, not where Notion keeps it (MANUAL §12 phase 2).
  if ('file' in body || 'file_upload' in body) shaped.hosted = true;
  // Notion writes `icon: null` on a block that has none; we simply omit it.
  const icon = body.icon as RawObject | null | undefined;
  if (icon) shaped.icon = icon.emoji;
  // Only `paragraph`-like blocks carry a colour, and only some fixtures say so.
  if ('color' in body) shaped.color = body.color;
  return shaped;
}

interface ShapedRun {
  annotations: RawObject;
  text?: RawObject;
  equation?: unknown;
  mention?: RawObject;
}

/**
 * Two runs that differ in nothing but where one ends and the next begins.
 * Notion cuts a text run at the edges of a comment, and the dialect cannot say
 * where a comment is (MANUAL §6) — so a push writes one run where Notion held
 * two, which is a documented loss and not a difference.
 */
function joinable(a: ShapedRun, b: ShapedRun): boolean {
  if (a.text === undefined || b.text === undefined) return false;
  if (a.equation !== undefined || b.equation !== undefined) return false;
  if (a.mention !== undefined || b.mention !== undefined) return false;
  return (
    JSON.stringify(a.annotations) === JSON.stringify(b.annotations) && a.text.link === b.text.link
  );
}

function shapeRichText(value: unknown): ShapedRun[] {
  const runs = (Array.isArray(value) ? value : []).map((raw): ShapedRun => {
    const run = raw as RawObject;
    const annotations = (run.annotations ?? {}) as RawObject;
    const mention = run.mention as RawObject | undefined;
    return {
      annotations,
      text: run.text === undefined ? undefined : shapeText(run.text as RawObject),
      equation: (run.equation as RawObject | undefined)?.expression,
      mention: mention === undefined ? undefined : shapeMention(mention),
    };
  });

  const joined: ShapedRun[] = [];
  for (const run of runs) {
    const last = joined.at(-1);
    if (last !== undefined && last.text !== undefined && run.text !== undefined) {
      if (joinable(last, run)) {
        joined[joined.length - 1] = {
          ...last,
          text: {
            ...last.text,
            content: `${String(last.text.content)}${String(run.text.content)}`,
          },
        };
        continue;
      }
    }
    joined.push(run);
  }
  return joined;
}

function shapeText(text: RawObject): RawObject {
  return { content: text.content, link: (text.link as RawObject | null)?.url ?? null };
}

/** A mention reduced to its kind and the id or date it points at. */
function shapeMention(mention: RawObject): RawObject {
  for (const kind of ['page', 'database', 'data_source', 'user'] as const) {
    const target = mention[kind] as RawObject | undefined;
    if (target) return { [kind]: String(target.id ?? '').replaceAll('-', '') };
  }
  const date = mention.date as RawObject | undefined;
  if (date) return { date: { start: date.start, end: date.end ?? null } };
  return mention;
}

/**
 * The fixture tree with everything a push does not recreate taken out: the
 * Markdown of *this* is what a fetch after a push would produce.
 */
function pruned(blocks: readonly NotionBlock[]): NotionBlock[] {
  return blocks
    .filter((block) => !NOT_RECREATED.has(block.type) && !isEmptyParagraph(block))
    .map((block) =>
      block.children === undefined ? block : { ...block, children: pruned(block.children) },
    );
}

const root: Root = { path: 'notion/', src: { source: 'notion', id: ROOT_ID }, ignore: [] };

/** Every fixture page, with the maps both directions need. */
async function fixtures() {
  const fetched = await fetchRoot(root, createFakeCredentialProvider(), new Map(), {
    api: fixtureApi(),
  });
  // A comment sidecar is not a document and does not round-trip (MANUAL §6).
  const files = fetched.files.filter(
    (file): file is (typeof fetched.files)[number] & { entry: IndexEntry; body: string } =>
      file.entry !== undefined && file.body !== undefined,
  );
  const documents = files.filter((file) => file.entry.type === 'notion-page');
  const hosted = fetched.files.filter((file) => file.entry?.type === 'asset');
  const entries = documents.map((file) => file.entry);
  const pages = new Map(entries.map((entry): [string, string] => [entry.src.id, entry.path]));
  const ids = new Map(entries.map((entry): [string, string] => [entry.path, entry.src.id]));
  // Every file the tree hosts, as the push would have uploaded it: a stub id
  // per asset path, and the link every conversion has to write (§12 phase 2).
  const uploads = new Map(
    hosted.map((file): [string, string] => [file.path, `fu-${file.entry?.src.id ?? ''}`]),
  );
  const assets = new Map(
    hosted.map((file): [string, string] => [file.entry?.src.id ?? '', file.path]),
  );
  return { files: documents, pages, ids, uploads, assets };
}

/**
 * The blocks a push sends, as Notion hands them back: every block given an id,
 * and every block that points at a file upload mapped to the asset that upload
 * came from — which is what the next fetch links by (MANUAL §12 phase 2).
 */
function stamp(
  blocks: readonly NotionBlock[],
  uploads: ReadonlyMap<string, string>,
): { blocks: NotionBlock[]; assets: Map<string, string> } {
  const pathOf = new Map([...uploads].map(([path, id]): [string, string] => [id, path]));
  const assets = new Map<string, string>();
  let next = 0;
  const walk = (list: readonly NotionBlock[]): NotionBlock[] =>
    list.map((block) => {
      next += 1;
      const id = `stamped${next}`;
      const body = (block[block.type] ?? {}) as RawObject;
      const upload = (body.file_upload as RawObject | undefined)?.id;
      const path = typeof upload === 'string' ? pathOf.get(upload) : undefined;
      if (path !== undefined) assets.set(id, path);
      return {
        ...block,
        id,
        ...(block.children === undefined ? {} : { children: walk(block.children) }),
      };
    });
  return { blocks: walk(blocks), assets };
}

/** The frontmatter a fetch writes, with no title so that no page is read. */
function file(id: string, body: string): string {
  return `---\nid: notion:${id}\n---\n\n${body}`;
}

describe('the 15 patch, over the whole fixture tree', () => {
  it('edits one paragraph of every fixture page and touches nothing else', async () => {
    const { files, pages } = await fixtures();
    const index: DocumentIndex = new Map(files.map((one) => [one.path, one.entry] as const));
    let edited = 0;

    for (const one of files) {
      const id = one.entry.src.id;
      const api = createFakeApi({
        pages: [{ id, title: 'Page', blocks: structuredClone(fixtureBlocks(id)) }],
      });
      const from = one.path;
      const body = blocksToMarkdown(api.bodyOf(id), { pages, from });

      // The first paragraph with something in it, edited in the tree the file
      // parses to: exactly the change a person makes in their editor.
      const tree = parseMarkdown(body);
      const target = flattenBlocks(tree).find(
        (block) => block.type === 'paragraph' && block.text.trim() !== '',
      );
      const last = [...(target?.inline ?? [])].reverse().find((node) => node.type === 'text');
      if (target === undefined || last === undefined) continue;
      last.value += ' Edited.';
      edited += 1;

      const next = stringifyMarkdown(tree);
      await pushRoot(
        root,
        [{ kind: 'modified', path: from, text: file(id, next), previousText: file(id, body) }],
        createFakeCredentialProvider(),
        index,
        { api },
      );

      // One block written, and the page now says what the file says. Both
      // sides go through the pipeline, as the base check does, so that the two
      // spellings of the callout marker (MANUAL §6) compare equal.
      expect(api.calls.filter((call) => call.startsWith('update:'))).toHaveLength(1);
      expect(api.calls.filter((call) => /^(append|delete):/.test(call))).toEqual([]);
      expect(
        stringifyMarkdown(parseMarkdown(blocksToMarkdown(api.bodyOf(id), { pages, from }))),
      ).toBe(next);
    }

    expect(edited).toBeGreaterThan(1);
  });

  it('inserts a block at the end of every fixture page and keeps the rest', async () => {
    const { files, pages } = await fixtures();
    const index: DocumentIndex = new Map(files.map((one) => [one.path, one.entry] as const));

    for (const one of files) {
      const id = one.entry.src.id;
      const api = createFakeApi({
        pages: [{ id, title: 'Page', blocks: structuredClone(fixtureBlocks(id)) }],
      });
      const from = one.path;
      const body = blocksToMarkdown(api.bodyOf(id), { pages, from });
      const next = stringifyMarkdown(parseMarkdown(`${body}\nOne more paragraph.\n`));

      await pushRoot(
        root,
        [{ kind: 'modified', path: from, text: file(id, next), previousText: file(id, body) }],
        createFakeCredentialProvider(),
        index,
        { api },
      );

      expect(api.calls.filter((call) => call.startsWith('append:'))).toHaveLength(1);
      expect(api.calls.filter((call) => /^(update|delete):/.test(call))).toEqual([]);
      // Through the pipeline on both sides: an empty paragraph the dialect
      // cannot write is still on the page, and writes blank lines nobody typed.
      expect(
        stringifyMarkdown(parseMarkdown(blocksToMarkdown(api.bodyOf(id), { pages, from }))),
      ).toBe(next);
    }
  });
});

describe('the 05 + 06 round trip', () => {
  it('converts every fixture page back to the blocks it came from', async () => {
    const { files, pages, ids, uploads, assets } = await fixtures();
    expect(files.length).toBeGreaterThan(1);

    for (const file of files) {
      const from = file.path;
      const original = fixtureBlocks(file.entry.src.id) as NotionBlock[];
      const parsed = markdownToBlocks(file.body, { from, ids, uploads });

      // Markdown is canonical: what a fetch would show after this push is the
      // body we started from, minus the blocks a push drops. Notion gives the
      // blocks a push creates ids of its own, and the next fetch links a
      // hosted file by that id, so the ids are stamped on here the way Notion
      // would (MANUAL §12 phase 2).
      const stamped = stamp(parsed as NotionBlock[], uploads);
      const after = blocksToMarkdown(stamped.blocks, { pages, from, assets: stamped.assets });
      expect(after).toBe(blocksToMarkdown(pruned(original), { pages, from, assets }));

      // And it is a fixed point: pushing that again changes nothing at all.
      const again = stamp(
        markdownToBlocks(after, { from, ids, uploads }) as NotionBlock[],
        uploads,
      );
      expect(blocksToMarkdown(again.blocks, { pages, from, assets: again.assets })).toBe(after);

      // The blocks themselves are the ones Notion holds, modulo what a push
      // cannot say.
      expect(notionShape(parsed)).toEqual(notionShape(original));
    }
  });
});
