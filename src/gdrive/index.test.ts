import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import type { IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { DOC_IDS, fixtureApi, fixtureDocument, ROOT_ID } from './fixtures.mock.js';
import { changedSince, describe as describeRef, fetchRoot } from './index.js';

const ELEMENTS = '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4';
const TEXT = '1oiqaDywxRX2qqjSpAlu2gZjS-0BWcqfr';

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

    // Ten documents, and the comment sidecar of the one with threads.
    expect(result.files).toHaveLength(11);
    expect(result.entries).toEqual(documents(result.files).map((file) => file.entry));
    expect(result.files.filter((file) => file.entry === undefined)).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('writes the frontmatter the Notion adapter writes', async () => {
    const result = await fetchRoot(root, provider, new Map(), options);
    const elements = result.files.find((file) => file.path === 'drive/Elements.md');

    expect(elements?.text?.startsWith(`---\nid: gdocs:${ELEMENTS}\ntitle: Elements\n---\n`)).toBe(
      true,
    );
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

describe('changedSince', () => {
  it('calls every path changed when there is no previous index', async () => {
    const first = await fetchRoot(root, provider, new Map(), options);

    expect(await changedSince(root, provider, new Map(), options)).toEqual(
      documents(first.files)
        .map((file) => file.path)
        .sort(),
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
