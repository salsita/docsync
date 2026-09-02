import { describe, expect, it } from 'vitest';
import type { NotionBlock, RawObject } from './api.js';
import { createFakeApi, type FakeApi } from './fake-api.mock.js';
import { type BlockInput, markdownToBlocks } from './from-markdown.js';
import { createNotionWriter } from './write.js';

/** A page with the blocks it already holds. */
function api(blocks: NotionBlock[] = []): FakeApi {
  return createFakeApi({ pages: [{ id: 'p', title: 'Page', parentId: 'parent', blocks }] });
}

/** A stored block, as the fake records one. */
function stored(id: string, type: string, extra: RawObject = {}): NotionBlock {
  return { object: 'block', id, type, has_children: false, [type]: {}, ...extra };
}

/** `n` paragraphs, for the chunking tests. */
function paragraphs(count: number): BlockInput[] {
  return Array.from({ length: count }, (_unused, at) => ({
    type: 'paragraph',
    paragraph: { rich_text: [], color: 'default' },
    id: String(at),
  }));
}

/** A block with children, nested `depth` deep. */
function nest(depth: number): BlockInput {
  const block: BlockInput = { type: 'toggle', toggle: { rich_text: [], color: 'default' } };
  return depth === 0 ? block : { ...block, children: [nest(depth - 1)] };
}

describe('replaceBody', () => {
  it('deletes every block but a child page, then appends', async () => {
    const fake = api([
      stored('b1', 'paragraph'),
      stored('b2', 'child_page'),
      stored('b3', 'divider'),
    ]);

    await createNotionWriter(fake).replaceBody('p', paragraphs(1));

    expect(fake.calls).toEqual(['children:p', 'delete:b1', 'delete:b3', 'append:p:1']);
    expect(fake.bodyOf('p').map((block) => block.type)).toEqual(['child_page', 'paragraph']);
  });

  it('appends in chunks of a hundred', async () => {
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', paragraphs(250));
    expect(fake.appends.map((one) => one.length)).toEqual([100, 100, 50]);
  });

  it('strips the fields Notion computes for a run', async () => {
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', markdownToBlocks('Hello.\n'));

    const [sent] = fake.appends[0] as RawObject[];
    const [run] = (sent?.paragraph as { rich_text: RawObject[] }).rich_text;
    expect(run).toEqual({
      type: 'text',
      text: { content: 'Hello.', link: null },
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: 'default',
      },
    });
  });

  it('splits a run longer than two thousand characters', async () => {
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', markdownToBlocks(`${'a'.repeat(2500)}\n`));

    const [sent] = fake.appends[0] as RawObject[];
    const runs = (sent?.paragraph as { rich_text: RawObject[] }).rich_text;
    expect(runs.map((run) => (run.text as { content: string }).content.length)).toEqual([
      2000, 500,
    ]);
  });

  it('flattens a block past a hundred runs into a hundred', async () => {
    // Alternating bold and plain words: one run each, and far more than a
    // hundred of them.
    const text = Array.from({ length: 120 }, (_unused, at) => `**${at}** ${at}`).join('');
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', markdownToBlocks(`${text}\n`));

    const [sent] = fake.appends[0] as RawObject[];
    const runs = (sent?.paragraph as { rich_text: RawObject[] }).rich_text;
    expect(runs).toHaveLength(100);
    // Nothing is lost: the tail is one plain run holding the rest of the text.
    const joined = runs.map((run) => (run.text as { content: string }).content).join('');
    expect(joined).toBe(text.replaceAll('*', ''));
  });

  it('keeps the text of an equation and a mention in the flattened tail', async () => {
    // Past the hundredth run the tail is flattened; equations and mentions
    // carry their text there too, and there is no annotation left to lose.
    const text = `${Array.from({ length: 120 }, (_unused, at) => `**${at}** `).join('')}$E$`;
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', markdownToBlocks(`${text}\n`));

    const [sent] = fake.appends[0] as RawObject[];
    const runs = (sent?.paragraph as { rich_text: RawObject[] }).rich_text;
    expect((runs.at(-1)?.text as { content: string }).content).toContain('E');
  });

  it('nests two levels in the request and appends the third by parent id', async () => {
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', [nest(3)]);

    // One append for the top three levels, then one for the fourth, addressed
    // by the id of the block the first request created.
    expect(fake.calls.filter((call) => call.startsWith('append'))).toEqual([
      'append:p:1',
      'append:b3:1',
    ]);
    const [first] = fake.appends[0] as RawObject[];
    const level2 = (first?.toggle as { children: RawObject[] }).children[0];
    expect((level2?.toggle as { children?: unknown }).children).toHaveLength(1);
  });

  it('defers the rest of a run of children once one of them does not fit', async () => {
    // A table one level down cannot carry its rows in the same request, so it
    // and everything after it is appended separately — in that order.
    const table = markdownToBlocks('| a |\n| - |\n')[0] as BlockInput;
    const deep: BlockInput = {
      type: 'toggle',
      toggle: { rich_text: [] },
      children: [table, { type: 'paragraph', paragraph: { rich_text: [] } }],
    };
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', [deep]);

    expect(fake.bodyOf('p')[0]?.children?.map((one) => one.type)).toEqual(['table', 'paragraph']);
    expect(fake.bodyOf('p')[0]?.children?.[0]?.children).toHaveLength(1);
  });

  it('keeps a table and its rows in one request', async () => {
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', markdownToBlocks('| a |\n| - |\n| b |\n'));

    expect(fake.appends).toHaveLength(1);
    const [sent] = fake.appends[0] as RawObject[];
    expect((sent?.table as { children: RawObject[] }).children).toHaveLength(2);
  });

  it('defers a table that would land too deep to carry its rows', async () => {
    const table = markdownToBlocks('| a |\n| - |\n')[0] as BlockInput;
    const deep: BlockInput = {
      type: 'toggle',
      toggle: { rich_text: [] },
      children: [{ type: 'toggle', toggle: { rich_text: [] }, children: [table] }],
    };
    const fake = api();
    await createNotionWriter(fake).replaceBody('p', [deep]);

    const inner = fake.bodyOf('p')[0]?.children?.[0];
    expect(inner?.children?.[0]?.type).toBe('table');
    expect(inner?.children?.[0]?.children).toHaveLength(1);
  });

  it('gives up on a deferred append whose parent has gone missing', async () => {
    const fake = api();
    // An append that answers nothing: there is no id to hang the rest on.
    fake.append = async () => [];
    await expect(createNotionWriter(fake).replaceBody('p', [nest(3)])).resolves.toBeUndefined();
  });

  it('appends deferred children to the deepest block it can find', async () => {
    const fake = api();
    // A `children` list shorter than the path stops the walk where it is.
    const real = fake.children.bind(fake);
    fake.children = async (id) => (id.startsWith('b') ? [] : real(id));
    await createNotionWriter(fake).replaceBody('p', [nest(3)]);
    expect(fake.calls).toContain('append:b1:1');
  });
});

describe('createPage', () => {
  it('creates the page with its body in the same call', async () => {
    const fake = createFakeApi({ pages: [{ id: 'parent', title: 'Parent', blocks: [] }] });

    const id = await createNotionWriter(fake).createPage('parent', 'New', paragraphs(2));

    expect(id).toBe('page1');
    expect(fake.calls).toEqual(['createPage:parent:New:2']);
    expect(fake.pages.get('page1')?.blocks).toHaveLength(2);
  });

  it('creates the page empty and fills it when the body does not fit', async () => {
    const fake = createFakeApi({ pages: [{ id: 'parent', title: 'Parent', blocks: [] }] });

    await createNotionWriter(fake).createPage('parent', 'New', paragraphs(150));

    expect(fake.calls[0]).toBe('createPage:parent:New:0');
    expect(fake.appends.map((one) => one.length)).toEqual([100, 50]);
  });

  it('creates the page empty when the body is too deep for one request', async () => {
    const fake = createFakeApi({ pages: [{ id: 'parent', title: 'Parent', blocks: [] }] });
    await createNotionWriter(fake).createPage('parent', 'New', [nest(3)]);
    expect(fake.calls[0]).toBe('createPage:parent:New:0');
  });
});

describe('renamePage and archivePage', () => {
  it('renames', async () => {
    const fake = api();
    await createNotionWriter(fake).renamePage('p', 'Renamed');
    expect(fake.calls).toEqual(['updatePage:p:{"title":"Renamed"}']);
    expect(fake.pages.get('p')?.title).toBe('Renamed');
  });

  it('archives', async () => {
    const fake = api();
    await createNotionWriter(fake).archivePage('p');
    expect(fake.calls).toEqual(['updatePage:p:{"archived":true}']);
    expect(fake.pages.get('p')?.archived).toBe(true);
  });
});
