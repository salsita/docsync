/**
 * `docsync remove <path>...` (MANUAL §5, §8).
 *
 * Drops the roots from the manifest, deletes the files, commits the deletion
 * locally. Nothing at the source: the next push carries the deletion commit,
 * and the helper reads it as an unsubscribe precisely because the root is no
 * longer in the manifest.
 */
import { writeFile } from 'node:fs/promises';
import { serializeManifest } from '../../manifest/index.js';
import type { Root } from '../../manifest/types.js';
import { CliError, type Context, openRepo, say } from '../context.js';

/** The root a `<path>` argument names, spelled with or without its slash. */
function rootFor(roots: readonly Root[], path: string): Root {
  const wanted = path.normalize('NFC');
  const found =
    roots.find((root) => root.path === wanted) ??
    roots.find((root) => root.path === `${wanted}/` || `${root.path}/` === wanted);
  if (found === undefined) throw new CliError(`no root at ${path}`);
  return found;
}

export async function remove(context: Context, args: readonly string[]): Promise<number> {
  const repo = await openRepo(context);
  const going = args.map((path) => rootFor(repo.manifest.roots, path));

  const roots = repo.manifest.roots.filter((root) => !going.includes(root));
  await writeFile(repo.manifestPath, serializeManifest({ ...repo.manifest, roots }));

  // A directory root is one pathspec; a file root is its file and the sibling
  // directory its children would have landed in (MANUAL §4).
  const paths = going.flatMap((root) =>
    root.path.endsWith('/')
      ? [root.path.slice(0, -1)]
      : [root.path, root.path.replace(/\.[^./]+$/, '')],
  );
  const removed = await repo.git.run(['rm', '-r', '-q', '--ignore-unmatch', '--', ...paths]);
  if (removed.status !== 0) throw new CliError(removed.stderr.trim() || 'git rm failed');

  const message = `Remove ${going.map((root) => root.path).join(', ')}`;
  if ((await repo.git.run(['diff', '--cached', '--quiet'])).status === 0) {
    // The manifest is untracked, so a root whose files were never fetched
    // leaves nothing to commit. Saying so beats an empty commit.
    say(context, `${message} — nothing was checked out, so there is nothing to commit.`);
    return 0;
  }
  await repo.git.must(['commit', '--quiet', '-m', message]);
  say(context, message);
  return 0;
}
