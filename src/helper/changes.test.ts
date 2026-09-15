import { describe, expect, it } from 'vitest';
import type { IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { planChanges } from './changes.js';
import type { DiffEntry } from './git.js';

const NOTION: Root = { src: { source: 'notion', id: 'a'.repeat(32) }, path: 'Specs/', ignore: [] };
const DRIVE: Root = {
  src: { source: 'gdocs', id: '1DriveFolderIdXXXXXXXXXX' },
  path: 'Files/',
  ignore: [],
};
const LEAF: Root = {
  src: { source: 'gdocs', id: '1LeafDocIdXXXXXXXXXXXXXX' },
  path: 'notes/roadmap.md',
  ignore: [],
};
/** A folder pulled for context and never pushed to (MANUAL §4, ticket 25). */
const INPUTS: Root = {
  src: { source: 'gdocs', id: '1InputsFolderIdXXXXXXXXX' },
  path: 'Inputs/',
  ignore: [],
  readOnly: true,
};
/** A client's folder: every edit under it is pushed as a suggestion (ticket 33). */
const CLIENT: Root = {
  src: { source: 'gdocs', id: '1ClientFolderIdXXXXXXXXX' },
  path: 'Client/',
  ignore: [],
  comments: true,
  suggest: true,
};
/** A recurring call: read-only by nature, with no `readonly` to say so (ticket 38). */
const CALLS: Root = {
  src: { source: 'calendar', id: '0gce3vkvut6cj027fb86qrtc2a' },
  path: 'Calls/',
  ignore: [],
};
const ROOTS = [NOTION, DRIVE, LEAF, INPUTS, CLIENT, CALLS];

const entry = (
  path: string,
  type: IndexEntry['type'],
  extra: Partial<IndexEntry> = {},
): IndexEntry => ({
  path,
  src: {
    source: type === 'notion-page' ? 'notion' : 'gdocs',
    id:
      type === 'notion-page' ? 'b'.repeat(32) : `1Id${path.replaceAll(/\W/g, 'x').padEnd(20, 'x')}`,
  },
  type,
  lastEditedTime: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const index = new Map(
  [
    entry('Specs/Auth.md', 'notion-page'),
    entry('Files/Plan.md', 'gdoc'),
    entry('Files/logo.png', 'drive-file'),
    entry('Files/notes.md', 'drive-file'),
    entry('Files/Rates.xlsx', 'drive-file', { readOnly: true }),
    entry('notes/roadmap.md', 'gdoc'),
    entry('Inputs/Brief.md', 'gdoc'),
    entry('Inputs/contract.pdf', 'drive-file'),
    entry('Client/Brief.md', 'gdoc'),
    entry('Client/logo.png', 'drive-file'),
    entry('Client/Plain.md', 'gdoc'),
    entry('Client/Brief.assets/shot.png', 'asset', {
      document: 'Client/Brief.md',
      checksum: 'c'.repeat(64),
    }),
    entry('Specs/Auth.assets/photo.png', 'asset', {
      document: 'Specs/Auth.md',
      checksum: 'a'.repeat(64),
    }),
  ].map((one) => [one.path, one]),
);

/**
 * A Google Doc of two tabs, checked out as a directory of one file per tab,
 * with an entry for the directory itself (MANUAL §6, ticket 37).
 */
const TABBED = '1IdTabbedDocXXXXXXXXXXXX';
for (const one of [
  { path: 'Files/Tabbed/', id: TABBED },
  { path: 'Files/Tabbed/One.md', id: `${TABBED}#t.0` },
  { path: 'Files/Tabbed/Two.md', id: `${TABBED}#t.1` },
]) {
  index.set(one.path, {
    path: one.path,
    src: { source: 'gdocs', id: one.id },
    type: 'gdoc',
    lastEditedTime: '2026-01-01T00:00:00.000Z',
  });
}

const FRONT = '---\ntitle: New\n---\n\nBody.\n';
const blobs: Record<string, string> = {
  'Specs/Auth.md': `---\nid: notion:${'b'.repeat(32)}\ntitle: Auth\n---\n\nEdited.\n`,
  'Specs/New.md': FRONT,
  'Specs/Plain.md': 'no frontmatter\n',
  'Specs/pic.png': 'PNG',
  'Files/Plain.md': 'no frontmatter\n',
  'Files/New.md': FRONT,
  'Files/Copy.md': `---\nid: notion:${'b'.repeat(32)}\ntitle: Auth\n---\n\nCopied.\n`,
  'Files/logo.png': 'PNG2',
  'Files/notes.md': FRONT,
  'Files/Plan.md': 'frontmatter gone\n',
  'Files/Rates.xlsx': 'XLSX',
  'Files/Moved.md': FRONT,
  'notes/roadmap.md': '---\nid: gdocs:1Id\n---\n\nRoad.\n',
  'notes/roadmap/Child.md': FRONT,
  'README.md': 'outside\n',
  'Specs/comments.md': FRONT,
  'Specs/Auth.assets/photo.png': 'PNGBYTES',
  'Specs/Auth.assets/new.png': 'NEWPNG',
  'Files/Plan.assets/shot.png': 'SHOT',
  'Inputs/Brief.md': `---\nid: gdocs:1IdInputsBrief\n---\n\nEdited brief.\n`,
  'Inputs/Notes.md': FRONT,
  'Inputs/contract.pdf': 'PDF',
  'Inputs/Brief.assets/scan.png': 'SCAN',
  'Client/Brief.md': `---\nid: gdocs:1IdClientBrief\n---\n\nEdited brief.\n`,
  'Client/Notes.md': FRONT,
  'Client/Plain.md': 'frontmatter gone\n',
  'Client/logo.png': 'PNG2',
  'Client/Brief.assets/shot.png': 'SHOT2',
  'Files/Tabbed/One.md': `---\nid: gdocs:${TABBED}#t.0\ntitle: One\n---\n\nOne, edited.\n`,
  'Files/Tabbed/Two.md': `---\nid: gdocs:${TABBED}#t.1\ntitle: Two\n---\n\nTwo.\n`,
  'Files/Tabbed/Three.md': FRONT,
  'Files/Notes/One.md': `---\nid: gdocs:${TABBED}#t.0\ntitle: One\n---\n\nOne.\n`,
  'Files/Notes/Two.md': `---\nid: gdocs:${TABBED}#t.1\ntitle: Two\n---\n\nTwo.\n`,
  'Files/Out.md': `---\nid: gdocs:${TABBED}#t.0\ntitle: One\n---\n\nOne.\n`,
  'Client/Tabbed/Three.md': FRONT,
};
const read = async (path: string): Promise<Uint8Array> => {
  const text = blobs[path];
  if (text === undefined) throw new Error(`no blob at ${path}`);
  return Buffer.from(text);
};

/** The served tree: what each path held before the pushed commits (§7). */
const BASE_AUTH = `---\nid: notion:${'b'.repeat(32)}\ntitle: Auth\n---\n\nBase.\n`;
const BASE_ROAD = '---\nid: gdocs:1Id\n---\n\nBase road.\n';
const baseBlobs: Record<string, string> = {
  'Specs/Auth.md': BASE_AUTH,
  'Files/Plan.md': '---\nid: gdocs:1Id\n---\n\nBase plan.\n',
  'Files/logo.png': 'PNG',
  'Files/notes.md': 'plain notes\n',
  'notes/roadmap.md': BASE_ROAD,
  'Client/Brief.md': '---\nid: gdocs:1IdClientBrief\n---\n\nBase brief.\n',
  'Files/Tabbed/One.md': `---\nid: gdocs:${TABBED}#t.0\ntitle: One\n---\n\nOne.\n`,
  'Files/Tabbed/Two.md': `---\nid: gdocs:${TABBED}#t.1\ntitle: Two\n---\n\nTwo.\n`,
};
const readBase = async (path: string): Promise<Uint8Array | undefined> => {
  const text = baseBlobs[path];
  return text === undefined ? undefined : Buffer.from(text);
};
const planned = (...diff: DiffEntry[]) => planChanges(diff, ROOTS, index, read, readBase);
/** The per-root plan alone, which is what most of these tests are about. */
const plan = async (...diff: DiffEntry[]) => (await planned(...diff)).roots;
/** Every message this push would be refused with, in diff order (ticket 31). */
const refusals = async (...diff: DiffEntry[]) =>
  (await planned(...diff)).refusals.map((one) => one.message);
/** The first of them: what `docsync push` fails with. */
const refusal = async (...diff: DiffEntry[]) => (await refusals(...diff))[0] ?? '';
const D = (path: string): DiffEntry => ({ status: 'D', path });
const M = (path: string): DiffEntry => ({ status: 'M', path });
const A = (path: string): DiffEntry => ({ status: 'A', path });
const R = (previousPath: string, path: string, status = 'R100'): DiffEntry => ({
  status,
  path,
  previousPath,
});

describe('planChanges', () => {
  it('types a modified file by the index and groups by root in manifest order', async () => {
    expect(await plan(M('Files/logo.png'), M('Specs/Auth.md'), M('notes/roadmap.md'))).toEqual([
      {
        root: NOTION,
        changes: [
          {
            kind: 'modified',
            path: 'Specs/Auth.md',
            text: blobs['Specs/Auth.md'],
            previousText: BASE_AUTH,
            // The document's own `<title>.assets/`, as the pushed tree holds
            // it: a push may have to upload one of them (MANUAL §12 phase 2).
            assets: new Map([['Specs/Auth.assets/photo.png', Buffer.from('PNGBYTES')]]),
          },
        ],
      },
      {
        root: DRIVE,
        changes: [{ kind: 'modified', path: 'Files/logo.png', bytes: Buffer.from('PNG2') }],
      },
      {
        root: LEAF,
        changes: [
          {
            kind: 'modified',
            path: 'notes/roadmap.md',
            text: blobs['notes/roadmap.md'],
            previousText: BASE_ROAD,
          },
        ],
      },
    ]);
  });

  it('owns a file root’s sibling directory', async () => {
    expect(await plan(A('notes/roadmap/Child.md'))).toEqual([
      { root: LEAF, changes: [{ kind: 'added', path: 'notes/roadmap/Child.md', text: FRONT }] },
    ]);
  });

  it('passes a deletion to its root and keeps one outside every root local', async () => {
    expect(await plan(D('Specs/Auth.md'), D('README.md'))).toEqual([
      { root: NOTION, changes: [{ kind: 'deleted', path: 'Specs/Auth.md' }] },
    ]);
  });

  describe('everything outside a root is local (MANUAL §7 step 3, ticket 35)', () => {
    it('plans an addition, an edit and a deletion under no root as local, refusing none', async () => {
      const {
        roots,
        refusals: found,
        local,
      } = await planned(A('notes/a.md'), M('README.md'), D('scratch/old.txt'));
      expect(roots).toEqual([]);
      expect(found).toEqual([]);
      expect(local).toEqual(['notes/a.md', 'README.md', 'scratch/old.txt']);
    });

    it('creates a file renamed into a root, with no memory of where it came from', async () => {
      const { roots, local } = await planned(R('README.md', 'Specs/New.md', 'R100'));
      expect(roots).toEqual([
        { root: NOTION, changes: [{ kind: 'added', path: 'Specs/New.md', text: FRONT }] },
      ]);
      expect(local).toEqual([]);
    });

    it('trashes a document renamed out of a root and keeps the file local (MANUAL §8)', async () => {
      const { roots, refusals: found, local } = await planned(R('Specs/Auth.md', 'notes/auth.md'));
      expect(found).toEqual([]);
      expect(roots).toEqual([
        { root: NOTION, changes: [{ kind: 'deleted', path: 'Specs/Auth.md' }] },
      ]);
      expect(local).toEqual(['notes/auth.md']);
    });

    it('touches no root when a local file is renamed to another local path', async () => {
      const { roots, local } = await planned(R('README.md', 'docs/README.md'));
      expect(roots).toEqual([]);
      expect(local).toEqual(['docs/README.md']);
    });

    it('still refuses the index, which is the one path under no root that is not local', async () => {
      expect(await refusals(M('.docsync/index.yaml'))).toEqual([
        '.docsync/index.yaml: the index is written by fetch; do not edit it',
      ]);
      expect((await planned(M('.docsync/index.yaml'))).local).toEqual([]);
    });
  });

  it('refuses any touch of the index', async () => {
    const message = '.docsync/index.yaml: the index is written by fetch; do not edit it';
    expect(await refusals(M('.docsync/index.yaml'))).toEqual([message]);
    expect(await refusals(D('.docsync/index.yaml'))).toEqual([message]);
    expect(await refusals(R('.docsync/index.yaml', 'Files/index.yaml'))).toEqual([message]);
  });

  it('refuses a content change to a read-only export but lets a rename through', async () => {
    expect(await refusals(M('Files/Rates.xlsx'))).toEqual([
      'Files/Rates.xlsx: a read-only export; edit it at the source',
    ]);
    expect(await refusals(R('Files/Rates.xlsx', 'Files/Fees.xlsx', 'R090'))).toEqual([
      'Files/Fees.xlsx: a read-only export; edit it at the source',
    ]);
    expect(await plan(R('Files/Rates.xlsx', 'Files/Fees.xlsx'))).toEqual([
      {
        root: DRIVE,
        changes: [{ kind: 'renamed', path: 'Files/Fees.xlsx', previousPath: 'Files/Rates.xlsx' }],
      },
    ]);
  });

  it('carries no content on a pure rename and the typed content on a rename with edits', async () => {
    expect(await plan(R('Specs/Auth.md', 'Specs/Login.md'))).toEqual([
      {
        root: NOTION,
        changes: [{ kind: 'renamed', path: 'Specs/Login.md', previousPath: 'Specs/Auth.md' }],
      },
    ]);
    blobs['Specs/Login.md'] = 'edited\n';
    expect(await plan(R('Specs/Auth.md', 'Specs/Login.md', 'R080'))).toEqual([
      {
        root: NOTION,
        changes: [
          {
            kind: 'renamed',
            path: 'Specs/Login.md',
            previousPath: 'Specs/Auth.md',
            text: 'edited\n',
            previousText: BASE_AUTH,
          },
        ],
      },
    ]);
    blobs['Files/moved.png'] = 'PNG3';
    expect(await plan(R('Files/logo.png', 'Files/moved.png', 'R050'))).toEqual([
      {
        root: DRIVE,
        changes: [
          {
            kind: 'renamed',
            path: 'Files/moved.png',
            previousPath: 'Files/logo.png',
            bytes: Buffer.from('PNG3'),
          },
        ],
      },
    ]);
  });

  it('turns a rename across roots into a deletion there and an addition here', async () => {
    expect(await plan(R('Specs/Auth.md', 'Files/Moved.md'))).toEqual([
      { root: NOTION, changes: [{ kind: 'deleted', path: 'Specs/Auth.md' }] },
      { root: DRIVE, changes: [{ kind: 'added', path: 'Files/Moved.md', text: FRONT }] },
    ]);
    // From outside every root, or from a path the index never held.
    expect(await plan(R('README.md', 'Files/Moved.md'))).toEqual([
      { root: DRIVE, changes: [{ kind: 'added', path: 'Files/Moved.md', text: FRONT }] },
    ]);
  });

  it('adds a .md with frontmatter as text under either source', async () => {
    expect(await plan(A('Specs/New.md'), A('Files/New.md'))).toEqual([
      { root: NOTION, changes: [{ kind: 'added', path: 'Specs/New.md', text: FRONT }] },
      { root: DRIVE, changes: [{ kind: 'added', path: 'Files/New.md', text: FRONT }] },
    ]);
  });

  it('adds a .md without frontmatter as bytes on Drive and refuses it on Notion', async () => {
    expect(await plan(A('Files/Plain.md'))).toEqual([
      {
        root: DRIVE,
        changes: [
          { kind: 'added', path: 'Files/Plain.md', bytes: Buffer.from('no frontmatter\n') },
        ],
      },
    ]);
    expect(await refusals(A('Specs/Plain.md'))).toEqual([
      'Specs/Plain.md: a new file under a Notion root must start with frontmatter (a --- line, then another) to become a page',
    ]);
    expect(await refusals(A('Specs/pic.png'))).toEqual([
      'Specs/pic.png: Notion holds no files; only .md pages go under a Notion root',
    ]);
  });

  it('refuses a new file carrying an id the checkout already has', async () => {
    expect(await refusals(A('Files/Copy.md'))).toEqual([
      `Files/Copy.md: its id notion:${'b'.repeat(32)} is already checked out as Specs/Auth.md; remove the id line to create a copy`,
    ]);
  });

  it('treats frontmatter added to a plain file, or removed from a document, as delete plus add', async () => {
    expect(await plan(M('Files/notes.md'), M('Files/Plan.md'))).toEqual([
      {
        root: DRIVE,
        changes: [
          { kind: 'deleted', path: 'Files/notes.md' },
          { kind: 'added', path: 'Files/notes.md', text: FRONT },
          { kind: 'deleted', path: 'Files/Plan.md' },
          { kind: 'added', path: 'Files/Plan.md', bytes: Buffer.from('frontmatter gone\n') },
        ],
      },
    ]);
  });

  it('carries no base text for a binary, an addition or a path the base did not hold', async () => {
    const [drive] = await plan(M('Files/logo.png'), A('Files/New.md'));
    expect(drive?.changes.every((change) => change.previousText === undefined)).toBe(true);

    // A document the served tree does not hold: the diff has no base to work
    // from, and the adapter falls back to what it can do without one.
    delete baseBlobs['Specs/Auth.md'];
    const [notion] = await plan(M('Specs/Auth.md'));
    expect(notion?.changes[0]?.previousText).toBeUndefined();
    baseBlobs['Specs/Auth.md'] = BASE_AUTH;
  });

  describe('the comment sidecar is read-only (MANUAL §6)', () => {
    const message =
      'Specs/Auth.comments.md is read-only; comments are only pulled in this version. ' +
      'Restore it with git checkout -- Specs/Auth.comments.md';

    it('refuses one that was modified', async () => {
      expect(await refusal(M('Specs/Auth.comments.md'))).toBe(message);
    });

    it('refuses one that was added', async () => {
      expect(await refusal(A('Specs/Auth.comments.md'))).toBe(message);
    });

    it('refuses one that was deleted', async () => {
      expect(await refusal(D('Specs/Auth.comments.md'))).toBe(message);
    });

    it('refuses one that was renamed, naming the path it came from', async () => {
      expect(await refusal(R('Specs/Auth.comments.md', 'Specs/Notes.comments.md'))).toContain(
        'Specs/Auth.comments.md is read-only',
      );
    });

    it('refuses it whatever else the push holds, and plans the rest for the preview', async () => {
      const both = await planned(M('Specs/Auth.md'), D('Specs/Auth.comments.md'));
      expect(both.refusals.map((one) => one.message)).toEqual([message]);
      expect(both.roots[0]?.changes[0]?.path).toBe('Specs/Auth.md');
    });

    it('lets a document simply named `comments.md` through', async () => {
      const [notion] = await plan(A('Specs/comments.md'));
      expect(notion?.changes[0]?.path).toBe('Specs/comments.md');
    });

    it('ignores one deleted outside every root, which is `docsync remove`', async () => {
      expect(await plan(D('gone/Auth.comments.md'))).toEqual([]);
    });
  });

  describe('a read-only root is never pushed to (MANUAL §4, §7 step 3)', () => {
    const message = (path: string): string =>
      `${path} is under a read-only root (Inputs/); nothing under it is pushed. ` +
      `Restore it with git checkout -- ${path}`;

    it('refuses a modified document', async () => {
      expect(await refusal(M('Inputs/Brief.md'))).toBe(message('Inputs/Brief.md'));
    });

    it('refuses an added file, document or not', async () => {
      expect(await refusal(A('Inputs/Notes.md'))).toBe(message('Inputs/Notes.md'));
      expect(await refusal(A('Inputs/Brief.assets/scan.png'))).toBe(
        message('Inputs/Brief.assets/scan.png'),
      );
    });

    it('refuses a deletion, which elsewhere would be an unsubscribe', async () => {
      expect(await refusal(D('Inputs/contract.pdf'))).toBe(message('Inputs/contract.pdf'));
    });

    it('refuses a rename inside it, naming the path it came from', async () => {
      expect(await refusal(R('Inputs/Brief.md', 'Inputs/Summary.md'))).toBe(
        message('Inputs/Brief.md'),
      );
    });

    it('refuses a rename out of it and a rename into it', async () => {
      expect(await refusal(R('Inputs/Brief.md', 'Files/Brief.md'))).toBe(
        message('Inputs/Brief.md'),
      );
      expect(await refusal(R('Files/Plan.md', 'Inputs/Plan.md'))).toBe(message('Inputs/Plan.md'));
    });

    it('refuses a sidecar under it as a read-only root, not as a sidecar', async () => {
      expect(await refusal(M('Inputs/Brief.comments.md'))).toBe(
        message('Inputs/Brief.comments.md'),
      );
    });

    it('says why in the short form `docsync status` prints (ticket 31)', async () => {
      const { refusals: found } = await planned(M('Inputs/Brief.md'));
      expect(found).toEqual([
        {
          path: 'Inputs/Brief.md',
          reason: 'under read-only root Inputs/',
          message: message('Inputs/Brief.md'),
        },
      ]);
    });

    it('refuses a change under a calendar root, which says no `readonly` (ticket 38)', async () => {
      const path = 'Calls/2026-09-01 09-00 Review/Notes.md';
      expect(await refusal(M(path))).toBe(
        `${path} is under a read-only root (Calls/); nothing under it is pushed. ` +
          `Restore it with git checkout -- ${path}`,
      );
    });

    it('refuses it whatever else the push holds, and plans the rest for the preview', async () => {
      const both = await planned(M('Specs/Auth.md'), M('Inputs/Brief.md'));
      expect(both.refusals.map((one) => one.message)).toEqual([message('Inputs/Brief.md')]);
      expect(both.roots[0]?.changes[0]?.path).toBe('Specs/Auth.md');
    });

    it('leaves a sibling root that is not read-only alone', async () => {
      expect(await plan(M('Files/logo.png'))).toEqual([
        {
          root: DRIVE,
          changes: [{ kind: 'modified', path: 'Files/logo.png', bytes: Buffer.from('PNG2') }],
        },
      ]);
    });
  });

  describe('only an edit is pushed under a suggest root (MANUAL §4, §7 step 3)', () => {
    const message = (path: string): string =>
      `${path} is under a suggest root (Client/); only edits to existing documents ` +
      `can be suggested. Restore it with git checkout -- ${path}`;

    it('lets an edit to a document through, which is what becomes a suggestion', async () => {
      expect(await plan(M('Client/Brief.md'))).toEqual([
        {
          root: CLIENT,
          changes: [
            {
              kind: 'modified',
              path: 'Client/Brief.md',
              text: blobs['Client/Brief.md'],
              previousText: baseBlobs['Client/Brief.md'],
              assets: new Map([['Client/Brief.assets/shot.png', Buffer.from('SHOT2')]]),
            },
          ],
        },
      ]);
    });

    it('refuses an added file', async () => {
      expect(await refusal(A('Client/Notes.md'))).toBe(message('Client/Notes.md'));
    });

    it('refuses a deletion, which would trash the client\u2019s document', async () => {
      expect(await refusal(D('Client/Brief.md'))).toBe(message('Client/Brief.md'));
    });

    it('refuses a rename, naming the path it came from', async () => {
      expect(await refusal(R('Client/Brief.md', 'Client/Summary.md'))).toBe(
        message('Client/Brief.md'),
      );
    });

    it('refuses a new revision of a binary and a changed asset', async () => {
      expect(await refusal(M('Client/logo.png'))).toBe(message('Client/logo.png'));
      expect(await refusal(M('Client/Brief.assets/shot.png'))).toBe(
        message('Client/Brief.assets/shot.png'),
      );
    });

    it('refuses a document whose frontmatter was removed, which is a trash and a create', async () => {
      expect(await refusal(M('Client/Plain.md'))).toBe(message('Client/Plain.md'));
    });

    it('says why in the short form `docsync status` prints', async () => {
      const { refusals: found } = await planned(A('Client/Notes.md'));
      expect(found).toEqual([
        {
          path: 'Client/Notes.md',
          reason: 'under a suggest root Client/',
          message: message('Client/Notes.md'),
        },
      ]);
    });

    it('leaves a sibling root that does not suggest alone', async () => {
      expect((await plan(M('Files/logo.png')))[0]?.root).toBe(DRIVE);
    });
  });

  describe('assets (MANUAL §12 phase 2)', () => {
    it('carries a new asset under a Notion root as bytes, where a plain file is refused', async () => {
      expect(await plan(A('Specs/Auth.assets/new.png'))).toEqual([
        {
          root: NOTION,
          changes: [
            { kind: 'added', path: 'Specs/Auth.assets/new.png', bytes: Buffer.from('NEWPNG') },
          ],
        },
      ]);
      expect(await refusal(A('Specs/pic.png'))).toMatch(/Notion holds no files/);
    });

    it('carries changed asset bytes, with no base text to diff them against', async () => {
      expect(await plan(M('Specs/Auth.assets/photo.png'))).toEqual([
        {
          root: NOTION,
          changes: [
            {
              kind: 'modified',
              path: 'Specs/Auth.assets/photo.png',
              bytes: Buffer.from('PNGBYTES'),
            },
          ],
        },
      ]);
    });

    it('passes a deleted asset to its root', async () => {
      expect(await plan(D('Specs/Auth.assets/photo.png'))).toEqual([
        { root: NOTION, changes: [{ kind: 'deleted', path: 'Specs/Auth.assets/photo.png' }] },
      ]);
    });

    it('hands a changed document the bytes of every file in its assets directory', async () => {
      const [notion] = await plan(M('Specs/Auth.md'), A('Specs/Auth.assets/new.png'));
      expect([...(notion?.changes[0]?.assets ?? new Map()).keys()]).toEqual([
        'Specs/Auth.assets/new.png',
        'Specs/Auth.assets/photo.png',
      ]);
    });

    it('leaves out a file this push deleted', async () => {
      const [notion] = await plan(M('Specs/Auth.md'), D('Specs/Auth.assets/photo.png'));
      expect(notion?.changes[0]?.assets).toBeUndefined();
      expect(notion?.changes[1]).toEqual({
        kind: 'deleted',
        path: 'Specs/Auth.assets/photo.png',
      });
    });

    it('carries an asset under a Drive root too', async () => {
      expect(await plan(A('Files/Plan.assets/shot.png'))).toEqual([
        {
          root: DRIVE,
          changes: [
            { kind: 'added', path: 'Files/Plan.assets/shot.png', bytes: Buffer.from('SHOT') },
          ],
        },
      ]);
    });
  });

  describe('every refusal is collected, so status can list them (ticket 31)', () => {
    it('answers all of them in diff order, and push fails on the first', async () => {
      const {
        roots,
        refusals: found,
        local,
      } = await planned(
        M('Specs/Auth.md'),
        A('README.md'),
        M('Specs/Auth.comments.md'),
        M('Inputs/Brief.md'),
        M('.docsync/index.yaml'),
      );
      // The file under no root is not a refusal any more; it is local.
      expect(local).toEqual(['README.md']);
      expect(found.map((one) => one.path)).toEqual([
        'Specs/Auth.comments.md',
        'Inputs/Brief.md',
        '.docsync/index.yaml',
      ]);
      // What was not refused is still planned: that is the preview.
      expect(roots).toHaveLength(1);
      expect(roots[0]?.changes[0]?.path).toBe('Specs/Auth.md');
    });

    it('says a deletion outside every root is local, not refused (ticket 35)', async () => {
      const { roots, refusals: found, local } = await planned(D('README.md'));
      expect(roots).toEqual([]);
      expect(found).toEqual([]);
      expect(local).toEqual(['README.md']);
    });

    it('carries the reason `docsync status` prints after the path', async () => {
      const { refusals: found } = await planned(M('Files/Rates.xlsx'), M('Inputs/Brief.md'));
      expect(found.map((one) => `${one.path}: ${one.reason}`)).toEqual([
        'Files/Rates.xlsx: a read-only export; edit it at the source',
        'Inputs/Brief.md: under read-only root Inputs/',
      ]);
    });
  });

  it('treats a modified path the index does not know as an addition', async () => {
    expect(await plan({ status: 'T', path: 'Files/New.md' })).toEqual([
      { root: DRIVE, changes: [{ kind: 'added', path: 'Files/New.md', text: FRONT }] },
    ]);
  });
});

describe('a Google Doc of several tabs (MANUAL §6, §8, ticket 37)', () => {
  const REFUSAL =
    'Files/Tabbed/Two.md is a tab of Files/Tabbed/; deleting a tab is permanent, ' +
    'so docsync does not do it. Delete it in Docs, or restore it with ' +
    'git checkout -- Files/Tabbed/Two.md';

  it('refuses to delete one tab of a Doc, and pushes nothing for it', async () => {
    // `deleteTab` has no trash, and §8 says a deletion is never permanent.
    expect(await refusal(D('Files/Tabbed/Two.md'))).toBe(REFUSAL);
    expect(await plan(D('Files/Tabbed/Two.md'))).toEqual([]);
  });

  it('refuses a tab file renamed out of its directory in the same words', async () => {
    expect(await refusal(R('Files/Tabbed/Two.md', 'Files/Out.md'))).toBe(REFUSAL);
  });

  it('trashes the Doc when every tab file is gone', async () => {
    // The directory is the Doc, so deleting the whole of it is deleting the
    // document, which is a trashing like any other (MANUAL §8).
    expect(await plan(D('Files/Tabbed/One.md'), D('Files/Tabbed/Two.md'))).toEqual([
      { root: DRIVE, changes: [{ kind: 'deleted', path: 'Files/Tabbed/' }] },
    ]);
    expect(await refusals(D('Files/Tabbed/One.md'), D('Files/Tabbed/Two.md'))).toEqual([]);
  });

  it('renames the directory as one change when every tab file moves with it', async () => {
    const changes = await plan(
      R('Files/Tabbed/One.md', 'Files/Notes/One.md'),
      R('Files/Tabbed/Two.md', 'Files/Notes/Two.md'),
    );

    expect(changes).toEqual([
      {
        root: DRIVE,
        changes: [{ kind: 'renamed', path: 'Files/Notes/', previousPath: 'Files/Tabbed/' }],
      },
    ]);
  });

  it('carries the content of a tab file the directory rename also changed', async () => {
    const changes = await plan(
      R('Files/Tabbed/One.md', 'Files/Notes/One.md', 'R090'),
      R('Files/Tabbed/Two.md', 'Files/Notes/Two.md'),
    );

    expect(changes[0]?.changes).toEqual([
      { kind: 'renamed', path: 'Files/Notes/', previousPath: 'Files/Tabbed/' },
      expect.objectContaining({ kind: 'modified', path: 'Files/Notes/One.md' }),
    ]);
  });

  it('is an ordinary rename when a tab file is renamed inside the directory', async () => {
    // The tab is retitled at the source; nothing moves out of the Doc.
    expect(await plan(R('Files/Tabbed/Two.md', 'Files/Tabbed/Second.md'))).toEqual([
      {
        root: DRIVE,
        changes: [
          {
            kind: 'renamed',
            path: 'Files/Tabbed/Second.md',
            previousPath: 'Files/Tabbed/Two.md',
          },
        ],
      },
    ]);
  });

  it('is a plain addition when a new file appears in the directory', async () => {
    // A new `.md` with frontmatter inside a tabbed Doc's directory is a new
    // tab; the adapter is what knows that (ticket 37).
    expect(await plan(A('Files/Tabbed/Three.md'))).toEqual([
      { root: DRIVE, changes: [{ kind: 'added', path: 'Files/Tabbed/Three.md', text: FRONT }] },
    ]);
  });

  it('refuses a new tab under a suggest root, as it refuses any add', async () => {
    // A tab file is a document, and a suggest root takes edits to documents
    // that are already there and nothing else (MANUAL §4, §7 step 3).
    expect(await refusal(A('Client/Tabbed/Three.md'))).toBe(
      'Client/Tabbed/Three.md is under a suggest root (Client/); only edits to existing ' +
        'documents can be suggested. Restore it with git checkout -- Client/Tabbed/Three.md',
    );
  });

  it('carries an edit to one tab file as an edit to that file', async () => {
    const changes = await plan(M('Files/Tabbed/One.md'));

    expect(changes[0]?.changes[0]).toMatchObject({
      kind: 'modified',
      path: 'Files/Tabbed/One.md',
    });
  });
});
