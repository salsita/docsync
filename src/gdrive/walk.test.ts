import { describe, expect, it } from 'vitest';
import type { Root } from '../manifest/types.js';
import type { DriveFile, GDriveApi } from './api.js';
import { fixtureApi, ROOT_ID, refusesToWrite } from './fixtures.mock.js';
import { EXPORTS, walkRoot } from './walk.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

function root(over: Partial<Root> = {}): Root {
  return { src: { source: 'gdocs', id: ROOT_ID }, path: 'drive/', ignore: [], ...over };
}

/** An API over folder listings written by hand, for cases Drive did not give us. */
function stubApi(
  listings: Record<string, DriveFile[]>,
  files: Record<string, DriveFile> = {},
): GDriveApi {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`the stub API does not ${name}`);
  };
  return {
    ...refusesToWrite(),
    async listFolder(id) {
      return listings[id] ?? [];
    },
    async getFile(id) {
      const found = files[id];
      if (found !== undefined) return found;
      if (listings[id] !== undefined) return { id, name: id, mimeType: FOLDER };
      throw new Error(`no file ${id}`);
    },
    getDocument: refuse('getDocument'),
    comments: refuse('comments'),
    download: refuse('download'),
    downloadUri: refuse('downloadUri'),
    export: refuse('export'),
  };
}

describe('walkRoot over the recorded tree', () => {
  it('recurses into sub-folders and names every file', async () => {
    const result = await walkRoot(fixtureApi(), root());

    expect(result.files.map((file) => `${file.kind} ${file.path}`).sort()).toEqual([
      'binary drive/dummy.pdf',
      'binary drive/plain.txt',
      'doc drive/Elements.md',
      'doc drive/Hidden leading dot.md',
      'doc drive/Leaf.md',
      'doc drive/Notes (2).md',
      'doc drive/Notes.md',
      'doc drive/Sub/Nested.md',
      'doc drive/Title-With- Illegal-Chars- -Quoted- -Tag- -Pipe-.md',
      'export drive/Numbers.xlsx',
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('carries the metadata a fetch needs', async () => {
    const result = await walkRoot(fixtureApi(), root());
    const elements = result.files.find((file) => file.title === 'Elements');

    expect(elements).toMatchObject({
      id: '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4',
      ref: { source: 'gdocs', id: '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4' },
      kind: 'doc',
      modifiedTime: '2026-09-03T16:20:48.431Z',
    });
    expect(elements?.lastModifyingUser?.emailAddress).toBe('jirist@salsitasoft.com');

    const pdf = result.files.find((file) => file.title === 'dummy.pdf');
    expect(pdf?.md5Checksum).toBe('65e948bea799b9c3a6d7861313eef348');
  });

  it('classifies the Sheet as a read-only export', async () => {
    const result = await walkRoot(fixtureApi(), root());
    const sheet = result.files.find((file) => file.title === 'Numbers');

    expect(sheet).toMatchObject({
      kind: 'export',
      exportMimeType: EXPORTS['application/vnd.google-apps.spreadsheet']?.mimeType,
      path: 'drive/Numbers.xlsx',
    });
  });

  it('keeps a name a previous fetch gave a file', async () => {
    const first = await walkRoot(fixtureApi(), root());
    const notes = first.files.filter((file) => file.title === 'Notes');
    const swapped = new Map([
      [notes[1]?.id ?? '', 'drive/Notes.md'],
      [notes[0]?.id ?? '', 'drive/Notes (2).md'],
    ]);

    const second = await walkRoot(fixtureApi(), root(), swapped);

    expect(second.files.find((file) => file.id === notes[1]?.id)?.path).toBe('drive/Notes.md');
    expect(second.files.find((file) => file.id === notes[0]?.id)?.path).toBe('drive/Notes (2).md');
  });

  it('ignores a file by path', async () => {
    const result = await walkRoot(fixtureApi(), root({ ignore: ['Leaf.md', 'Sub/'] }));

    expect(result.files.map((file) => file.path)).not.toContain('drive/Leaf.md');
    expect(result.files.map((file) => file.path)).not.toContain('drive/Sub/Nested.md');
    expect(result.skipped.map((one) => one.path).sort()).toEqual(['drive/Leaf.md', 'drive/Sub']);
    expect(result.skipped[0]?.reason).toBe('ignored');
  });

  it('ignores a file by source ref', async () => {
    const leaf = 'gdocs:1a-9FG_jwht91hmvglPsRpyi13yr9mlmTiUrXewEVyfI';
    const result = await walkRoot(fixtureApi(), root({ ignore: [leaf] }));

    expect(result.files.map((file) => file.title)).not.toContain('Leaf');
  });

  it('ignores a whole sub-tree by the folder ref its files are under', async () => {
    const sub = 'gdocs:1RoSAIyz2ktweMqiOBnlnl6AsXClvD3Wo';
    const result = await walkRoot(fixtureApi(), root({ ignore: [sub] }));

    expect(result.files.map((file) => file.path)).not.toContain('drive/Sub/Nested.md');
  });

  it('never ignores the root itself', async () => {
    const result = await walkRoot(fixtureApi(), root({ ignore: [`gdocs:${ROOT_ID}`] }));

    expect(result.files.length).toBeGreaterThan(0);
  });
});

describe('walkRoot over listings written by hand', () => {
  it('skips Google types with no export', async () => {
    const api = stubApi({
      F: [
        { id: 'form', name: 'A form', mimeType: 'application/vnd.google-apps.form' },
        { id: 'site', name: 'A site', mimeType: 'application/vnd.google-apps.site' },
        { id: 'map', name: 'A map', mimeType: 'application/vnd.google-apps.map' },
        { id: 'cut', name: 'A shortcut', mimeType: 'application/vnd.google-apps.shortcut' },
        { id: 'doc', name: 'Real', mimeType: DOC },
      ],
    });

    const result = await walkRoot(api, {
      src: { source: 'gdocs', id: 'F' },
      path: 'd/',
      ignore: [],
    });

    expect(result.files.map((file) => file.title)).toEqual(['Real']);
    expect(result.skipped.map((one) => `${one.reason} ${one.title}`)).toEqual([
      'unsupported A form',
      'unsupported A site',
      'unsupported A map',
      'unsupported A shortcut',
    ]);
  });

  it('walks a root that is one document rather than a folder', async () => {
    const file: DriveFile = { id: 'd1', name: 'Just one', mimeType: DOC, modifiedTime: 't' };
    const api = stubApi({}, { d1: file });

    const result = await walkRoot(api, {
      src: { source: 'gdocs', id: 'd1' },
      path: 'notes/One.md',
      ignore: [],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: 'notes/One.md', kind: 'doc' });
  });

  it('names a single-file root from its title when the path is a directory', async () => {
    const file: DriveFile = { id: 'd1', name: 'Just one', mimeType: DOC };
    const api = stubApi({}, { d1: file });

    const result = await walkRoot(api, {
      src: { source: 'gdocs', id: 'd1' },
      path: 'notes/',
      ignore: [],
    });

    expect(result.files[0]?.path).toBe('notes/Just one.md');
  });

  it('refuses to check out a root that is a type it cannot carry', async () => {
    const file: DriveFile = {
      id: 'f1',
      name: 'A form',
      mimeType: 'application/vnd.google-apps.form',
    };
    const api = stubApi({}, { f1: file });

    const result = await walkRoot(api, {
      src: { source: 'gdocs', id: 'f1' },
      path: 'notes/',
      ignore: [],
    });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'f1', title: 'A form', path: 'notes/A form', reason: 'unsupported' },
    ]);
  });

  it('walks a folder root whose path has no trailing slash', async () => {
    const api = stubApi(
      { F: [{ id: 'd', name: 'One', mimeType: DOC }] },
      { F: { id: 'F', name: 'Folder', mimeType: FOLDER } },
    );

    const result = await walkRoot(api, {
      src: { source: 'gdocs', id: 'F' },
      path: 'drive',
      ignore: [],
    });

    expect(result.files[0]?.path).toBe('drive/One.md');
  });

  it('takes the whole folder chain into the ignore check', async () => {
    // A source-ref entry only excludes a subtree if the walk carries the
    // ancestors down with it, so the folder ignored here is two levels up.
    const outer = '1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const api = stubApi({
      F: [{ id: outer, name: 'A', mimeType: FOLDER }],
      [outer]: [{ id: 'b', name: 'B', mimeType: FOLDER }],
      b: [{ id: 'd', name: 'Deep', mimeType: DOC }],
    });

    const result = await walkRoot(api, {
      src: { source: 'gdocs', id: 'F' },
      path: 'drive/',
      ignore: [`gdocs:${outer}`],
    });

    expect(result.files).toEqual([]);
    expect(result.skipped.map((one) => one.path)).toEqual(['drive/A']);
  });
});
