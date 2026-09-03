import { describe, expect, it } from 'vitest';
import type { Root } from '../manifest/types.js';
import type { NotionApi } from './api.js';
import { fixtureApi, fixtureTitle, ROOT_ID } from './fixtures.mock.js';
import { titleOf, walkRoot } from './walk.js';

const LEAF_ID = '3cf715cbeb08819db888c032d7bb60de';
const BLOCKS_ID = '3cf715cbeb0881168ea0f3f18715e1a4';
const NESTED_ID = '3cf715cbeb08817aa990e78c35a82eba';

function root(overrides: Partial<Root> = {}): Root {
  return {
    src: { source: 'notion', id: ROOT_ID },
    path: 'Docsync test/',
    ignore: [],
    ...overrides,
  };
}

async function walk(overrides: Partial<Root> = {}, previous?: Map<string, string>) {
  return walkRoot(fixtureApi(), root(overrides), previous);
}

describe('walkRoot', () => {
  it('puts the root page inside its directory and the children beside it', async () => {
    const { root: page, pages } = await walk();

    expect(page.path).toBe('Docsync test/Docsync test.md');
    expect(page.title).toBe('Docsync test');
    expect(pages.map((one) => one.path).sort()).toEqual([
      'Docsync test/Docsync test.md',
      'Docsync test/Docsync test/Blocks.md',
      'Docsync test/Docsync test/Blocks/Nested.md',
      'Docsync test/Docsync test/CON-.md',
      'Docsync test/Docsync test/Hidden leading dot.md',
      'Docsync test/Docsync test/Leaf.md',
      'Docsync test/Docsync test/Notes (2).md',
      'Docsync test/Docsync test/Notes.md',
      'Docsync test/Docsync test/Title-With- Illegal-Chars- -Quoted- -Tag- -Pipe-.md',
    ]);
  });

  it('finds Nested under Blocks', async () => {
    const { root: page } = await walk();
    const blocks = page.children.find((child) => child.title === 'Blocks');

    expect(blocks?.children.map((child) => child.title)).toEqual(['Nested']);
    expect(blocks?.children[0]?.path).toBe('Docsync test/Docsync test/Blocks/Nested.md');
  });

  it('names a file root exactly, with its children beside it', async () => {
    const { root: page, pages } = await walkRoot(fixtureApi(), {
      src: { source: 'notion', id: BLOCKS_ID },
      path: 'notes/blocks.md',
      ignore: [],
    });

    expect(page.path).toBe('notes/blocks.md');
    expect(pages.map((one) => one.path)).toEqual(['notes/blocks.md', 'notes/blocks/Nested.md']);
  });

  it('carries the id, the last edit time and the last editor', async () => {
    const { root: page } = await walk();

    expect(page.id).toBe(ROOT_ID);
    expect(page.ref).toEqual({ source: 'notion', id: ROOT_ID });
    expect(page.lastEditedTime).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The integration itself, since ticket 06's smoke test created a page here.
    expect(page.lastEditedBy).toBe('3cf715cb-eb08-81a6-ba7b-0027692af2c9');
  });

  it('carries each page’s blocks along', async () => {
    const { root: page } = await walk();
    const leaf = page.children.find((child) => child.id === LEAF_ID);
    expect(leaf?.blocks.map((block) => block.type)).toEqual(['paragraph']);
  });

  it('ignores by path pattern', async () => {
    const { pages, skipped } = await walk({ ignore: ['Notes*'] });

    expect(pages.map((one) => one.title)).not.toContain('Notes');
    expect(skipped.filter((one) => one.reason === 'ignored').map((one) => one.path).length).toBe(2);
  });

  it('ignores by source ref, subtree and all', async () => {
    const { pages, skipped } = await walk({ ignore: [`notion:${BLOCKS_ID}`] });

    expect(pages.map((one) => one.id)).not.toContain(BLOCKS_ID);
    expect(pages.map((one) => one.id)).not.toContain(NESTED_ID);
    expect(skipped).toContainEqual({
      id: BLOCKS_ID,
      title: 'Blocks',
      path: 'Docsync test/Docsync test/Blocks.md',
      reason: 'ignored',
    });
  });

  it('ignores a nested page through its ancestor chain', async () => {
    // `Blocks/**` excludes what is under Blocks without excluding Blocks.
    const { pages } = await walk({ ignore: ['Blocks/**'] });

    expect(pages.map((one) => one.id)).toContain(BLOCKS_ID);
    expect(pages.map((one) => one.id)).not.toContain(NESTED_ID);
  });

  it('never ignores the root itself', async () => {
    const { pages } = await walk({ ignore: [`notion:${ROOT_ID}`, '**'] });
    expect(pages.map((one) => one.path)).toEqual(['Docsync test/Docsync test.md']);
  });

  it('keeps a page on the name it had, even when a sibling is gone', async () => {
    const notes = (await walk()).pages.filter((one) => one.title === 'Notes');
    const swapped = new Map(
      notes.map((page, index) => [
        page.id,
        `Docsync test/Docsync test/${index === 0 ? 'Notes (2).md' : 'Notes.md'}`,
      ]),
    );

    const { pages } = await walk({}, swapped);
    const again = pages.filter((one) => one.title === 'Notes');

    expect(again.map((one) => one.path)).toEqual([...swapped.values()]);
  });

  it('skips a child database and says so', async () => {
    const api: NotionApi = {
      ...fixtureApi(),
      async blockTree(id) {
        if (id !== ROOT_ID) return [];
        return [
          {
            object: 'block',
            id: 'db00000000000000000000000000000f',
            type: 'child_database',
            has_children: true,
            child_database: { title: 'Tasks' },
          },
        ];
      },
    };

    const { pages, skipped } = await walkRoot(api, root());

    expect(pages).toHaveLength(1);
    expect(skipped).toEqual([
      {
        id: 'db00000000000000000000000000000f',
        title: 'Tasks',
        path: 'Docsync test/Docsync test/Tasks',
        reason: 'database',
      },
    ]);
  });

  it('falls back to a derived name when a child was not named', async () => {
    // A `child_page` block with no title at all still has to land somewhere.
    const api: NotionApi = {
      ...fixtureApi(),
      async blockTree(id) {
        if (id !== ROOT_ID) return [];
        return [
          {
            object: 'block',
            id: LEAF_ID,
            type: 'child_page',
            has_children: false,
            child_page: {},
          },
        ];
      },
    };

    const { pages } = await walkRoot(api, root());
    expect(pages[1]?.path).toBe('Docsync test/Docsync test/untitled.md');
  });
});

describe('titleOf', () => {
  it('reads the title property of a page', () => {
    expect(fixtureTitle(LEAF_ID)).toBe('Leaf');
  });

  it('reads a top-level title array, as a database row has', () => {
    expect(titleOf({ title: [{ plain_text: 'Row' }] })).toBe('Row');
  });

  it('answers an empty string when there is no title at all', () => {
    expect(titleOf({})).toBe('');
    expect(titleOf({ properties: { Name: { type: 'rich_text' } } })).toBe('');
    expect(titleOf({ properties: { Name: null } })).toBe('');
    expect(titleOf({ properties: { Name: { type: 'title' } } })).toBe('');
  });

  it('survives a page object with no last editor', async () => {
    const api: NotionApi = {
      ...fixtureApi(),
      async page() {
        return { properties: {} };
      },
      async blockTree() {
        return [];
      },
    };
    const { root: page } = await walkRoot(api, root());

    expect(page.title).toBe('');
    expect(page.lastEditedTime).toBe('');
    expect(page.lastEditedBy).toBeUndefined();
    expect(page.path).toBe('Docsync test/untitled.md');
  });
});
