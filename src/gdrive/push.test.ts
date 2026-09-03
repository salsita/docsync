/**
 * `pushRoot` over an in-memory Drive: which operations one diff becomes, in
 * what order, and what the report says about them.
 */
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { FileChange } from '../push-types.js';
import { createFakeDrive, type FakeDrive } from './fake-api.mock.js';
import { pushRoot } from './push.js';

const ROOT_ID = 'folder-root';
const SUB_ID = 'folder-sub';
const ELEMENTS_ID = 'doc-elements';
const NESTED_ID = 'doc-nested';
const PLAIN_ID = 'file-plain';
const SHEET_ID = 'file-sheet';

const root: Root = { path: 'drive/', src: { source: 'gdocs', id: ROOT_ID }, ignore: [] };

const provider = createFakeCredentialProvider();

function entry(path: string, id: string, extra: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    src: { source: 'gdocs', id },
    type: path.endsWith('.md') ? 'gdoc' : 'drive-file',
    lastEditedTime: '',
    ...extra,
  };
}

const index: DocumentIndex = new Map(
  [
    entry('drive/Elements.md', ELEMENTS_ID),
    entry('drive/Sub/Nested.md', NESTED_ID),
    entry('drive/plain.txt', PLAIN_ID),
    entry('drive/Numbers.xlsx', SHEET_ID, { readOnly: true }),
  ].map((one) => [one.path, one]),
);

function drive(): FakeDrive {
  return createFakeDrive([
    { id: ROOT_ID, name: 'Docsync test', mimeType: 'application/vnd.google-apps.folder' },
    {
      id: SUB_ID,
      name: 'Sub',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [ROOT_ID],
    },
    { id: ELEMENTS_ID, name: 'Elements', parents: [ROOT_ID] },
    { id: NESTED_ID, name: 'Nested', parents: [SUB_ID] },
    {
      id: PLAIN_ID,
      name: 'plain.txt',
      mimeType: 'text/plain',
      parents: [ROOT_ID],
      bytes: new TextEncoder().encode('old'),
    },
  ]);
}

function push(api: FakeDrive, changes: FileChange[]) {
  return pushRoot(root, changes, provider, index, { api });
}

/** A file's text, with the frontmatter a fetch would have written. */
function file(id: string | undefined, title: string, body: string): string {
  const frontmatter = id === undefined ? '' : `id: gdocs:${id}\n`;
  return `---\n${frontmatter}title: ${title}\n---\n\n${body}`;
}

describe('a modified document', () => {
  it('replaces the body and says it updated it', async () => {
    const api = drive();

    const report = await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Elements', '# New\n\nBody.\n'),
      },
    ]);

    expect(api.markdown(ELEMENTS_ID)).toBe('# New\n\nBody.\n');
    expect(report).toEqual([{ path: 'drive/Elements.md', title: 'Elements', action: 'updated' }]);
  });

  it('renames the file when the frontmatter title has changed', async () => {
    const api = drive();

    await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Renamed', 'Body.\n'),
      },
    ]);

    expect(api.files.get(ELEMENTS_ID)?.name).toBe('Renamed');
    expect(api.calls).toContain(`rename ${ELEMENTS_ID} Renamed`);
  });
});

describe('a rename', () => {
  it('with no body change is one call and no batch', async () => {
    const api = drive();

    const report = await push(api, [
      { kind: 'renamed', path: 'drive/Later.md', previousPath: 'drive/Elements.md' },
    ]);

    expect(api.calls).toEqual([`rename ${ELEMENTS_ID} Later`]);
    expect(report).toEqual([{ path: 'drive/Later.md', title: 'Later', action: 'renamed' }]);
  });

  it('into another folder is a move, by addParents and removeParents', async () => {
    const api = drive();

    await push(api, [
      { kind: 'renamed', path: 'drive/Sub/Elements.md', previousPath: 'drive/Elements.md' },
    ]);

    expect(api.calls).toEqual([`move ${ELEMENTS_ID} ${ROOT_ID}->${SUB_ID}`]);
    expect(api.files.get(ELEMENTS_ID)?.parents).toEqual([SUB_ID]);
  });
});

describe('a new file', () => {
  it('is created under the folder its path implies', async () => {
    const api = drive();

    const report = await push(api, [
      { kind: 'added', path: 'drive/Sub/Fresh.md', text: '# Fresh\n' },
    ]);

    const created = [...api.files.values()].find((one) => one.name === 'Fresh');
    expect(created?.parents).toEqual([SUB_ID]);
    expect(api.markdown(created?.id ?? '')).toBe('# Fresh\n');
    expect(report).toEqual([{ path: 'drive/Sub/Fresh.md', title: 'Fresh', action: 'created' }]);
  });

  it('makes the folders its path implies, and says it did', async () => {
    const api = drive();

    const report = await push(api, [
      { kind: 'added', path: 'drive/New/Deep/Note.md', text: 'x\n' },
    ]);

    expect(report).toEqual([
      { path: 'drive/New/', title: 'New', action: 'created' },
      { path: 'drive/New/Deep/', title: 'Deep', action: 'created' },
      { path: 'drive/New/Deep/Note.md', title: 'Note', action: 'created' },
    ]);
  });

  it('is uploaded whole when it is a binary', async () => {
    const api = drive();
    const bytes = new TextEncoder().encode('new bytes');

    await push(api, [{ kind: 'added', path: 'drive/notes.txt', bytes }]);

    const created = [...api.files.values()].find((one) => one.name === 'notes.txt');
    expect(created?.mimeType).toBe('text/plain');
    expect(created?.bytes).toEqual(bytes);
  });

  it('is created before a rename that moves another file', async () => {
    const api = drive();

    await push(api, [
      { kind: 'renamed', path: 'drive/Sub/Elements.md', previousPath: 'drive/Elements.md' },
      { kind: 'added', path: 'drive/Fresh.md', text: 'x\n' },
    ]);

    expect(api.calls[0]).toBe('create Fresh');
    expect(api.calls.at(-1)).toBe(`move ${ELEMENTS_ID} ${ROOT_ID}->${SUB_ID}`);
  });
});

describe('a modified binary', () => {
  it('is a new revision of the same file, with its own type', async () => {
    const api = drive();
    const bytes = new TextEncoder().encode('new');

    const report = await push(api, [{ kind: 'modified', path: 'drive/plain.txt', bytes }]);

    expect(api.calls).toEqual([`upload ${PLAIN_ID} text/plain`]);
    expect(api.files.get(PLAIN_ID)?.bytes).toEqual(bytes);
    expect(report).toEqual([{ path: 'drive/plain.txt', title: 'plain.txt', action: 'updated' }]);
  });
});

describe('a deleted file', () => {
  it('is trashed, never removed', async () => {
    const api = drive();

    const report = await push(api, [{ kind: 'deleted', path: 'drive/Sub/Nested.md' }]);

    expect(api.files.get(NESTED_ID)?.trashed).toBe(true);
    expect(report).toEqual([
      { path: 'drive/Sub/Nested.md', title: 'Nested.md', action: 'trashed' },
    ]);
  });

  it('with no id was never at the source, and does nothing', async () => {
    const api = drive();

    expect(await push(api, [{ kind: 'deleted', path: 'drive/Unknown.md' }])).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});

describe('a read-only export', () => {
  it('is refused by name, before anything else is written', async () => {
    const api = drive();

    await expect(
      push(api, [
        { kind: 'modified', path: 'drive/Elements.md', text: file(ELEMENTS_ID, 'Elements', 'x\n') },
        { kind: 'modified', path: 'drive/Numbers.xlsx', bytes: new Uint8Array() },
      ]),
    ).rejects.toThrow('Read-only export; edit it at the source (drive/Numbers.xlsx)');
    expect(api.calls).toEqual([]);
  });
});

describe('without an API', () => {
  it('builds one from the stored credential, and says when there is none', async () => {
    await expect(pushRoot(root, [], createFakeCredentialProvider())).rejects.toThrow(
      'Not signed in to Google',
    );
  });
});

describe('two new files under one new folder', () => {
  it('make the folder once and share it', async () => {
    const api = createFakeDrive([
      { id: ROOT_ID, name: 'Docsync test', mimeType: 'application/vnd.google-apps.folder' },
    ]);

    const report = await pushRoot(
      root,
      [
        { kind: 'added', path: 'drive/New/b.md', text: 'b\n' },
        { kind: 'added', path: 'drive/New/a.md', text: 'a\n' },
      ],
      provider,
      index,
      { api },
    );

    expect(report.filter((one) => one.path === 'drive/New/')).toHaveLength(1);
    expect(api.calls).toEqual([
      'create New',
      'create a',
      'batchUpdate new2',
      'create b',
      'batchUpdate new3',
    ]);
  });
});
