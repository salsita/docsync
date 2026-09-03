/**
 * `docsync status` (MANUAL §5).
 *
 * `git status` first, because that is what the user is really asking, then one
 * line per root: what it is, where it is, when it was last fetched, and how
 * much of it has moved at the source since. The last part is `changedSince`,
 * which reads metadata and downloads nothing.
 */
import { parseIndex } from '../../helper/index-file.js';
import type { DocumentIndex } from '../../index-file.js';
import { type Context, openRepo, type Repo, say, warn } from '../context.js';
import { formatStatusLine } from '../print.js';

/** The remote-tracking branch a docsync remote serves. */
const SERVED = 'refs/remotes/origin/main';

/** The index of the last fetch, as the served commit holds it (never the tree). */
async function servedIndex(repo: Repo): Promise<DocumentIndex> {
  const shown = await repo.git.run(['show', `${SERVED}:.docsync/index.yaml`]);
  return shown.status === 0 ? parseIndex(shown.stdout) : new Map();
}

export async function status(context: Context): Promise<number> {
  const repo = await openRepo(context);
  const shown = await repo.git.run(['status', '--short', '--branch'], { relay: true });
  if (shown.status !== 0) return shown.status;

  if (repo.manifest.roots.length === 0) {
    say(context);
    say(context, 'No roots. Add one with: docsync add <src>');
    return 0;
  }

  // The committer date of the served commit is when docsync last synthesized a
  // fetch, which is exactly "last fetched".
  const fetchedAt = await repo.git.run(['log', '-1', '--format=%cI', SERVED]);
  const previous = await servedIndex(repo);

  say(context);
  let failure: string | undefined;
  for (const root of repo.manifest.roots) {
    let changed: number | undefined;
    try {
      changed = (
        await context.sources[root.src.source].changedSince(root, context.provider, previous)
      ).length;
    } catch (error) {
      // One unreachable source must not hide the other roots' lines.
      failure ??= error instanceof Error ? error.message : String(error);
    }
    say(
      context,
      formatStatusLine(root, fetchedAt.status === 0 ? fetchedAt.stdout.trim() : undefined, changed),
    );
  }
  if (failure !== undefined) warn(context, failure);
  return 0;
}
