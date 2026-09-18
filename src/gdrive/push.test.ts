/**
 * `pushRoot` over an in-memory Drive: which operations one diff becomes, in
 * what order, and what the report says about them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { parseMarkdown } from '../markdown.js';
import type { FileChange } from '../push-types.js';
import type { DocsDocument } from './api.js';
import { MAX_IMAGE_BYTES } from './assets.js';
import { createFakeDrive, type FakeDrive } from './fake-api.mock.js';
import { markdownToRequests } from './from-markdown.js';
import { pushRoot } from './push.js';
import { flattenTabs } from './tabs.js';
import { createGDriveWriter, footnoteRequests } from './write.js';

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

/**
 * One document of the fake Drive as the one tab it is (#37): the reply
 * carries the contents under `tabs`, as the real API does, and every Doc these
 * tests push to has exactly one tab.
 */
async function onlyTab(api: FakeDrive, id: string): Promise<DocsDocument> {
  return flattenTabs(await api.getDocument(id))[0]?.doc ?? {};
}

/** A document holding exactly what the Markdown says, as a fetch would find. */
async function seed(api: FakeDrive, id: string, markdown: string): Promise<void> {
  const plan = markdownToRequests(markdown);
  const { replies } = await api.batchUpdate(id, plan.requests);
  await api.batchUpdate(id, footnoteRequests(plan.footnotes, replies, 0, await onlyTab(api, id)));
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

  it('has nothing to push when the frontmatter url is all that changed (#27)', async () => {
    // docsync owns `url` and derives it from the id (MANUAL §6): an edited or
    // a deleted one is not a change, not a rename, and not an error.
    const api = drive();
    await seed(api, ELEMENTS_ID, base);
    const withUrl = (url: string) =>
      `---\nid: gdocs:${ELEMENTS_ID}\ntitle: Elements\n${url}---\n\n${base}`;

    const report = await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: withUrl('url: https://example.invalid/somewhere\n'),
        previousText: withUrl(`url: https://docs.google.com/document/d/${ELEMENTS_ID}/edit\n`),
      },
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: withUrl(''),
        previousText: withUrl(`url: https://docs.google.com/document/d/${ELEMENTS_ID}/edit\n`),
      },
    ]);

    expect(api.markdown(ELEMENTS_ID)).toBe(base);
    // The name is read to see whether the title moved; nothing is written.
    expect(api.calls).toEqual([`getFile ${ELEMENTS_ID}`, `getFile ${ELEMENTS_ID}`]);
    expect(report.map((one) => one.blocks)).toEqual([
      { kept: 4, updated: 0, inserted: 0, deleted: 0 },
      { kept: 4, updated: 0, inserted: 0, deleted: 0 },
    ]);
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
        const body = doc.tabs?.[0]?.documentTab?.body;
        const run = body?.content?.[1]?.paragraph?.elements?.[0]?.textRun;
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

describe('attachments (MANUAL §12 phase 2)', () => {
  const PATH = 'drive/Elements.md';
  const ASSET = 'drive/Elements.assets/photo.png';
  const bytes = (value: string) => new TextEncoder().encode(value);

  const withAsset = (objectId: string): DocumentIndex =>
    new Map([
      ...index,
      [
        ASSET,
        {
          path: ASSET,
          src: { source: 'gdocs', id: objectId },
          type: 'asset',
          lastEditedTime: '',
          document: PATH,
          checksum: 'old',
        } as IndexEntry,
      ],
    ]);

  it('uploads, shares, inserts, unshares and trashes, in that order', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');

    const report = await push(api, [
      {
        kind: 'modified',
        path: PATH,
        text: file(ELEMENTS_ID, 'Elements', 'One.\n\n![](Elements.assets/photo.png)\n'),
        previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
        assets: new Map([[ASSET, bytes('PNG')]]),
      },
    ]);

    const staged = [...api.files.values()].find((one) => one.name === 'photo.png');
    expect(staged).toBeDefined();
    // The title check is the push's own; what matters is the four steps of
    // the exposure, in this order and no other.
    expect(api.calls.filter((one) => !one.startsWith('getFile'))).toEqual([
      'create Elements.assets',
      'create photo.png',
      `share ${staged?.id} anyone/reader`,
      `batchUpdate ${ELEMENTS_ID}`,
      `unshare ${staged?.id}`,
      `trash ${staged?.id}`,
    ]);
    // Nothing stays shared, and the Drive copy is gone.
    expect(api.permissions.size).toBe(0);
    expect(staged?.trashed).toBe(true);
    expect(report[0]?.uploaded).toBe(1);

    const doc = await onlyTab(api, ELEMENTS_ID);
    const uri = Object.values(doc.inlineObjects ?? {})[0]?.inlineObjectProperties?.embeddedObject
      ?.imageProperties as { contentUri?: string } | undefined;
    expect(uri?.contentUri).toBe(`https://drive.google.com/uc?export=view&id=${staged?.id}`);
  });

  it('unshares and trashes even when the insert fails, and says what it left', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    api.batchUpdate = async () => {
      throw new Error('the batch failed');
    };

    await expect(
      push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(ELEMENTS_ID, 'Elements', 'One.\n\n![](Elements.assets/photo.png)\n'),
          previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
          assets: new Map([[ASSET, bytes('PNG')]]),
        },
      ]),
    ).rejects.toThrow(/the batch failed/);

    expect(api.permissions.size).toBe(0);
    expect([...api.files.values()].find((one) => one.name === 'photo.png')?.trashed).toBe(true);
  });

  it('names what the clean-up could not undo', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    api.deletePermission = async () => {
      throw new Error('no');
    };

    await expect(
      push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(ELEMENTS_ID, 'Elements', 'One.\n\n![](Elements.assets/photo.png)\n'),
          previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
          assets: new Map([[ASSET, bytes('PNG')]]),
        },
      ]),
    ).rejects.toThrow(/Left behind, and yours to remove: the public link on the Drive file/);
  });

  it('refuses a file that is not an image', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    await expect(
      push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(ELEMENTS_ID, 'Elements', 'One.\n\n[Spec](Elements.assets/spec.pdf)\n'),
          previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
          assets: new Map([['drive/Elements.assets/spec.pdf', bytes('%PDF')]]),
        },
      ]),
    ).rejects.toThrow(/Google Docs cannot hold a file; link to it instead/);
  });

  it('refuses a link whose file is not in the checkout', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    await expect(
      push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(ELEMENTS_ID, 'Elements', 'One.\n\n![](Elements.assets/photo.png)\n'),
          previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
        },
      ]),
    ).rejects.toThrow(/photo\.png: this link points at a file that is not in the checkout/);
  });

  it('reports an image over the limit and inserts nothing for it', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    const huge = { length: MAX_IMAGE_BYTES + 1 } as unknown as Uint8Array;

    const report = await push(api, [
      {
        kind: 'modified',
        path: PATH,
        text: file(ELEMENTS_ID, 'Elements', 'One.\n\n![](Elements.assets/photo.png)\n'),
        previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
        assets: new Map([[ASSET, huge]]),
      },
    ]);

    expect(report[0]?.skippedFiles?.[0]?.path).toBe(ASSET);
    expect(api.calls.filter((one) => one.startsWith('share'))).toEqual([]);
    expect((await onlyTab(api, ELEMENTS_ID)).inlineObjects).toBeUndefined();
  });

  it('replaces the object when only the bytes changed', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    // An image already in the document, as a fetch would have found it.
    await api.batchUpdate(ELEMENTS_ID, [
      { insertInlineImage: { location: { index: 1 }, uri: 'https://old' } },
    ]);
    api.calls.length = 0;

    const report = await pushRoot(
      root,
      [{ kind: 'modified', path: ASSET, bytes: bytes('NEWPNG') }],
      provider,
      withAsset('kix.img1'),
      { api },
    );

    const staged = [...api.files.values()].find((one) => one.name === 'photo.png');
    expect(api.calls).toEqual([
      'create Elements.assets',
      'create photo.png',
      `share ${staged?.id} anyone/reader`,
      `batchUpdate ${ELEMENTS_ID}`,
      `unshare ${staged?.id}`,
      `trash ${staged?.id}`,
    ]);
    const objects = Object.keys((await onlyTab(api, ELEMENTS_ID)).inlineObjects ?? {});
    expect(objects).toEqual(['kix.img1', 'kix.img2']);
    expect(report).toEqual([{ path: PATH, title: 'Elements.md', action: 'updated', uploaded: 1 }]);
  });

  it('refuses a file deleted while the document still links it', async () => {
    const api = drive();
    await expect(
      pushRoot(root, [{ kind: 'deleted', path: ASSET }], provider, withAsset('kix.img1'), { api }),
    ).rejects.toThrow(/the file is gone but drive\/Elements\.md still links it/);
  });
});

describe('progress (MANUAL §7)', () => {
  const PATH = 'drive/Elements.md';
  const ASSET = 'drive/Elements.assets/photo.png';

  /** Every line a push emitted, with the number of calls made when it was. */
  function watch(api: FakeDrive) {
    const lines: string[] = [];
    const calls: number[] = [];
    return {
      lines,
      calls,
      progress: (line: string) => {
        lines.push(line);
        calls.push(api.calls.length);
      },
    };
  }

  it('names each document before its requests go out', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    const watcher = watch(api);

    await pushRoot(
      root,
      [
        { kind: 'added', path: 'drive/New.md', text: file(undefined, 'New', 'Fresh.\n') },
        {
          kind: 'modified',
          path: PATH,
          text: file(ELEMENTS_ID, 'Elements', 'One, edited.\n'),
          previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
        },
      ],
      provider,
      index,
      { api, progress: watcher.progress },
    );

    // Creations come first, so they are numbered first (MANUAL §7).
    expect(watcher.lines).toEqual(['1/2 drive/New.md', '2/2 drive/Elements.md']);
    expect(watcher.calls[0]).toBe(0);
  });

  it('names every file it uploads', async () => {
    const api = drive();
    await seed(api, ELEMENTS_ID, 'One.\n');
    const watcher = watch(api);

    await pushRoot(
      root,
      [
        {
          kind: 'modified',
          path: PATH,
          text: file(ELEMENTS_ID, 'Elements', 'One.\n\n![](Elements.assets/photo.png)\n'),
          previousText: file(ELEMENTS_ID, 'Elements', 'One.\n'),
          assets: new Map([[ASSET, new TextEncoder().encode('PNG')]]),
        },
      ],
      provider,
      index,
      { api, progress: watcher.progress },
    );

    expect(watcher.lines).toEqual(['1/1 drive/Elements.md', `upload ${ASSET}`]);
  });
});

describe('a large rewrite (#32)', () => {
  const fixture = (name: string): string =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8');

  it('patches page breaks, list structure and escapes exactly', async () => {
    const api = drive();
    // The base does not round-trip through `seed` byte for byte (two blank
    // lines after the `\` + `&#x20;` items are lost), so what the document
    // actually holds after seeding is the base the push diffs against.
    await seed(api, ELEMENTS_ID, fixture('push-discovery-base.md'));
    const base = api.markdown(ELEMENTS_ID);
    const next = fixture('push-discovery-next.md');

    await push(api, [
      {
        kind: 'modified',
        path: 'drive/Elements.md',
        text: file(ELEMENTS_ID, 'Elements', next),
        previousText: file(ELEMENTS_ID, 'Elements', base),
      },
    ]);

    expect(api.markdown(ELEMENTS_ID)).toBe(next);
  });
});

describe('a Doc with several tabs (MANUAL §6, §7, #37)', () => {
  const TABBED_ID = 'doc-tabbed';
  const SECOND = 't.new1';
  const DIRECTORY = 'drive/Tabbed/';
  const ONE = 'drive/Tabbed/One.md';
  const TWO = 'drive/Tabbed/Two.md';

  /** A Drive holding one Doc of two tabs, each with a paragraph of its own. */
  async function tabbedDrive(): Promise<FakeDrive> {
    const api = createFakeDrive([
      { id: ROOT_ID, name: 'Docsync test', mimeType: 'application/vnd.google-apps.folder' },
      {
        id: SUB_ID,
        name: 'Sub',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [ROOT_ID],
      },
      { id: TABBED_ID, name: 'Tabbed', parents: [ROOT_ID] },
    ]);
    const writer = createGDriveWriter(api);
    await writer.writeTab(TABBED_ID, 't.0', parseMarkdown('One.\n'));
    expect(await writer.addTab(TABBED_ID, 'Two')).toBe(SECOND);
    await writer.writeTab(TABBED_ID, SECOND, parseMarkdown('Two.\n'));
    api.calls.length = 0;
    return api;
  }

  /** The checkout of that Doc: the directory, and one file per tab. */
  const tabbedIndex: DocumentIndex = new Map(
    [
      entry(DIRECTORY, TABBED_ID, { type: 'gdoc' }),
      entry(ONE, `${TABBED_ID}#t.0`),
      entry(TWO, `${TABBED_ID}#${SECOND}`),
    ].map((one) => [one.path, one]),
  );

  const pushTabs = (api: FakeDrive, changes: FileChange[], over: DocumentIndex = tabbedIndex) =>
    pushRoot(root, changes, provider, over, { api });

  it('patches the tab the file names, and no other', async () => {
    const api = await tabbedDrive();

    const report = await pushTabs(api, [
      {
        kind: 'modified',
        path: TWO,
        text: file(`${TABBED_ID}#${SECOND}`, 'Two', 'Two, rewritten.\n'),
        previousText: file(`${TABBED_ID}#${SECOND}`, 'Two', 'Two.\n'),
      },
    ]);

    expect(api.markdown(TABBED_ID, SECOND)).toBe('Two, rewritten.\n');
    // The other tab is untouched: a request with no `tabId` would have landed
    // in it, which is the trap #37 is about (MANUAL §7).
    expect(api.markdown(TABBED_ID, 't.0')).toBe('One.\n');
    expect(report).toEqual([
      {
        path: TWO,
        title: 'Two',
        action: 'updated',
        blocks: { kept: 0, updated: 1, inserted: 0, deleted: 0 },
      },
    ]);
  });

  it('refuses an edit whose base is not what that tab holds', async () => {
    const api = await tabbedDrive();

    // The base check is per tab: the text below is the *first* tab's, so this
    // is the source having changed under the push (MANUAL §7).
    await expect(
      pushTabs(api, [
        {
          kind: 'modified',
          path: TWO,
          text: file(`${TABBED_ID}#${SECOND}`, 'Two', 'One, rewritten.\n'),
          previousText: file(`${TABBED_ID}#${SECOND}`, 'Two', 'One.\n'),
        },
      ]),
    ).rejects.toThrow('the source changed');
  });

  it('makes a new tab of a new file with frontmatter in the directory', async () => {
    const api = await tabbedDrive();

    const report = await pushTabs(api, [
      { kind: 'added', path: 'drive/Tabbed/Three.md', text: file(undefined, 'Three', 'Three.\n') },
    ]);

    expect(api.calls.filter((one) => one.startsWith('addTab'))).toEqual([
      `addTab ${TABBED_ID} Three`,
    ]);
    expect(api.tabs(TABBED_ID).map((tab) => tab.title)).toEqual(['Tabbed', 'Two', 'Three']);
    expect(api.markdown(TABBED_ID, 't.new2')).toBe('Three.\n');
    // No Drive file and no folder was made: a tab is inside the Doc.
    expect(api.calls.some((one) => one.startsWith('create'))).toBe(false);
    expect(report).toEqual([{ path: 'drive/Tabbed/Three.md', title: 'Three', action: 'created' }]);
  });

  it('nests a new tab under the tab whose directory it sits in', async () => {
    const api = await tabbedDrive();

    await pushTabs(api, [
      {
        kind: 'added',
        path: 'drive/Tabbed/Two/Under.md',
        text: file(undefined, 'Under', 'Under.\n'),
      },
    ]);

    expect(api.tabs(TABBED_ID).at(-1)).toMatchObject({ title: 'Under', parentId: SECOND });
  });

  it('turns one tab into many from the checkout: a git mv and a new file', async () => {
    const api = await tabbedDrive();
    // The Doc as it is checked out today: one file, one tab.
    const before: DocumentIndex = new Map([
      ['drive/Tabbed.md', entry('drive/Tabbed.md', TABBED_ID)],
    ]);

    const report = await pushTabs(
      api,
      [
        { kind: 'renamed', path: ONE, previousPath: 'drive/Tabbed.md' },
        { kind: 'added', path: TWO, text: file(undefined, 'Two', 'Brand new.\n') },
      ],
      before,
    );

    // A is the Doc's own tab; B is a new tab of the same Doc, and not a new
    // Doc under a Drive folder named `Tabbed` (#37).
    expect(api.calls.filter((one) => one.startsWith('create'))).toEqual([]);
    expect(api.calls.filter((one) => one.startsWith('addTab'))).toEqual([
      `addTab ${TABBED_ID} Two`,
    ]);
    // The moved file names its tab, so the tab takes the filename's title, as
    // a renamed Doc file retitles its Doc (MANUAL §6).
    expect(api.calls).toContain(`renameTab ${TABBED_ID} t.0 One`);
    expect(report.map((one) => one.action)).toEqual(['renamed', 'created']);
  });

  it('retitles a tab when the file title changes, and renames no Drive file', async () => {
    const api = await tabbedDrive();

    const report = await pushTabs(api, [
      {
        kind: 'modified',
        path: TWO,
        text: file(`${TABBED_ID}#${SECOND}`, 'Full notes', 'Two.\n'),
        previousText: file(`${TABBED_ID}#${SECOND}`, 'Two', 'Two.\n'),
      },
    ]);

    expect(api.calls).toContain(`renameTab ${TABBED_ID} ${SECOND} Full notes`);
    expect(api.calls.some((one) => one.startsWith('rename '))).toBe(false);
    expect(api.files.get(TABBED_ID)?.name).toBe('Tabbed');
    expect(report[0]?.title).toBe('Full notes');
  });

  it('trashes the Doc when the whole directory is gone', async () => {
    const api = await tabbedDrive();

    const report = await pushTabs(api, [{ kind: 'deleted', path: DIRECTORY }]);

    expect(api.calls).toEqual([`trash ${TABBED_ID}`]);
    expect(api.files.get(TABBED_ID)?.trashed).toBe(true);
    expect(report).toEqual([{ path: DIRECTORY, title: 'Tabbed', action: 'trashed' }]);
  });

  it('retitles the Doc when the directory is renamed, and moves it when it moves', async () => {
    const api = await tabbedDrive();

    const report = await pushTabs(api, [
      { kind: 'renamed', path: 'drive/Sub/Notes/', previousPath: DIRECTORY },
    ]);

    // The directory is the Doc: its name is the title, its place is the Drive
    // folder. It is never created as a folder of its own (#37).
    expect(api.calls).toEqual([
      `move ${TABBED_ID} ${ROOT_ID}->${SUB_ID}`,
      `rename ${TABBED_ID} Notes`,
    ]);
    expect(report).toEqual([{ path: 'drive/Sub/Notes/', title: 'Notes', action: 'renamed' }]);
  });
});
