import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import { parseDocument } from '../frontmatter.js';
import type { IndexEntry } from '../index-file.js';
import { resolveAlias } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type { NotionApi } from './api.js';
import { fixtureApi, ROOT_ID } from './fixtures.mock.js';
import { changedSince, describe as describeRef, fetchRoot, notionApi } from './index.js';

const BLOCKS_ID = '3cf715cbeb0881168ea0f3f18715e1a4';
const LEAF_ID = '3cf715cbeb08819db888c032d7bb60de';

const provider = createFakeCredentialProvider({
  notion: { accessToken: 'secret_test', identity: { workspace: 'Test' } },
});

// What `docsync add notion:<page>` writes: the page is a file, its children
// are in the sibling directory of the same stem (MANUAL §4, §6).
const root: Root = { src: { source: 'notion', id: ROOT_ID }, path: 'Docsync test.md', ignore: [] };

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
      entry('Docsync test.md', ROOT_ID, files[0]?.entry.lastEditedTime ?? ''),
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
    const blocks = files.find((file) => file.path.endsWith('Blocks.md'));

    expect(blocks?.editor).toEqual({
      id: '2e924337-300b-4281-b820-a7ff207370b1',
      name: 'Jiří Staniševský',
      email: 'jirist@salsitasoft.com',
    });
  });

  it('names a bot editor too, without an email', async () => {
    const { files } = await fetch();
    // The root page was last touched by the docsync integration itself, when
    // ticket 06's smoke test created a page under it.
    expect(files[0]?.editor).toEqual({
      id: '3cf715cb-eb08-81a6-ba7b-0027692af2c9',
      name: 'docsync',
      email: undefined,
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
    const blocks = files.find((file) => file.path.endsWith('Blocks.md'));

    expect(blocks?.editor).toEqual({
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
    const stale = previous.get('Docsync test/Leaf.md');
    if (stale) previous.set(stale.path, { ...stale, lastEditedTime: '2000-01-01T00:00:00.000Z' });

    const { files } = await fetch(previous);

    expect(files.filter((file) => file.changed).map((file) => file.path)).toEqual([
      'Docsync test/Leaf.md',
    ]);
  });

  it('reports what it left out', async () => {
    const { skipped, files } = await fetchRoot(
      { ...root, ignore: ['Notes*'] },
      provider,
      undefined,
      { api: fixtureApi() },
    );

    expect(files.map((file) => file.path)).not.toContain('Docsync test/Notes.md');
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

describe('describe', () => {
  const api = fixtureApi();

  it('calls a page with child pages a leaf, and still counts them', async () => {
    const one = await describeRef({ source: 'notion', id: ROOT_ID }, provider, { api });

    expect(one).toMatchObject({
      ref: { source: 'notion', id: ROOT_ID },
      title: 'Docsync test',
      kind: 'leaf',
      ext: '.md',
    });
    expect(one.childCount).toBeGreaterThan(0);
    expect(one.lastEditedTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('resolves the alias table of MANUAL §5 for a page with children', async () => {
    const one = await describeRef({ source: 'notion', id: ROOT_ID }, provider, { api });
    const alias = (given?: string) => resolveAlias(given, { title: one.title, kind: one.kind });

    expect(alias(undefined)).toEqual({ ok: true, path: 'Docsync test.md' });
    expect(alias('specs/')).toEqual({ ok: true, path: 'specs/Docsync test.md' });
    expect(alias('specs/root.md')).toEqual({ ok: true, path: 'specs/root.md' });
    expect(alias('specs/root')).toMatchObject({ ok: false });
  });

  it('calls a page with no child pages a leaf', async () => {
    const one = await describeRef({ source: 'notion', id: LEAF_ID }, provider, { api });

    expect(one).toMatchObject({ title: 'Leaf', kind: 'leaf', childCount: 0, ext: '.md' });
  });

  it('normalises a dashed id and names the last editor', async () => {
    const dashed = [
      LEAF_ID.slice(0, 8),
      LEAF_ID.slice(8, 12),
      LEAF_ID.slice(12, 16),
      LEAF_ID.slice(16, 20),
      LEAF_ID.slice(20),
    ].join('-');

    const one = await describeRef({ source: 'notion', id: dashed }, provider, { api });

    expect(one.ref).toEqual({ source: 'notion', id: LEAF_ID });
    expect(one.editor?.id).toEqual(expect.any(String));
  });

  it('asks the credential provider for a token when given no API', async () => {
    await expect(
      describeRef({ source: 'notion', id: LEAF_ID }, createFakeCredentialProvider()),
    ).rejects.toThrow(/docsync auth notion/);
  });
});

describe('changedSince', () => {
  const api = fixtureApi();

  it('calls every page changed when there is no previous index', async () => {
    const { files } = await fetch();

    expect(await changedSince(root, provider, new Map(), { api })).toEqual(
      files.map((file) => file.path).sort(),
    );
  });

  it('calls nothing changed when the index still matches the source', async () => {
    const { entries } = await fetch();
    const previous = new Map(entries.map((one) => [one.path, one]));

    expect(await changedSince(root, provider, previous, { api })).toEqual([]);
  });

  it('names the paths whose last-edit time moved', async () => {
    const { entries } = await fetch();
    const previous = new Map(entries.map((one) => [one.path, one]));
    const moved = entries.find((one) => one.path.endsWith('Leaf.md'));
    previous.set(moved?.path ?? '', { ...(moved as IndexEntry), lastEditedTime: '2000-01-01' });

    expect(await changedSince(root, provider, previous, { api })).toEqual([moved?.path]);
  });

  it('counts a document the source no longer offers', async () => {
    const { entries } = await fetch();
    const previous = new Map(entries.map((one) => [one.path, one]));
    previous.set('Docsync test/Gone.md', entry('Docsync test/Gone.md', 'f'.repeat(32), ''));
    // An entry of another root is not this root's business.
    previous.set('other/Gone.md', entry('other/Gone.md', 'e'.repeat(32), ''));

    expect(await changedSince(root, provider, previous, { api })).toEqual(['Docsync test/Gone.md']);
  });
});

describe('notionApi', () => {
  it('builds an API from the stored token', async () => {
    const api = await notionApi(provider);
    expect(typeof api.blockTree).toBe('function');
  });
});
