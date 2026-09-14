import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import type { IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { splitGDocsRef } from '../source-ref.js';
import type { DocsDocument, GDriveApi } from './api.js';
import { countingApi, DOC_IDS, fixtureApi, fixtureDocument, ROOT_ID } from './fixtures.mock.js';
import { changedSince, describe as describeRef, fetchRoot } from './index.js';
import { flattenTabs } from './tabs.js';
import { documentToMarkdown } from './to-markdown.js';

const ELEMENTS = '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4';
const TEXT = '1oiqaDywxRX2qqjSpAlu2gZjS-0BWcqfr';
/** The recorded Doc with two tabs (ticket 37). */
const TABBED = '1IkA6kWgvIw_TWy0_xm73kHt16aRoAf9JuXnFuxJg1ng';
const SECOND_TAB = 't.bq5s9c5xq0db';

const root: Root = { src: { source: 'gdocs', id: ROOT_ID }, path: 'drive/', ignore: [] };

const provider = createFakeCredentialProvider({
  gdocs: { accessToken: 'unused', identity: {} },
});

const options = { api: fixtureApi() };

function entry(over: Partial<IndexEntry> & Pick<IndexEntry, 'path' | 'src'>): IndexEntry {
  return { type: 'gdoc', lastEditedTime: '', ...over };
}

/** The files that are documents: everything but a comment sidecar (MANUAL §6). */
function documents<T extends { entry?: IndexEntry }>(
  files: readonly T[],
): (T & {
  entry: IndexEntry;
})[] {
  return files.filter((file): file is T & { entry: IndexEntry } => file.entry !== undefined);
}

describe('fetchRoot', () => {
  it('answers one file per checked-out document, with its index entry', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);

    // Ten documents — one of them a Doc of two tabs, which is two files
    // (ticket 37) — the one image the Elements Doc holds, and no sidecar:
    // comments are off unless the root asks for them (MANUAL §4, §12 phase 2).
    expect(result.files).toHaveLength(13);
    expect(result.files.filter((file) => file.entry?.type === 'asset')).toHaveLength(1);
    // Every file's entry, and the tabbed Doc's directory, which has no file.
    expect(result.entries).toEqual([
      ...documents(result.files).map((file) => file.entry),
      {
        path: 'drive/Tabbed/',
        src: { source: 'gdocs', id: TABBED },
        type: 'gdoc',
        lastEditedTime: '2026-09-14T16:12:18.434Z',
      },
    ]);
    expect(result.files.filter((file) => file.entry === undefined)).toHaveLength(0);
    expect(result.skipped).toEqual([]);
  });

  it('writes the frontmatter the Notion adapter writes', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const elements = result.files.find((file) => file.path === 'drive/Elements.md');

    // `url` is derived from the id and the Drive type (MANUAL §6): a Doc
    // opens in Docs.
    expect(
      elements?.text?.startsWith(
        `---\nid: gdocs:${ELEMENTS}\ntitle: Elements\n` +
          `url: https://docs.google.com/document/d/${ELEMENTS}/edit\n---\n`,
      ),
    ).toBe(true);
    // The body is the same text without the frontmatter block.
    expect(elements?.text?.endsWith(elements.body ?? '')).toBe(true);
    expect(elements?.body).toContain('<!-- docsync: style=title -->');
  });

  it('takes the title from the Drive file name, hostile characters and all', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const hostile = result.files.find((file) => file.path.startsWith('drive/Title-With-'));

    expect(hostile?.text).toContain('title: \'Title/With: Illegal*Chars? "Quoted" <Tag> |Pipe|\'');
  });

  it('credits the last editor', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const elements = result.files.find((file) => file.path === 'drive/Elements.md');

    expect(elements?.editor).toEqual({
      id: '11118091577995849452',
      name: 'Jiří Staniševský',
      email: 'jirist@salsitasoft.com',
    });
  });

  it('brings a binary back as bytes, with no frontmatter', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const plain = result.files.find((file) => file.path === 'drive/plain.txt');

    expect(plain?.text).toBeUndefined();
    expect(new TextDecoder().decode(plain?.bytes)).toBe('A plain text file, kept as bytes.\n');
    expect(plain?.entry).toMatchObject({
      type: 'drive-file',
      src: { source: 'gdocs', id: TEXT },
      md5: '89ddf8cace5f8557f3d69c1463c7a268',
    });
    expect(plain?.entry?.readOnly).toBeUndefined();
  });

  it('exports a Sheet and marks it read-only in the index', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const sheet = result.files.find((file) => file.path === 'drive/Numbers.xlsx');

    expect(sheet?.entry).toMatchObject({
      type: 'drive-file',
      src: { source: 'gdocs', id: '1ATMpIGObGedDD6f3yjkGq0jl0SPJ-BDbqpKC85MHg1w' },
      readOnly: true,
    });
    // A .xlsx is a zip: PK.
    expect([...(sheet?.bytes ?? []).slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it('marks everything changed on a first fetch', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);

    expect(result.files.every((file) => file.changed)).toBe(true);
  });

  it('leaves an unchanged document alone and downloads nothing for it', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));

    const second = await fetchRoot(root, provider, previous, options);

    expect(documents(second.files).some((file) => file.changed)).toBe(false);
    expect(documents(second.files).every((file) => file.text === undefined)).toBe(true);
    expect(second.files.every((file) => file.bytes === undefined)).toBe(true);
  });

  describe('a re-fetch (MANUAL §7, `--all`)', () => {
    const everything = { ...options, all: true };

    /** The index a fetch that has already happened left behind. */
    async function indexOfFirst(): Promise<Map<string, IndexEntry>> {
      const first = await fetchRoot(root, provider, new Map(), options);
      return new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    }

    it('downloads every document again, whatever its modified time says', async () => {
      const previous = await indexOfFirst();

      const second = await fetchRoot(root, provider, previous, everything);
      const docs = documents(second.files).filter((file) => file.entry.type === 'gdoc');

      expect(docs.every((file) => file.changed)).toBe(true);
      expect(docs.every((file) => file.text !== undefined)).toBe(true);
      // Drive did not move; only the conversion may have (MANUAL §7).
      expect(docs.every((file) => file.sourceChanged === false)).toBe(true);
      // A binary comes down again too, bytes and all.
      expect(second.files.find((file) => file.path === 'drive/plain.txt')?.bytes).toBeDefined();
    });

    it('compares a re-downloaded image by its checksum', async () => {
      const previous = await indexOfFirst();

      const second = await fetchRoot(root, provider, previous, everything);
      const assets = second.files.filter((file) => file.entry?.type === 'asset');

      expect(assets).toHaveLength(1);
      // The same bytes in the same place is the same file (MANUAL §12).
      expect(assets[0]?.changed).toBe(false);
    });

    it('still says which documents Drive itself moved', async () => {
      const previous = await indexOfFirst();
      previous.set(
        'drive/Elements.md',
        entry({ path: 'drive/Elements.md', src: { source: 'gdocs', id: ELEMENTS } }),
      );

      const second = await fetchRoot(root, provider, previous, everything);

      expect(
        documents(second.files)
          .filter((file) => file.sourceChanged === true)
          .map((file) => file.path),
      ).toEqual(['drive/Elements.md']);
    });

    it('numbers every document against the whole root', async () => {
      const previous = await indexOfFirst();
      const lines: string[] = [];

      const second = await fetchRoot(root, provider, previous, {
        ...everything,
        progress: (line) => lines.push(line),
      });
      // One line per Doc downloaded: a Doc of several tabs is one download,
      // however many files it becomes (ticket 37).
      const total = new Set(
        documents(second.files)
          .filter((file) => file.entry.type !== 'asset')
          .map((file) => splitGDocsRef(file.entry.src).docId),
      ).size;

      expect(lines[0]).toBe('listing drive/');
      expect(lines[1]?.startsWith(`1/${total} `)).toBe(true);
      expect(lines).toHaveLength(total + 1);
    });
  });

  it('sees a document whose modified time moved on', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    previous.set(
      'drive/Elements.md',
      entry({ path: 'drive/Elements.md', src: { source: 'gdocs', id: ELEMENTS } }),
    );

    const second = await fetchRoot(root, provider, previous, options);

    expect(
      documents(second.files)
        .filter((file) => file.changed)
        .map((file) => file.path),
    ).toEqual(['drive/Elements.md']);
  });

  it('sees a binary whose bytes changed under an unchanged time', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    const was = previous.get('drive/plain.txt');
    if (was !== undefined) previous.set('drive/plain.txt', { ...was, md5: 'something else' });

    const second = await fetchRoot(root, provider, previous, options);

    expect(
      documents(second.files)
        .filter((file) => file.changed)
        .map((file) => file.path),
    ).toEqual(['drive/plain.txt']);
  });

  it('keeps the name a file had, wherever the index remembers it from', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const notes = first.files.filter((file) => file.path.startsWith('drive/Notes'));
    const previous = new Map(
      notes.map((file, position): [string, IndexEntry] => {
        const path = position === 0 ? 'drive/Notes (2).md' : 'drive/Notes.md';
        return [path, { ...(file.entry as IndexEntry), path }];
      }),
    );

    const second = await fetchRoot(root, provider, previous, options);
    const swapped = second.files.find((file) => file.entry?.src.id === notes[0]?.entry?.src.id);

    expect(swapped?.path).toBe('drive/Notes (2).md');
  });

  it('reports what the ignore list left out', async () => {
    const result = await fetchRoot({ ...root, ignore: ['Leaf.md'] }, provider, new Map(), options);

    expect(result.skipped).toEqual([
      {
        id: '1a-9FG_jwht91hmvglPsRpyi13yr9mlmTiUrXewEVyfI',
        title: 'Leaf',
        path: 'drive/Leaf.md',
        reason: 'ignored',
      },
    ]);
  });

  it('builds its own API from the credential when none is passed', async () => {
    // Nothing is recorded for this id, so the call fails at the network rather
    // than silently reaching a fixture: that is the point of the assertion.
    await expect(
      fetchRoot(
        { src: { source: 'gdocs', id: 'not-a-real-folder-id-at-all' }, path: 'x/', ignore: [] },
        createFakeCredentialProvider({ gdocs: { accessToken: 'nope', identity: {} } }),
        new Map(),
        { fetch: async () => new Response('{}', { status: 401 }) },
      ),
    ).rejects.toThrow(/401/);
  });
});

const SHEET = '1ATMpIGObGedDD6f3yjkGq0jl0SPJ-BDbqpKC85MHg1w';

describe('describe', () => {
  it('calls a folder a container and counts what is directly inside it', async () => {
    const one = await describeRef({ source: 'gdocs', id: ROOT_ID }, provider, options);

    expect(one).toMatchObject({ ref: { source: 'gdocs', id: ROOT_ID }, kind: 'container' });
    expect(one.childCount).toBeGreaterThan(0);
    // A container has no file of its own, so it carries no extension.
    expect(one.ext).toBeUndefined();
  });

  it('calls a Doc a leaf that lands in a .md file', async () => {
    const one = await describeRef({ source: 'gdocs', id: ELEMENTS }, provider, options);

    expect(one).toMatchObject({ title: 'Elements', kind: 'leaf', childCount: 0, ext: '.md' });
    expect(one.editor).toEqual({
      id: '11118091577995849452',
      name: 'Jiří Staniševský',
      email: 'jirist@salsitasoft.com',
    });
  });

  it('gives an export and a binary the extension they take on disk', async () => {
    expect((await describeRef({ source: 'gdocs', id: SHEET }, provider, options)).ext).toBe(
      '.xlsx',
    );
    expect((await describeRef({ source: 'gdocs', id: TEXT }, provider, options)).ext).toBe('.txt');
  });
});

describe('the comment sidecar (MANUAL §6)', () => {
  const at = { ...options, now: () => new Date('2026-09-03T16:31:07Z') };
  // The sidecar exists only on a root that asked for it (MANUAL §4).
  const root: Root = {
    src: { source: 'gdocs', id: ROOT_ID },
    path: 'drive/',
    ignore: [],
    comments: true,
  };

  const sidecarOf = async (api = fixtureApi()) => {
    const result = await fetchRoot(root, provider, new Map(), { ...at, api });
    return result.files.find((file) => file.path === 'drive/Elements.comments.md');
  };

  it('writes the open threads and the pending suggestions of the Elements doc', async () => {
    expect((await sidecarOf())?.text).toMatchSnapshot();
  });

  it('carries no index entry of its own', async () => {
    const sidecar = await sidecarOf();

    expect(sidecar?.entry).toBeUndefined();
    expect(sidecar?.changed).toBe(true);
  });

  it('has none for a document with neither a thread nor a suggestion', async () => {
    const result = await fetchRoot(root, provider, new Map(), at);

    expect(
      result.files.map((file) => file.path).filter((path) => path.endsWith('.comments.md')),
    ).toEqual(['drive/Elements.comments.md']);
  });

  it('goes away when the last thread is resolved and no suggestion is left', async () => {
    const resolved = fixtureApi();
    const api = {
      ...resolved,
      async comments(id: string) {
        return (await resolved.comments(id)).map((comment) => ({ ...comment, resolved: true }));
      },
      // The suggestions live in the document; take the plain view instead.
      async getDocument(id: string) {
        return fixtureDocument(id);
      },
    };

    expect(await sidecarOf(api)).toBeUndefined();
  });

  it('is read on every fetch, changed document or not', async () => {
    const first = await fetchRoot(root, provider, new Map(), at);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    const asked: string[] = [];
    const backing = fixtureApi();
    const api = {
      ...backing,
      async comments(id: string) {
        asked.push(id);
        return backing.comments(id);
      },
    };

    const second = await fetchRoot(root, provider, previous, { ...at, api });

    // One `comments.list` per Doc, whether it moved or not (MANUAL §6).
    expect(asked).toHaveLength(DOC_IDS.length);
    expect(second.files.map((file) => file.path)).toContain('drive/Elements.comments.md');
    expect(documents(second.files).some((file) => file.changed)).toBe(false);
  });

  it('remembers that a document has a suggestion, so an unchanged one keeps it', async () => {
    const first = await fetchRoot(root, provider, new Map(), at);

    expect(first.entries.find((one) => one.path === 'drive/Elements.md')?.suggested).toBe(true);
    expect(first.entries.filter((one) => one.suggested === true)).toHaveLength(1);
  });

  it('refuses a document at the source whose name is the sidecar suffix', async () => {
    const backing = fixtureApi();
    const api = {
      ...backing,
      async listFolder(id: string) {
        return (await backing.listFolder(id)).map((file) =>
          file.name === 'Elements' ? { ...file, name: 'Elements.comments' } : file,
        );
      },
    };

    await expect(fetchRoot(root, provider, new Map(), { ...at, api })).rejects.toThrow(
      'the .comments.md suffix is docsync',
    );
  });
});

describe('the `comments` option (MANUAL §4, §7)', () => {
  const at = { ...options, now: () => new Date('2026-09-03T16:31:07Z') };
  const on: Root = { ...root, comments: true };

  /** The index a fetch of `of` leaves behind, to fetch against a second time. */
  const indexAfter = async (of: Root): Promise<Map<string, IndexEntry>> => {
    const first = await fetchRoot(of, provider, new Map(), at);
    return new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
  };

  const sidecars = (files: readonly { path: string }[]): string[] =>
    files.map((file) => file.path).filter((path) => path.endsWith('.comments.md'));

  it('costs what a fetch cost before comments existed when it is off', async () => {
    const previous = await indexAfter(root);
    const counted = countingApi();

    const second = await fetchRoot(root, provider, previous, { ...at, api: counted.api });

    // The listing of the root and of its one subfolder, and the root's own
    // metadata: nothing else, exactly as before ticket 17.
    expect(counted.requests).toEqual([
      `getFile:${ROOT_ID}`,
      `listFolder:${ROOT_ID}`,
      'listFolder:1RoSAIyz2ktweMqiOBnlnl6AsXClvD3Wo',
    ]);
    expect(sidecars(second.files)).toEqual([]);
  });

  it('asks for no comments even on a document that changed', async () => {
    const counted = countingApi();

    await fetchRoot(root, provider, new Map(), { ...at, api: counted.api });

    expect(counted.requests.filter((one) => one.startsWith('comments:'))).toEqual([]);
  });

  it('costs one comment listing per Doc, and the body of the one with threads, when it is on', async () => {
    const previous = await indexAfter(on);
    const counted = countingApi();

    const second = await fetchRoot(on, provider, previous, { ...at, api: counted.api });

    // Three for the walk, one `comments.list` per Doc, and the Elements body,
    // which the sidecar needs to place its threads (MANUAL §6).
    expect(counted.requests).toHaveLength(3 + DOC_IDS.length + 1);
    expect(counted.requests.filter((one) => one.startsWith('comments:'))).toHaveLength(
      DOC_IDS.length,
    );
    expect(sidecars(second.files)).toEqual(['drive/Elements.comments.md']);
  });

  it('drops the sidecar and the suggested flag when a root turns it off', async () => {
    const previous = await indexAfter(on);
    expect(previous.get('drive/Elements.md')?.suggested).toBe(true);
    const counted = countingApi();

    const second = await fetchRoot(root, provider, previous, { ...at, api: counted.api });

    // Gone from the fetch is gone from the commit, as a resolved thread is.
    expect(sidecars(second.files)).toEqual([]);
    expect(second.entries.some((one) => one.suggested === true)).toBe(false);
    expect(counted.requests.filter((one) => one.startsWith('comments:'))).toEqual([]);
  });
});

describe('changedSince', () => {
  it('calls every path changed when there is no previous index', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);

    // Documents only: an image moves with the Doc that holds it (§12 phase 2).
    // A Doc the index has never seen is named as the walk names it, since only
    // a read of it could say that it has tabs (ticket 37).
    expect(await changedSince(root, provider, new Map(), options)).toEqual(
      [
        ...documents(first.files)
          .filter((file) => file.entry.type !== 'asset' && !file.path.startsWith('drive/Tabbed/'))
          .map((file) => file.path),
        'drive/Tabbed.md',
      ].sort(),
    );
  });

  it('calls nothing changed when the index still matches Drive', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));

    expect(await changedSince(root, provider, previous, options)).toEqual([]);
  });

  it('sees a binary whose checksum moved under an unchanged time', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    const was = previous.get('drive/plain.txt');
    if (was !== undefined) previous.set('drive/plain.txt', { ...was, md5: 'something else' });

    expect(await changedSince(root, provider, previous, options)).toEqual(['drive/plain.txt']);
  });

  it('counts a file the root no longer holds, and no other root\u2019s', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    previous.set(
      'drive/Gone.md',
      entry({ path: 'drive/Gone.md', src: { source: 'gdocs', id: 'gone-id-that-is-long-enough' } }),
    );
    previous.set(
      'other/Gone.md',
      entry({
        path: 'other/Gone.md',
        src: { source: 'gdocs', id: 'other-id-that-is-long-enough' },
      }),
    );

    expect(await changedSince(root, provider, previous, options)).toEqual(['drive/Gone.md']);
  });
});

describe('progress (MANUAL §7)', () => {
  /** A collecting `progress`, standing in for the helper's `log`. */
  function collect(): { lines: string[]; progress: (line: string) => void } {
    const lines: string[] = [];
    return { lines, progress: (line) => lines.push(line) };
  }

  const indexAfter = async (of: Root): Promise<Map<string, IndexEntry>> => {
    const first = await fetchRoot(of, provider, new Map(), options);
    return new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
  };

  it('names the root it is listing, then every document it downloads', async () => {
    const { lines, progress } = collect();

    await fetchRoot(root, provider, new Map(), { ...options, progress });

    // The total is known once the walk is done, so every line carries it.
    expect(lines).toEqual([
      'listing drive/',
      '1/11 drive/Tabbed.md',
      '2/11 drive/Elements.md',
      '3/11 drive/dummy.pdf',
      '4/11 drive/plain.txt',
      '5/11 drive/Numbers.xlsx',
      '6/11 drive/Notes.md',
      '7/11 drive/Notes (2).md',
      '8/11 drive/Hidden leading dot.md',
      '9/11 drive/Title-With- Illegal-Chars- -Quoted- -Tag- -Pipe-.md',
      '10/11 drive/Leaf.md',
      '11/11 drive/Sub/Nested.md',
    ]);
  });

  it('says only that it listed when nothing changed', async () => {
    const previous = await indexAfter(root);
    const { lines, progress } = collect();

    await fetchRoot(root, provider, previous, { ...options, progress });

    expect(lines).toEqual(['listing drive/']);
  });

  it('names every document whose comments it reads when the root asks for them', async () => {
    const on: Root = { ...root, comments: true };
    const previous = await indexAfter(on);
    const { lines, progress } = collect();

    await fetchRoot(on, provider, previous, {
      ...options,
      now: () => new Date('2026-09-03T16:31:07Z'),
      progress,
    });

    // Nothing changed, so no document line; the comment listings are the whole
    // cost of this fetch, and they are one per Doc (MANUAL §7).
    expect(lines[0]).toBe('listing drive/');
    expect(lines.filter((line) => line.startsWith('comments '))).toHaveLength(DOC_IDS.length);
    expect(lines).toHaveLength(1 + DOC_IDS.length);
  });
});

describe('a Doc with several tabs (MANUAL §6, ticket 37)', () => {
  /** Where the recorded two-tab Doc lands, tab by tab. */
  const FIRST = 'drive/Tabbed/First tab.md';
  const SECOND = 'drive/Tabbed/Second tab.md';

  const pathsOf = (files: readonly { path: string }[]): string[] =>
    files.map((file) => file.path).filter((path) => path.startsWith('drive/Tabbed'));

  it('is a directory holding one file per tab', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);

    expect(pathsOf(result.files)).toEqual([FIRST, SECOND]);
    expect(result.files.find((file) => file.path === FIRST)?.body).toContain(
      'Content of the first tab.',
    );
    expect(result.files.find((file) => file.path === SECOND)?.body).toContain(
      'Content of the second tab.',
    );
  });

  it('gives each tab file its own id, title and URL', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const second = result.files.find((file) => file.path === SECOND);

    expect(
      second?.text?.startsWith(
        `---\nid: gdocs:${TABBED}#${SECOND_TAB}\ntitle: Second tab\n` +
          `url: https://docs.google.com/document/d/${TABBED}/edit?tab=${SECOND_TAB}\n---\n`,
      ),
    ).toBe(true);
    expect(second?.entry).toMatchObject({
      path: SECOND,
      type: 'gdoc',
      src: { source: 'gdocs', id: `${TABBED}#${SECOND_TAB}` },
    });
  });

  it('records the directory itself, so a push finds the Doc', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const directory = result.entries.find((one) => one.path === 'drive/Tabbed/');

    // A nested tab's depth varies, so the paths alone cannot say where the
    // Doc's directory starts: the index says (ticket 37).
    expect(directory).toMatchObject({
      path: 'drive/Tabbed/',
      type: 'gdoc',
      src: { source: 'gdocs', id: TABBED },
    });
    // And it is an entry only: no file is written for a directory.
    expect(result.files.some((file) => file.path.endsWith('/'))).toBe(false);
  });

  it('leaves a one-tab Doc exactly as it was', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const elements = result.files.find((file) => file.path === 'drive/Elements.md');

    // The "One tab" row of ticket 37: `<title>.md`, `id: gdocs:<docId>`, a URL
    // without a tab. Nothing to migrate for nearly every Doc there is.
    expect(elements?.entry?.src).toEqual({ source: 'gdocs', id: ELEMENTS });
    expect(elements?.text).toContain(`url: https://docs.google.com/document/d/${ELEMENTS}/edit\n`);
  });

  it('carries the tab files over when the Doc did not change', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));

    const second = await fetchRoot(root, provider, previous, options);

    expect(pathsOf(second.files)).toEqual([FIRST, SECOND]);
    expect(
      second.files
        .filter((file) => file.path.startsWith('drive/Tabbed'))
        .every((file) => file.changed === false),
    ).toBe(true);
    expect(second.entries.some((one) => one.path === 'drive/Tabbed/')).toBe(true);
  });

  it('moves the file, its sidecar and its assets when a Doc gains a tab', async () => {
    // The checkout of yesterday: one file, its sidecar and its image, because
    // the Doc had one tab (ticket 37, "Fetch, one → many at the source").
    const previous = new Map<string, IndexEntry>([
      ['drive/Tabbed.md', entry({ path: 'drive/Tabbed.md', src: { source: 'gdocs', id: TABBED } })],
    ]);

    const result = await fetchRoot(root, provider, previous, options);

    // The first tab takes the old file's content to its new path, so git's
    // rename detection pairs them and `git log --follow` crosses the move.
    expect(pathsOf(result.files)).toEqual([FIRST, SECOND]);
    expect(result.files.find((file) => file.path === FIRST)?.body).toBe(fixtureBodyOfFirstTab());
  });

  /** The first tab's Markdown, converted on its own, for the move above. */
  function fixtureBodyOfFirstTab(): string {
    const doc = fixtureDocument(TABBED);
    const [first] = flattenTabs(doc);
    return documentToMarkdown(first?.doc ?? {});
  }

  /** The fixture API with one document answered by a document of our own. */
  function serving(document: DocsDocument, over: Partial<GDriveApi> = {}) {
    const backing = fixtureApi();
    return {
      api: {
        ...backing,
        async getDocument(id: string, mode?: 'preview' | 'inline') {
          return id === TABBED ? document : backing.getDocument(id, mode);
        },
        ...over,
      },
    };
  }

  /** The checkout as the last fetch left it, with the Doc as a directory. */
  function asDirectory(): Map<string, IndexEntry> {
    return new Map<string, IndexEntry>([
      ['drive/Tabbed/', entry({ path: 'drive/Tabbed/', src: { source: 'gdocs', id: TABBED } })],
      [FIRST, entry({ path: FIRST, src: { source: 'gdocs', id: `${TABBED}#t.0` } })],
      [SECOND, entry({ path: SECOND, src: { source: 'gdocs', id: `${TABBED}#${SECOND_TAB}` } })],
    ]);
  }

  it('comes back to one file when the Doc comes back down to one tab', () => {
    // The reverse of the move above: the surviving tab is the Doc again, its id
    // loses the tab, and the other tab files go (ticket 37).
    const oneTab: DocsDocument = {
      documentId: TABBED,
      title: 'Tabbed',
      tabs: [
        {
          tabProperties: { tabId: 't.0', title: 'First tab', index: 0 },
          documentTab: {
            body: {
              content: [
                {
                  startIndex: 1,
                  endIndex: 26,
                  paragraph: { elements: [{ textRun: { content: 'Content of the tab.\n' } }] },
                },
              ],
            },
          },
        },
      ],
    };

    return fetchRoot(root, provider, asDirectory(), serving(oneTab)).then((result) => {
      expect(pathsOf(result.files)).toEqual(['drive/Tabbed.md']);
      expect(result.files.find((file) => file.path === 'drive/Tabbed.md')?.entry?.src).toEqual({
        source: 'gdocs',
        id: TABBED,
      });
      expect(result.entries.some((one) => one.path === 'drive/Tabbed/')).toBe(false);
    });
  });

  it('puts an image of the second tab in the assets directory of that tab', async () => {
    const withImage = structuredClone(fixtureDocument(TABBED)) as DocsDocument;
    const second = withImage.tabs?.[1]?.documentTab;
    if (second !== undefined) {
      second.inlineObjects = {
        'kix.tabimage': {
          objectId: 'kix.tabimage',
          inlineObjectProperties: {
            embeddedObject: { imageProperties: { contentUri: 'https://example.invalid/i' } },
          },
        },
      };
      second.body?.content?.push({
        startIndex: 28,
        endIndex: 30,
        paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'kix.tabimage' } }] },
      });
    }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const result = await fetchRoot(
      root,
      provider,
      new Map(),
      serving(withImage, {
        async downloadUri() {
          return { bytes: png, contentType: 'image/png' };
        },
      }),
    );

    // Object ids and indexes are per tab body, so an asset belongs to the tab
    // file it sits in and to no other (ticket 37).
    const asset = result.files.find(
      (file) => file.entry?.type === 'asset' && file.path.startsWith('drive/Tabbed'),
    );
    expect(asset?.path).toBe('drive/Tabbed/Second tab.assets/image-1.png');
    expect(asset?.entry?.document).toBe(SECOND);
    expect(result.files.find((file) => file.path === SECOND)?.body).toContain(
      '![](Second%20tab.assets/image-1.png)',
    );
  });
});
