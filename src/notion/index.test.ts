import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import { parseDocument } from '../frontmatter.js';
import type { IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { NotionApi } from './api.js';
import { fixtureApi, ROOT_ID } from './fixtures.mock.js';
import { fetchRoot, notionApi } from './index.js';

const BLOCKS_ID = '3cf715cbeb0881168ea0f3f18715e1a4';
const LEAF_ID = '3cf715cbeb08819db888c032d7bb60de';

const provider = createFakeCredentialProvider({
  notion: { accessToken: 'secret_test', identity: { workspace: 'Test' } },
});

const root: Root = { src: { source: 'notion', id: ROOT_ID }, path: 'Docsync test/', ignore: [] };

function entry(path: string, id: string, lastEditedTime: string): IndexEntry {
  return { path, src: { source: 'notion', id }, type: 'notion-page', lastEditedTime };
}

async function fetch(previous?: Map<string, IndexEntry>, api: NotionApi = fixtureApi()) {
  return fetchRoot(root, provider, previous, { api });
}

describe('fetchRoot', () => {
  it('produces one file per page, frontmatter and all', async () => {
    const { files } = await fetch();
    const leaf = files.find((file) => file.path.endsWith('Leaf.md'));

    expect(leaf?.text).toBe(
      `---\nid: notion:${LEAF_ID}\ntitle: Leaf\n---\n\nA page with no children. One paragraph, nothing else.\n`,
    );
    expect(parseDocument(leaf?.text ?? '').frontmatter).toEqual({
      id: { source: 'notion', id: LEAF_ID },
      title: 'Leaf',
    });
  });

  it('writes an index entry for every file, in the same order', async () => {
    const { files, entries } = await fetch();

    expect(entries).toHaveLength(files.length);
    expect(entries.map((one) => one.path)).toEqual(files.map((file) => file.path));
    expect(entries[0]).toEqual(
      entry('Docsync test/Docsync test.md', ROOT_ID, files[0]?.entry.lastEditedTime ?? ''),
    );
    expect(entries.every((one) => one.type === 'notion-page')).toBe(true);
  });

  it('resolves a mention of a page in the same root to a relative link', async () => {
    const { files } = await fetch();
    const blocks = files.find((file) => file.path.endsWith('Blocks.md'));

    expect(blocks?.body).toContain('[Leaf](Leaf.md)');
  });

  it('resolves a mention of a page in another root through the index', async () => {
    const elsewhere = new Map([['other/Leaf.md', entry('other/Leaf.md', LEAF_ID, '')]]);
    const onlyBlocks: Root = {
      src: { source: 'notion', id: BLOCKS_ID },
      path: 'here/blocks.md',
      ignore: [],
    };

    const { files } = await fetchRoot(onlyBlocks, provider, elsewhere, { api: fixtureApi() });

    expect(files[0]?.body).toContain('[Leaf](../other/Leaf.md)');
  });

  it('names the last editor from the user cache', async () => {
    const { files } = await fetch();

    expect(files[0]?.editor).toEqual({
      id: '2e924337-300b-4281-b820-a7ff207370b1',
      name: 'Jiří Staniševský',
      email: 'jirist@salsitasoft.com',
    });
  });

  it('leaves the editor unnamed when the token cannot read the user', async () => {
    const api: NotionApi = {
      ...fixtureApi(),
      async user() {
        return undefined;
      },
    };
    const { files } = await fetch(undefined, api);

    expect(files[0]?.editor).toEqual({
      id: '2e924337-300b-4281-b820-a7ff207370b1',
      name: undefined,
      email: undefined,
    });
  });

  it('has no editor when the page object names none', async () => {
    const api: NotionApi = {
      ...fixtureApi(),
      async page() {
        return { properties: {}, last_edited_time: '2026-01-01T00:00:00.000Z' };
      },
      async blockTree() {
        return [];
      },
    };
    const { files } = await fetch(undefined, api);

    expect(files[0]?.editor).toBeUndefined();
  });

  it('marks everything changed on a first fetch', async () => {
    const { files } = await fetch();
    expect(files.every((file) => file.changed)).toBe(true);
  });

  it('marks a page unchanged when its last-edit time is the one on record', async () => {
    const first = await fetch();
    const previous = new Map(first.entries.map((one) => [one.path, one]));

    const { files } = await fetch(previous);

    expect(files.every((file) => file.changed)).toBe(false);
  });

  it('marks only the page whose time moved', async () => {
    const first = await fetch();
    const previous = new Map(first.entries.map((one) => [one.path, one]));
    const stale = previous.get('Docsync test/Docsync test/Leaf.md');
    if (stale) previous.set(stale.path, { ...stale, lastEditedTime: '2000-01-01T00:00:00.000Z' });

    const { files } = await fetch(previous);

    expect(files.filter((file) => file.changed).map((file) => file.path)).toEqual([
      'Docsync test/Docsync test/Leaf.md',
    ]);
  });

  it('reports what it left out', async () => {
    const { skipped, files } = await fetchRoot(
      { ...root, ignore: ['Notes*'] },
      provider,
      undefined,
      { api: fixtureApi() },
    );

    expect(files.map((file) => file.path)).not.toContain('Docsync test/Docsync test/Notes.md');
    expect(skipped.map((one) => one.title)).toEqual(['Notes', 'Notes']);
  });

  it('ignores index entries that belong to the other source', async () => {
    const previous = new Map([
      [
        'drive/Doc.md',
        {
          path: 'drive/Doc.md',
          src: { source: 'gdocs' as const, id: 'abcdefghijklmnopqrstu' },
          type: 'gdoc' as const,
          lastEditedTime: '',
        },
      ],
    ]);

    const { files } = await fetch(previous);

    expect(files.every((file) => file.changed)).toBe(true);
  });

  it('asks the credential provider for a token when given no API', async () => {
    await expect(fetchRoot(root, createFakeCredentialProvider())).rejects.toThrow(
      /docsync auth notion/,
    );
  });
});

describe('notionApi', () => {
  it('builds an API from the stored token', async () => {
    const api = await notionApi(provider);
    expect(typeof api.blockTree).toBe('function');
  });
});

describe('the 05 + 06 round trip', () => {
  // Enabled by ticket 06, which turns Markdown back into blocks: every fixture
  // page, converted to Markdown here and back there, must be the block tree
  // Notion holds — modulo the placeholders, which are ids, not content.
  it.skip('converts every fixture page back to the blocks it came from', () => {
    expect.fail('ticket 06 enables this');
  });
});
