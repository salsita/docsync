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
const ROOTS = [NOTION, DRIVE, LEAF];

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
  ].map((one) => [one.path, one]),
);

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
};
const read = async (path: string): Promise<Uint8Array> => {
  const text = blobs[path];
  if (text === undefined) throw new Error(`no blob at ${path}`);
  return Buffer.from(text);
};
const plan = (...diff: DiffEntry[]) => planChanges(diff, ROOTS, index, read);
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
        changes: [{ kind: 'modified', path: 'Specs/Auth.md', text: blobs['Specs/Auth.md'] }],
      },
      {
        root: DRIVE,
        changes: [{ kind: 'modified', path: 'Files/logo.png', bytes: Buffer.from('PNG2') }],
      },
      {
        root: LEAF,
        changes: [{ kind: 'modified', path: 'notes/roadmap.md', text: blobs['notes/roadmap.md'] }],
      },
    ]);
  });

  it('owns a file root’s sibling directory', async () => {
    expect(await plan(A('notes/roadmap/Child.md'))).toEqual([
      { root: LEAF, changes: [{ kind: 'added', path: 'notes/roadmap/Child.md', text: FRONT }] },
    ]);
  });

  it('passes a deletion to its root and ignores one outside every root', async () => {
    expect(await plan(D('Specs/Auth.md'), D('README.md'))).toEqual([
      { root: NOTION, changes: [{ kind: 'deleted', path: 'Specs/Auth.md' }] },
    ]);
  });

  it('refuses an addition or a modification outside every root, by path', async () => {
    await expect(plan(A('README.md'))).rejects.toThrow(
      'README.md: not under any root in the manifest',
    );
    await expect(plan(M('README.md'))).rejects.toThrow(
      'README.md: not under any root in the manifest',
    );
  });

  it('refuses any touch of the index', async () => {
    const message = '.docsync/index.yaml: the index is written by fetch; do not edit it';
    await expect(plan(M('.docsync/index.yaml'))).rejects.toThrow(message);
    await expect(plan(D('.docsync/index.yaml'))).rejects.toThrow(message);
    await expect(plan(R('.docsync/index.yaml', 'Files/index.yaml'))).rejects.toThrow(message);
  });

  it('refuses a content change to a read-only export but lets a rename through', async () => {
    await expect(plan(M('Files/Rates.xlsx'))).rejects.toThrow(
      'Files/Rates.xlsx: a read-only export; edit it at the source',
    );
    await expect(plan(R('Files/Rates.xlsx', 'Files/Fees.xlsx', 'R090'))).rejects.toThrow(
      'Files/Fees.xlsx: a read-only export; edit it at the source',
    );
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
    await expect(plan(A('Specs/Plain.md'))).rejects.toThrow(
      'Specs/Plain.md: a new file under a Notion root must start with frontmatter (a --- line, then another) to become a page',
    );
    await expect(plan(A('Specs/pic.png'))).rejects.toThrow(
      'Specs/pic.png: Notion holds no files; only .md pages go under a Notion root',
    );
  });

  it('refuses a new file carrying an id the checkout already has', async () => {
    await expect(plan(A('Files/Copy.md'))).rejects.toThrow(
      `Files/Copy.md: its id notion:${'b'.repeat(32)} is already checked out as Specs/Auth.md; remove the id line to create a copy`,
    );
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

  it('treats a modified path the index does not know as an addition', async () => {
    expect(await plan({ status: 'T', path: 'Files/New.md' })).toEqual([
      { root: DRIVE, changes: [{ kind: 'added', path: 'Files/New.md', text: FRONT }] },
    ]);
  });
});
