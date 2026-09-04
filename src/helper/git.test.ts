import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGit, GitError } from './git.js';
import { createTempRepo, type TempRepo } from './temp-repo.mock.js';

const COMMITTER = { name: 'docsync', email: 'docsync@salsita.com', date: '2026-01-02T03:04:05Z' };
const AUTHOR = { name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-01-01T00:00:00Z' };

describe('createGit', () => {
  let repo: TempRepo;

  beforeAll(() => {
    repo = createTempRepo();
  });
  afterAll(() => repo.remove());

  it('writes a blob and reads its bytes back', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 10]);
    const sha = await repo.git.hashObject(bytes);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect([...(await repo.git.catBlob(sha))]).toEqual([...bytes]);
  });

  it('survives a git that exits before reading the input it was handed', async () => {
    // Most plumbing commands never read stdin, and an input this size cannot
    // fit in the pipe buffer, so the write lands on a pipe the child has
    // already closed. That is EPIPE on the child's stdin, and with nothing
    // listening for it there it became an unhandled 'error' event that killed
    // the whole helper mid-protocol — git then reported exit 128 (ticket 22).
    // The command's own exit code is the only answer that matters here; a
    // broken input pipe is the normal end of the race, not a failure of ours.
    const uncaught: unknown[] = [];
    const collect = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', collect);
    try {
      const exits = createGit(repo.gitDir, process.execPath);
      const big = Buffer.alloc(4 * 1024 * 1024, 0x61);
      await expect(exits.raw(['-e', ''], { input: big })).resolves.toBeDefined();
      await new Promise((done) => setTimeout(done, 100));
    } finally {
      process.off('uncaughtException', collect);
    }
    expect(uncaught).toEqual([]);
  });

  it('round-trips a tree with nested directories and a unicode name', async () => {
    const leaf = await repo.git.hashObject(Buffer.from('hello\n'));
    const inner = await repo.git.mktree([
      { mode: '100644', type: 'blob', sha: leaf, name: 'Ünïcode ✓.md' },
    ]);
    const outer = await repo.git.mktree([
      { mode: '040000', type: 'tree', sha: inner, name: 'Specs' },
      { mode: '100644', type: 'blob', sha: leaf, name: 'top.md' },
    ]);

    // `ls-tree -r` walks into subtrees and lists the blobs, which is exactly
    // the flat `path → sha` map the helper works in.
    expect(await repo.git.lsTree(outer)).toEqual([
      { mode: '100644', type: 'blob', sha: leaf, name: 'Specs/Ünïcode ✓.md' },
      { mode: '100644', type: 'blob', sha: leaf, name: 'top.md' },
    ]);
  });

  it('commits a tree with an author and a committer of its own', async () => {
    const blob = await repo.git.hashObject(Buffer.from('body\n'));
    const tree = await repo.git.mktree([{ mode: '100644', type: 'blob', sha: blob, name: 'a.md' }]);
    const first = await repo.git.commitTree({
      tree,
      message: 'Add 1 document\n\na.md\n',
      author: AUTHOR,
      committer: COMMITTER,
    });

    expect(await repo.git.treeOf(first)).toBe(tree);
    expect(await repo.git.text(['log', '-1', '--format=%an|%ae|%aI|%cn|%ce', first])).toBe(
      'Ada Lovelace|ada@example.com|2026-01-01T00:00:00Z|docsync|docsync@salsita.com',
    );
    // `%B` is the raw body, which `commit-tree` ends with exactly one newline.
    expect(await repo.git.text(['log', '-1', '--format=%B', first])).toBe(
      'Add 1 document\n\na.md\n',
    );

    const second = await repo.git.commitTree({
      tree,
      parents: [first],
      message: 'again',
      author: AUTHOR,
      committer: COMMITTER,
    });
    expect(await repo.git.text(['rev-parse', `${second}^`])).toBe(first);
    expect(await repo.git.isAncestor(first, second)).toBe(true);
    expect(await repo.git.isAncestor(second, first)).toBe(false);

    await repo.git.updateRef('refs/docsync/origin/main', second);
    expect(await repo.git.revParse('refs/docsync/origin/main')).toBe(second);
    expect(await repo.git.revParse('refs/heads/nope')).toBeUndefined();
  });

  it('reports adds, modifications, deletions and renames between two commits', async () => {
    const write = (name: string, body: string): void =>
      writeFileSync(join(repo.root, name), body, 'utf8');

    write('kept.md', 'one\n');
    write('gone.md', 'two\n');
    write('moved.md', `three${'\n'.repeat(20)}`);
    repo.run('add', 'kept.md', 'gone.md', 'moved.md');
    repo.run('commit', '--quiet', '-m', 'before');
    const before = repo.run('rev-parse', 'HEAD');

    write('kept.md', 'one changed\n');
    write('new.md', 'four\n');
    rmSync(join(repo.root, 'gone.md'));
    renameSync(join(repo.root, 'moved.md'), join(repo.root, 'elsewhere.md'));
    repo.run('add', 'kept.md', 'new.md', 'gone.md', 'moved.md', 'elsewhere.md');
    repo.run('commit', '--quiet', '-m', 'after');
    const after = repo.run('rev-parse', 'HEAD');

    expect(
      (await repo.git.diffTree(before, after)).map((entry) => [
        entry.status,
        entry.previousPath ?? '',
        entry.path,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['M', '', 'kept.md'],
        ['D', '', 'gone.md'],
        ['A', '', 'new.md'],
        ['R100', 'moved.md', 'elsewhere.md'],
      ]),
    );
  });

  it('turns a failed command into an error carrying git’s message', async () => {
    const missingBlob = repo.git.text(['cat-file', 'blob', 'f'.repeat(40)]);
    await expect(missingBlob).rejects.toBeInstanceOf(GitError);
    await expect(repo.git.text(['cat-file', 'blob', 'f'.repeat(40)])).rejects.toThrow(
      /^git cat-file blob f+ failed: /,
    );
  });

  it('says so when git itself cannot be run', async () => {
    const missing = createGit(repo.gitDir, 'git-that-is-not-installed');
    await expect(missing.text(['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitError);
  });
});
