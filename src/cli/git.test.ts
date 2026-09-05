import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempRepo, type TempRepo } from '../helper/temp-repo.mock.js';
import { createGitRunner, type GitRunner } from './git.js';

describe('the git runner', () => {
  let repo: TempRepo;
  let git: GitRunner;
  let out: string[];
  let err: string[];

  beforeAll(() => {
    repo = createTempRepo('docsync-cli-git-');
    repo.run('config', 'user.name', 'Test');
    repo.run('config', 'user.email', 'test@example.com');
    writeFileSync(join(repo.root, 'a.txt'), 'a\n');
    repo.run('add', 'a.txt');
    repo.run('commit', '--quiet', '-m', 'first');
    mkdirSync(join(repo.root, 'deep', 'deeper'), { recursive: true });
  });
  afterAll(() => repo.remove());

  const runner = (cwd = repo.root): GitRunner => {
    out = [];
    err = [];
    return createGitRunner({
      cwd,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
  };

  it('captures what git said without printing it', async () => {
    git = runner();
    const result = await git.run(['rev-parse', '--abbrev-ref', 'HEAD']);

    expect(result).toMatchObject({ status: 0, stdout: 'main\n' });
    expect(out).toEqual([]);
  });

  it('answers a failure rather than throwing, with git’s own message', async () => {
    git = runner();
    const result = await git.run(['show', 'nope']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nope');
  });

  it('relays output to the terminal as git produces it', async () => {
    git = runner();
    const result = await git.run(['log', '--oneline'], { relay: true });

    expect(result.status).toBe(0);
    expect(out.join('')).toContain('first');
  });

  it('relays git’s errors too', async () => {
    git = runner();
    await git.run(['checkout', 'no-such-branch'], { relay: true });

    expect(err.join('')).toContain('no-such-branch');
  });

  it('adds to the environment of one run and no other', async () => {
    git = runner();
    const named = await git.run(['var', 'GIT_AUTHOR_IDENT'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Re Fetch', GIT_AUTHOR_EMAIL: 'all@example.com' },
    });

    expect(named.stdout).toContain('Re Fetch <all@example.com>');
    // The runner's own environment is what every other call gets.
    expect((await git.run(['var', 'GIT_AUTHOR_IDENT'])).stdout).not.toContain('Re Fetch');
  });

  it('throws with git’s message when the command had to work', async () => {
    git = runner();

    await expect(git.must(['show', 'nope'])).rejects.toThrow(/nope/);
    expect(await git.must(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('finds the checkout from any subdirectory', async () => {
    git = runner(join(repo.root, 'deep', 'deeper'));

    expect(await git.toplevel()).toBe(realpathSync(repo.root));
    expect(await git.gitDir()).toBe(realpathSync(repo.gitDir));
  });

  it('answers undefined outside a repository', async () => {
    git = runner(repo.root.replace(/[^/]+$/, ''));

    expect(await git.toplevel()).toBeUndefined();
  });

  it('knows a clean working tree from a dirty one', async () => {
    git = runner();
    expect(await git.isClean()).toBe(true);

    writeFileSync(join(repo.root, 'a.txt'), 'changed\n');
    expect(await git.isClean()).toBe(false);

    repo.run('checkout', '--', 'a.txt');
    expect(await git.isClean()).toBe(true);
  });

  it('names the branch HEAD is on, and says nothing when HEAD is detached', async () => {
    git = runner();
    expect(await git.branch()).toBe('main');

    repo.run('checkout', '--quiet', '--detach', 'HEAD');
    expect(await git.branch()).toBeUndefined();
    repo.run('checkout', '--quiet', 'main');
  });

  it('reads a remote URL, and says so when there is no such remote', async () => {
    git = runner();
    expect(await git.remoteUrl('origin')).toBeUndefined();

    repo.run('remote', 'add', 'origin', 'docsync::.docsync.yaml');
    expect(await git.remoteUrl('origin')).toBe('docsync::.docsync.yaml');
  });
});
