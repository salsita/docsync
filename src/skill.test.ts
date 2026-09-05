/**
 * The refresh of MANUAL §10: three copies of one bundled file, kept identical
 * to it, excluded from git, and never able to break the command that ran it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_SKILL, REFRESHED_EXCLUDES, refreshSkillFiles, SKILL_PATHS } from './skill.js';

const bundled = readFileSync(BUNDLED_SKILL);
const [FIRST_SKILL] = SKILL_PATHS;

const made: string[] = [];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

/** A git repository to refresh in, with git's own defaults out of the way. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docsync-skill-'));
  made.push(dir);
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir, env: gitEnv() });
  return dir;
}

function excludeOf(gitDir: string): string {
  try {
    return readFileSync(join(gitDir, '.git', 'info', 'exclude'), 'utf8');
  } catch {
    return '';
  }
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

describe.skipIf(process.platform === 'win32')('refreshSkillFiles', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('writes all three copies into a fresh checkout', async () => {
    const dir = repo();
    await refreshSkillFiles(dir);

    for (const relative of SKILL_PATHS) {
      expect(readFileSync(join(dir, relative))).toEqual(bundled);
    }
    // The bundled file is the one the package ships, resolved from this module
    // so that `dist/` and `src/` find the same copy.
    expect(BUNDLED_SKILL).toBe(fileURLToPath(new URL('../skill/SKILL.md', import.meta.url)));
  });

  it('rewrites a copy that differs and leaves an identical one alone', async () => {
    const dir = repo();
    await refreshSkillFiles(dir);

    const [stale, ...same] = SKILL_PATHS.map((relative) => join(dir, relative));
    if (stale === undefined) throw new Error('no skill paths');
    write(stale, 'an older version, or somebody edited it\n');
    // Old enough that a rewrite cannot land on the same mtime by accident.
    const old = new Date('2020-01-01T00:00:00Z');
    for (const path of same) utimesSync(path, old, old);
    const before = same.map((path) => statSync(path).mtimeMs);

    await refreshSkillFiles(dir);

    expect(readFileSync(stale)).toEqual(bundled);
    expect(same.map((path) => statSync(path).mtimeMs)).toEqual(before);
  });

  it('appends the three paths and the OS junk names to .git/info/exclude, once', async () => {
    const dir = repo();
    write(join(dir, '.git', 'info', 'exclude'), '# git own comment\nbuild/\n');

    await refreshSkillFiles(dir);
    await refreshSkillFiles(dir);

    const text = excludeOf(dir);
    expect(text).toContain('build/');
    for (const relative of REFRESHED_EXCLUDES) {
      expect(text.split('\n').filter((line) => line === relative)).toHaveLength(1);
    }
    expect(text).toContain('.DS_Store');
  });

  it('leaves an exclude file that already lists the paths untouched', async () => {
    const dir = repo();
    const already = `${REFRESHED_EXCLUDES.join('\n')}\n`;
    write(join(dir, '.git', 'info', 'exclude'), already);

    await refreshSkillFiles(dir);

    expect(excludeOf(dir)).toBe(already);
  });

  it('excludes through the repository git names, not through <worktree>/.git', async () => {
    const dir = repo();
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'root'], {
      cwd: dir,
      env: gitEnv(),
    });
    const linked = join(dirname(dir), `${basename(dir)}-linked`);
    made.push(linked);
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'side', linked], {
      cwd: dir,
      env: gitEnv(),
    });

    await refreshSkillFiles(linked);

    // A linked worktree's `.git` is a file, and `info/exclude` lives in the
    // repository it points at.
    expect(statSync(join(linked, '.git')).isFile()).toBe(true);
    expect(excludeOf(dir)).toContain(FIRST_SKILL);
    expect(readFileSync(join(linked, FIRST_SKILL ?? ''))).toEqual(bundled);
  });

  it('reports a failure on stderr and never fails the command', async () => {
    const dir = repo();
    // A file where the worktree should be: every mkdir under it is ENOTDIR.
    write(join(dir, 'not-a-directory'), 'x');
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(refreshSkillFiles(join(dir, 'not-a-directory'))).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).toContain('skill file');
  });
});
