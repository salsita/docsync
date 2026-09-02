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
import type { IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { NotionBlock, RawObject } from './api.js';
import { fixtureApi, fixtureBlocks, ROOT_ID } from './fixtures.mock.js';
import { markdownToBlocks } from './from-markdown.js';
import { fetchRoot } from './index.js';
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
        body: shapeBody(kind, body),
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
function shapeBody(type: string, body: RawObject): RawObject {
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
  // Notion writes `icon: null` on a block that has none; we simply omit it.
  const icon = body.icon as RawObject | null | undefined;
  if (icon) shaped.icon = icon.emoji;
  // Only `paragraph`-like blocks carry a colour, and only some fixtures say so.
  if ('color' in body) shaped.color = body.color;
  return shaped;
}

function shapeRichText(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
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
  const { files } = await fetchRoot(root, createFakeCredentialProvider(), new Map(), {
    api: fixtureApi(),
  });
  const entries = files.map((file) => file.entry) as IndexEntry[];
  const pages = new Map(entries.map((entry): [string, string] => [entry.src.id, entry.path]));
  const ids = new Map(entries.map((entry): [string, string] => [entry.path, entry.src.id]));
  return { files, pages, ids };
}

describe('the 05 + 06 round trip', () => {
  it('converts every fixture page back to the blocks it came from', async () => {
    const { files, pages, ids } = await fixtures();
    expect(files.length).toBeGreaterThan(1);

    for (const file of files) {
      const from = file.path;
      const original = fixtureBlocks(file.entry.src.id) as NotionBlock[];
      const parsed = markdownToBlocks(file.body, { from, ids });

      // Markdown is canonical: what a fetch would show after this push is the
      // body we started from, minus the blocks a push drops.
      const after = blocksToMarkdown(parsed as NotionBlock[], { pages, from });
      expect(after).toBe(blocksToMarkdown(pruned(original), { pages, from }));

      // And it is a fixed point: pushing that again changes nothing at all.
      const again = markdownToBlocks(after, { from, ids });
      expect(blocksToMarkdown(again as NotionBlock[], { pages, from })).toBe(after);

      // The blocks themselves are the ones Notion holds, modulo what a push
      // cannot say.
      expect(notionShape(parsed)).toEqual(notionShape(original));
    }
  });
});
