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
import { markdownToRequests } from './from-markdown.js';
import { pushRoot } from './push.js';
import { footnoteRequests } from './write.js';

const ROOT_ID = 'folder-root';
const SUB_ID = 'folder-sub';
const ELEMENTS_ID = 'doc-elements';
const NESTED_ID = 'doc-nested';
const PLAIN_ID = 'file-plain';
const SHEET_ID = 'file-sheet';
const README_ID = 'file-readme';

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
    entry('drive/README.md', README_ID, { type: 'drive-file' }),
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
      id: SHEET_ID,
      name: 'Numbers',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [ROOT_ID],
    },
    {
      id: README_ID,
      name: 'README.md',
      mimeType: 'text/markdown',
      parents: [ROOT_ID],
      bytes: new TextEncoder().encode('# old'),
    },
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

/** A document holding exactly what the Markdown says, as a fetch would find. */
async function seed(api: FakeDrive, id: string, markdown: string): Promise<void> {
  const plan = markdownToRequests(markdown);
  const replies = await api.batchUpdate(id, plan.requests);
  await api.batchUpdate(
    id,
    footnoteRequests(plan.footnotes, replies, 0, await api.getDocument(id)),
  );
  api.calls.length = 0;
}

describe('a modified document', () => {
  const base = '# Notes\n\nOne.\n\nTwo.\n\nThree.\n';

  it('patches what changed and leaves the rest alone', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, base);
    const next = '# Notes\n\nOne.\n\nTwo, edited.\n\nThree.\n';

    const report = await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Elements', next),
        previousText: file(ELEMENTS_ID, 'Elements', base),
      },
    ]);

    expect(api.markdown(ELEMENTS_ID)).toBe(next);
    // One batch, and nothing else: the title is asked about, the body is
    // patched, and no second write goes out.
    expect(api.calls).toEqual([`getFile ${ELEMENTS_ID}`, `batchUpdate ${ELEMENTS_ID}`]);
    expect(report).toEqual([
      {
        path: 'drive/Elements.md',
        title: 'Elements',
        action: 'updated',
        blocks: { kept: 3, updated: 1, inserted: 0, deleted: 0 },
      },
    ]);
  });

  it('inserts, deletes and edits in one batch', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, base);
    const next = '# Notes\n\nOne, edited.\n\nInserted.\n\nThree.\n';

    const report = await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Elements', next),
        previousText: file(ELEMENTS_ID, 'Elements', base),
      },
    ]);

    expect(api.markdown(ELEMENTS_ID)).toBe(next);
    // Two short paragraphs replaced by two others in one hunk: the similarity
    // measure will not say which is which, so they are written afresh (§7).
    expect(report[0]?.blocks).toEqual({ kept: 2, updated: 0, inserted: 2, deleted: 2 });
  });

  it('is refused when the live document is not the version pushed from', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'Someone else wrote this.\n');

    await expect(
      push(api, [
        {
          kind: 'modified',
          path: 'drive/Elements.md',
          text: file(ELEMENTS_ID, 'Elements', 'Mine.\n'),
          previousText: file(ELEMENTS_ID, 'Elements', base),
        },
      ]),
    ).rejects.toThrow('the source changed');
    // Nothing was written: the read of the file's name is all that happened.
    expect(api.calls).toEqual([`getFile ${ELEMENTS_ID}`]);
  });

  it('is refused when the checkout has no base version of it', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, base);

    await expect(
      push(api, [
        {
          kind: 'modified',
          path: 'drive/Elements.md',
          text: file(ELEMENTS_ID, 'Elements', 'Mine.\n'),
        },
      ]),
    ).rejects.toThrow('there is no base version of this file');
  });

  it('names the pending suggestion an edit wrote over', async () => {
    const drive0 = drive();
    await seed(drive0, ELEMENTS_ID, 'A suggested paragraph.\n');
    // The fake document model knows nothing of suggestions; the API is what
    // reports them, so this is where one is put.
    const api: FakeDrive = {
      ...drive0,
      async getDocument(id, mode) {
        const doc = await drive0.getDocument(id, mode);
        const run = doc.body?.content?.[1]?.paragraph?.elements?.[0]?.textRun;
        if (run !== undefined) run.suggestedDeletionIds = ['suggest.1'];
        return doc;
      },
    };

    const report = await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Elements', 'A rewritten paragraph.\n'),
        previousText: file(ELEMENTS_ID, 'Elements', 'A suggested paragraph.\n'),
      },
    ]);

    expect(report[0]?.suggestions).toEqual(['suggest.1']);
    expect(drive0.markdown(ELEMENTS_ID)).toBe('A rewritten paragraph.\n');
  });

  it('renames the file when the frontmatter title has changed', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'Body.\n');

    await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Renamed', 'Body.\n'),
        previousText: file(ELEMENTS_ID, 'Elements', 'Body.\n'),
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

describe('a Markdown file stored in Drive', () => {
  it('is bytes, not a Doc: a change uploads a revision', async () => {
    const api = drive();
    const bytes = new TextEncoder().encode('# new');

    const report = await push(api, [{ kind: 'modified', path: 'drive/README.md', bytes }]);

    expect(report).toEqual([{ path: 'drive/README.md', title: 'README.md', action: 'updated' }]);
    expect(api.calls).toEqual([`upload ${README_ID} text/markdown`]);
  });
});

describe('a read-only export', () => {
  it('can be trashed, since that touches the file and not the rendering', async () => {
    const api = drive();

    const report = await push(api, [{ kind: 'deleted', path: 'drive/Numbers.xlsx' }]);

    expect(report).toEqual([
      { path: 'drive/Numbers.xlsx', title: 'Numbers.xlsx', action: 'trashed' },
    ]);
    expect(api.calls).toEqual([`trash ${SHEET_ID}`]);
  });

  it('is refused by name when its content changes, before anything else is written', async () => {
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
