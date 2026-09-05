import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import { parseDocument } from '../frontmatter.js';
import type { IndexEntry } from '../index-file.js';
import { resolveAlias } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type { NotionApi } from './api.js';
import { countingApi, fixtureApi, ROOT_ID } from './fixtures.mock.js';
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

/** The files that are pages: everything but a comment sidecar (MANUAL §6). */
function documents<T extends { entry?: IndexEntry }>(
  files: readonly T[],
): (T & { entry: IndexEntry })[] {
  return files.filter((file): file is T & { entry: IndexEntry } => file.entry !== undefined);
}

async function fetch(previous?: Map<string, IndexEntry>, api: NotionApi = fixtureApi()) {
  return fetchRoot(root, provider, previous, { api });
}

describe('fetchRoot', () => {
  it('produces one file per page, frontmatter and all', async () => {
    const { files } = await fetch();
    const leaf = files.find((file) => file.path.endsWith('Leaf.md'));

    // `url` is derived from the id and written on every fetch (MANUAL §6).
    expect(leaf?.text).toBe(
      `---\nid: notion:${LEAF_ID}\ntitle: Leaf\nurl: https://www.notion.so/${LEAF_ID}\n---\n\n` +
        'A page with no children. One paragraph, nothing else.\n',
    );
    expect(parseDocument(leaf?.text ?? '').frontmatter).toEqual({
      id: { source: 'notion', id: LEAF_ID },
      title: 'Leaf',
    });
  });

  it('writes an index entry for every file, in the same order', async () => {
    const { files, entries } = await fetch();

    // Every file is a page or one of the files a page hosts: comments, and
    // the sidecar that has no entry of its own, are off unless the root asks
    // for them (MANUAL §4).
    expect(entries).toHaveLength(files.length);
    expect(entries.map((one) => one.path)).toEqual(documents(files).map((file) => file.path));
    expect(entries[0]).toEqual(
      entry('Docsync test.md', ROOT_ID, files[0]?.entry?.lastEditedTime ?? ''),
    );
    expect(entries.every((one) => one.type === 'notion-page' || one.type === 'asset')).toBe(true);
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

  describe('a re-fetch (MANUAL §7, `--all`)', () => {
    /** Every page of the root, downloaded and converted again. */
    async function refetch(previous: Map<string, IndexEntry>) {
      return fetchRoot(root, provider, previous, { api: fixtureApi(), all: true });
    }

    it('downloads and converts a page whose last-edit time never moved', async () => {
      const first = await fetch();
      const previous = new Map(first.entries.map((one) => [one.path, one]));

      const { files } = await refetch(previous);
      const pages = documents(files).filter((file) => file.entry.type === 'notion-page');

      expect(pages).toHaveLength(documents(first.files).filter((f) => f.text !== undefined).length);
      expect(pages.every((file) => file.changed)).toBe(true);
      expect(pages.every((file) => file.text !== undefined)).toBe(true);
      // The source did not move; only the conversion may have (MANUAL §7).
      expect(pages.every((file) => file.sourceChanged === false)).toBe(true);
    });

    it('compares a re-downloaded asset by its bytes, not by the block time', async () => {
      const first = await fetch();
      const previous = new Map(first.entries.map((one) => [one.path, one]));

      const { files } = await refetch(previous);
      const assets = files.filter((file) => file.entry?.type === 'asset');

      expect(assets.length).toBeGreaterThan(0);
      // The bytes are the ones already checked out, so nothing changed.
      expect(assets.every((file) => file.changed)).toBe(false);
    });

    it('still calls a page changed at the source when its time did move', async () => {
      const first = await fetch();
      const previous = new Map(first.entries.map((one) => [one.path, one]));
      const stale = previous.get('Docsync test/Leaf.md');
      if (stale) previous.set(stale.path, { ...stale, lastEditedTime: '2000-01-01T00:00:00.000Z' });

      const { files } = await refetch(previous);

      expect(
        documents(files)
          .filter((file) => file.sourceChanged === true)
          .map((file) => file.path),
      ).toEqual(['Docsync test/Leaf.md']);
    });

    it('numbers every page it downloads', async () => {
      const first = await fetch();
      const previous = new Map(first.entries.map((one) => [one.path, one]));
      const lines: string[] = [];

      await fetchRoot(root, provider, previous, {
        api: fixtureApi(),
        all: true,
        progress: (line) => lines.push(line),
      });

      expect(lines[0]).toBe('listing Docsync test.md');
      expect(lines).toHaveLength(
        documents(first.files).filter((f) => f.text !== undefined).length + 1,
      );
    });
  });

  it('marks only the page whose time moved', async () => {
    const first = await fetch();
    const previous = new Map(first.entries.map((one) => [one.path, one]));
    const stale = previous.get('Docsync test/Leaf.md');
    if (stale) previous.set(stale.path, { ...stale, lastEditedTime: '2000-01-01T00:00:00.000Z' });

    const { files } = await fetch(previous);

    expect(
      documents(files)
        .filter((file) => file.changed)
        .map((file) => file.path),
    ).toEqual(['Docsync test/Leaf.md']);
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

describe('the comment sidecar (MANUAL §6)', () => {
  const at = { now: () => new Date('2026-09-03T16:31:07Z') };
  // The sidecar exists only on a root that asked for it (MANUAL §4).
  const root: Root = {
    src: { source: 'notion', id: ROOT_ID },
    path: 'Docsync test.md',
    ignore: [],
    comments: true,
  };

  it('writes the open discussions of the Blocks page, anchored on their blocks', async () => {
    const { files } = await fetchRoot(root, provider, new Map(), { api: fixtureApi(), ...at });
    const sidecar = files.find((file) => file.path.endsWith('.comments.md'));

    expect(sidecar?.path).toBe('Docsync test/Blocks.comments.md');
    expect(sidecar?.text).toMatchSnapshot();
  });

  it('carries no index entry of its own, and is the only sidecar in the tree', async () => {
    const { files } = await fetchRoot(root, provider, new Map(), { api: fixtureApi(), ...at });
    const sidecars = files.filter((file) => file.path.endsWith('.comments.md'));

    expect(sidecars).toHaveLength(1);
    expect(sidecars[0]?.entry).toBeUndefined();
    expect(sidecars[0]?.changed).toBe(true);
  });

  it('is read on every fetch, changed page or not', async () => {
    const first = await fetchRoot(root, provider, new Map(), { api: fixtureApi(), ...at });
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    const backing = fixtureApi();
    const asked: string[] = [];
    const api: NotionApi = {
      ...backing,
      async comments(id) {
        asked.push(id);
        return backing.comments(id);
      },
    };

    const second = await fetchRoot(root, provider, previous, { api, ...at });

    expect(documents(second.files).some((file) => file.changed)).toBe(false);
    expect(second.files.map((file) => file.path)).toContain('Docsync test/Blocks.comments.md');
    // One request per page plus one per block of it (MANUAL §6).
    expect(asked.length).toBeGreaterThan(second.entries.length);
  });
});

describe('the `comments` option (MANUAL §4, §7)', () => {
  const at = { now: () => new Date('2026-09-03T16:31:07Z') };
  const on: Root = { ...root, comments: true };

  /** The index a fetch of `of` leaves behind, to fetch against a second time. */
  const indexAfter = async (of: Root): Promise<Map<string, IndexEntry>> => {
    const first = await fetchRoot(of, provider, new Map(), { api: fixtureApi(), ...at });
    return new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
  };

  const sidecars = (files: readonly { path: string }[]): string[] =>
    files.map((file) => file.path).filter((path) => path.endsWith('.comments.md'));

  it('costs what a fetch cost before comments existed when it is off', async () => {
    const previous = await indexAfter(root);
    const counted = countingApi();

    const second = await fetchRoot(root, provider, previous, { api: counted.api, ...at });

    // The walk of the nine recorded pages and nothing else, exactly as before
    // ticket 17. The two user lookups are cached and counted apart.
    expect(counted.requests).toHaveLength(19);
    expect(counted.requests.filter((one) => one.startsWith('comments:'))).toEqual([]);
    expect(counted.users).toHaveLength(2);
    expect(sidecars(second.files)).toEqual([]);
  });

  it('asks for no comments even on a first fetch, where every page changed', async () => {
    const counted = countingApi();

    await fetchRoot(root, provider, new Map(), { api: counted.api, ...at });

    expect(counted.requests.filter((one) => one.startsWith('comments:'))).toEqual([]);
  });

  it('costs one request per block of every page when it is on', async () => {
    const previous = await indexAfter(on);
    const counted = countingApi();

    const second = await fetchRoot(on, provider, previous, { api: counted.api, ...at });

    // The same walk, plus one `GET /v1/comments` per page and per block of it:
    // the cost the manual's §7 warning is about.
    expect(counted.requests.filter((one) => one.startsWith('comments:'))).toHaveLength(68);
    expect(counted.requests).toHaveLength(19 + 68);
    expect(sidecars(second.files)).toEqual(['Docsync test/Blocks.comments.md']);
  });

  it('drops the sidecar when a root turns it off', async () => {
    const previous = await indexAfter(on);
    const counted = countingApi();

    const second = await fetchRoot(root, provider, previous, { api: counted.api, ...at });

    // Gone from the fetch is gone from the commit, as a resolved thread is.
    expect(sidecars(second.files)).toEqual([]);
    expect(counted.requests).toHaveLength(19);
  });
});

describe('changedSince', () => {
  const api = fixtureApi();

  it('calls every page changed when there is no previous index', async () => {
    const { files } = await fetch();

    // Pages only: an asset moves with the page that holds it (§12 phase 2).
    expect(await changedSince(root, provider, new Map(), { api })).toEqual(
      documents(files)
        .filter((file) => file.entry.type === 'notion-page')
        .map((file) => file.path)
        .sort(),
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

describe('progress (MANUAL §7)', () => {
  /** A collecting `progress`, standing in for the helper's `log`. */
  function collect(): { lines: string[]; progress: (line: string) => void } {
    const lines: string[] = [];
    return { lines, progress: (line) => lines.push(line) };
  }

  const indexAfter = async (of: Root): Promise<Map<string, IndexEntry>> => {
    const first = await fetchRoot(of, provider, new Map(), { api: fixtureApi() });
    return new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
  };

  it('names the root it is listing, then every page it fetched', async () => {
    const { lines, progress } = collect();

    await fetchRoot(root, provider, new Map(), { api: fixtureApi(), progress });

    // Notion's tree is discovered as it is walked, so there is no total to
    // count against: the number alone (MANUAL §7).
    expect(lines).toEqual([
      'listing Docsync test.md',
      '1 Docsync test.md',
      '2 Docsync test/Leaf.md',
      '3 Docsync test/Title-With- Illegal-Chars- -Quoted- -Tag- -Pipe-.md',
      '4 Docsync test/Hidden leading dot.md',
      '5 Docsync test/Notes (2).md',
      '6 Docsync test/Notes.md',
      '7 Docsync test/CON-.md',
      '8 Docsync test/Blocks.md',
      '9 Docsync test/Blocks/Nested.md',
    ]);
  });

  it('says only that it listed when nothing changed', async () => {
    const previous = await indexAfter(root);
    const { lines, progress } = collect();

    await fetchRoot(root, provider, previous, { api: fixtureApi(), progress });

    expect(lines).toEqual(['listing Docsync test.md']);
  });

  it('names every page whose comments it reads when the root asks for them', async () => {
    const on: Root = { ...root, comments: true };
    const previous = await indexAfter(on);
    const { lines, progress } = collect();

    await fetchRoot(on, provider, previous, {
      api: fixtureApi(),
      now: () => new Date('2026-09-03T16:31:07Z'),
      progress,
    });

    // Nothing changed, so no page line; the comment reads are the whole cost
    // of this fetch, and they are one per page (MANUAL §7).
    expect(lines[0]).toBe('listing Docsync test.md');
    expect(lines.every((line, at) => at === 0 || line.startsWith('comments '))).toBe(true);
    expect(lines).toHaveLength(10);
  });
});
