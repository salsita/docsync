/**
 * The skill file every checkout carries (MANUAL §10).
 *
 * One file ships in the package, `skill/SKILL.md`, and every checkout holds
 * three plain copies of it — one per agent that reads skills from the working
 * tree. Every `docsync` command and every helper run compares the copies with
 * the bundled one and rewrites the ones that differ, so upgrading docsync
 * updates every checkout the next time it is touched.
 *
 * Nothing here is allowed to fail a command. A checkout on a read-only mount,
 * or one whose `.claude/` a user made a symlink to somewhere unwritable, still
 * fetches and pushes; the refresh says so on stderr and gets out of the way.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitRunner } from './cli/git.js';

/**
 * The three copies, relative to the working tree and always with `/`
 * separators: they are also lines in `.git/info/exclude`, which is a git file
 * and knows no backslashes (MANUAL §10, §11).
 */
export const SKILL_PATHS: readonly string[] = [
  '.agents/skills/docsync/SKILL.md',
  '.claude/skills/docsync/SKILL.md',
  '.cursor/skills/docsync/SKILL.md',
];

/**
 * What an operating system drops into any directory it shows: never a
 * document, and under a root a `git add` away from being pushed to a client's
 * folder as an asset. Excluded next to the skill paths (MANUAL §5 step 5, §10).
 */
export const OS_JUNK: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

/**
 * Every line the refresh keeps in `info/exclude`: the skill paths, the OS junk,
 * and `.gitignore` itself, which is a person's local ignore list in a checkout
 * and never a document. Git reads it whether or not it is tracked.
 */
export const REFRESHED_EXCLUDES: readonly string[] = [...SKILL_PATHS, ...OS_JUNK, '.gitignore'];

/**
 * The file the package ships. Resolved relative to this module, so it is found
 * from `dist/skill.js` and from `src/skill.ts` alike: both sit one directory
 * below the package root, next to `skill/`.
 */
export const BUNDLED_SKILL: string = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url));

/** Brings the three skill files under `worktree` up to date (MANUAL §10). */
export async function refreshSkillFiles(worktree: string): Promise<void> {
  try {
    const bundled = await readFile(BUNDLED_SKILL);
    for (const relative of SKILL_PATHS) {
      const path = join(worktree, ...relative.split('/'));
      if (await isCurrent(path, bundled)) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bundled);
    }
    await excludeSkillPaths(worktree);
  } catch (error) {
    // The command goes on: a stale or missing skill file is not a reason to
    // refuse a fetch.
    process.stderr.write(`docsync: could not refresh the skill file: ${reason(error)}\n`);
  }
}

/** Whether the copy at `path` is already byte-for-byte the bundled one. */
async function isCurrent(path: string, bundled: Buffer): Promise<boolean> {
  try {
    return (await readFile(path)).equals(bundled);
  } catch {
    // Not there, or not readable; either way it is about to be written.
    return false;
  }
}

/**
 * Adds the three skill paths and the OS junk names to the repository's
 * `info/exclude`, keeping what is there. `init` writes them for a new checkout; this is how a checkout made by
 * an older version gets them.
 *
 * The path comes from git rather than from `<worktree>/.git`, because a linked
 * worktree's `.git` is a file pointing elsewhere and `info/exclude` lives in
 * the common directory the two share.
 */
async function excludeSkillPaths(worktree: string): Promise<void> {
  const git = createGitRunner({
    cwd: worktree,
    out: () => undefined,
    err: () => undefined,
  });
  const found = await git.run(['rev-parse', '--git-path', 'info/exclude']);
  // Not a repository, or a git too old to answer: there is nothing to exclude
  // from, and that is not a failure worth a line on stderr.
  if (found.status !== 0) return;
  const answer = found.stdout.trim();
  if (answer === '') return;
  const path = isAbsolute(answer) ? answer : resolve(worktree, answer);

  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // A repository git made without an `info/exclude`; the file is ours to write.
  }
  const have = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = REFRESHED_EXCLUDES.filter((one) => !have.has(one));
  if (missing.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const head = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeFile(path, `${head}${missing.join('\n')}\n`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
