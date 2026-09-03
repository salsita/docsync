/**
 * A throwaway git repository, for the tests of everything that spawns git.
 *
 * Shared by the plumbing, tree, fetch and push tests: each of them wants a
 * real `GIT_DIR` and nothing else, and none of them wants to know how one is
 * made. The directory is removed when the test file is done with it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit, type Git } from './git.js';

export interface TempRepo {
  /** The working tree. */
  root: string;
  /** `<root>/.git`, which is what the helper is handed as `GIT_DIR`. */
  gitDir: string;
  git: Git;
  /** Runs git in the working tree, for the porcelain a test needs to set up. */
  run(...args: string[]): string;
  remove(): void;
}

/** Makes a repository with one initial branch, `main`, and no commits. */
export function createTempRepo(prefix = 'docsync-git-'): TempRepo {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const run = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trimEnd();

  run('init', '--quiet', '--initial-branch=main');
  const gitDir = join(root, '.git');
  return {
    root,
    gitDir,
    git: createGit(gitDir),
    run,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
