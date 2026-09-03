import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempRepo, type TempRepo } from './temp-repo.mock.js';
import { buildTree, readTree, sameTree, type TreeFile } from './tree.js';

describe('buildTree', () => {
  let repo: TempRepo;
  let blob: (body: string | Uint8Array) => Promise<TreeFile>;

  beforeAll(() => {
    repo = createTempRepo('docsync-tree-');
    blob = async (body) => ({
      sha: await repo.git.hashObject(typeof body === 'string' ? Buffer.from(body) : body),
      mode: '100644',
    });
  });
  afterAll(() => repo.remove());

  it('round-trips nested directories, a unicode name and a binary blob', async () => {
    const files = new Map<string, TreeFile>([
      ['.docsync/index.yaml', await blob('- path: a\n')],
      ['Specs/Deep/Ünïcode ✓.md', await blob('deep\n')],
      ['Specs/Auth.md', await blob('auth\n')],
      ['logo.png', await blob(Uint8Array.from([137, 80, 78, 71, 0, 255]))],
    ]);

    const tree = await buildTree(repo.git, files);
    const read = await readTree(repo.git, tree);

    expect([...read.keys()].sort()).toEqual([
      '.docsync/index.yaml',
      'Specs/Auth.md',
      'Specs/Deep/Ünïcode ✓.md',
      'logo.png',
    ]);
    expect(sameTree(files, read)).toBe(true);
    expect([...(await repo.git.catBlob(read.get('logo.png')?.sha ?? ''))]).toEqual([
      137, 80, 78, 71, 0, 255,
    ]);
  });

  it('is stable: the same files give the same tree sha', async () => {
    const one = new Map([['a/b.md', await blob('x\n')]]);
    const other = new Map([['a/b.md', await blob('x\n')]]);
    expect(await buildTree(repo.git, one)).toBe(await buildTree(repo.git, other));
  });

  it('writes the empty tree for no files', async () => {
    expect(await buildTree(repo.git, new Map())).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('tells trees apart by path and by blob', async () => {
    const a = new Map([['x.md', await blob('one\n')]]);
    expect(sameTree(a, new Map([['x.md', await blob('two\n')]]))).toBe(false);
    expect(sameTree(a, new Map([['y.md', await blob('one\n')]]))).toBe(false);
    expect(sameTree(a, new Map())).toBe(false);
    expect(sameTree(a, new Map([['x.md', await blob('one\n')]]))).toBe(true);
  });
});
