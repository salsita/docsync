/**
 * `docsync status` (MANUAL §5).
 *
 * `git status` first, because that is what the user is really asking, then one
 * line per root: what it is, where it is, when it was last fetched, and how
 * much of it has moved at the source since. The last part is `changedSince`,
 * which reads metadata and downloads nothing.
 *
 * Then `To push:`, the preview of ticket 31: the committed diff `docsync push`
 * would send, run through the very code the push uses to sort it, so that a
 * person can see what a push would do to real documents — refusals included —
 * before running one. It costs no network at all.
 */
import { type PushPlan, planChanges } from '../../helper/changes.js';
import { createGit } from '../../helper/git.js';
import { parseIndex } from '../../helper/index-file.js';
import type { DocumentIndex } from '../../index-file.js';
import { type Context, openRepo, type Repo, say, sayBlock, warn } from '../context.js';
import { formatPushPreview, formatStatusLine } from '../print.js';

/** The remote-tracking branch a docsync remote serves. */
const SERVED = 'refs/remotes/origin/main';

/** The index of the last fetch, as the served commit holds it (never the tree). */
async function servedIndex(repo: Repo): Promise<DocumentIndex> {
  const shown = await repo.git.run(['show', `${SERVED}:.docsync/index.yaml`]);
  return shown.status === 0 ? parseIndex(shown.stdout) : new Map();
}

/**
 * What `docsync push` would send: the committed changes between the served
 * commit and `HEAD`, sorted the way the push sorts them (MANUAL §7 steps 2 to
 * 4). `undefined` when the branch is the served commit, which is when there is
 * nothing to preview. Blobs come from the object store, never from the working
 * tree: uncommitted edits are not pushed and must not appear here.
 */
async function previewPush(
  repo: Repo,
  index: DocumentIndex,
  head: string,
  served: string,
): Promise<PushPlan | undefined> {
  if (head === served) return undefined;
  // `origin/main...HEAD`, as the manual writes the diff a person would run by
  // hand. The merge base is the served commit itself on the fast-forward the
  // push requires, and the right answer on a branch that has diverged.
  const merged = await repo.git.run(['merge-base', served, head]);
  const from = merged.status === 0 ? merged.stdout.trim() : served;
  const git = createGit(repo.gitDir);
  return planChanges(
    await git.diffTree(from, head),
    repo.manifest.roots,
    index,
    (path) => git.catBlob(`${head}:${path}`),
    async (path) => {
      try {
        return await git.catBlob(`${from}:${path}`);
      } catch {
        // The served tree does not hold it: an addition, and no base to diff.
        return undefined;
      }
    },
  );
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

  const head = await repo.git.run(['rev-parse', '--verify', 'HEAD']);
  const served = await repo.git.run(['rev-parse', '--verify', SERVED]);
  if (head.status === 0 && served.status === 0) {
    try {
      const plan = await previewPush(repo, previous, head.stdout.trim(), served.stdout.trim());
      if (plan !== undefined) {
        const dirty = await repo.git.run(['status', '--porcelain']);
        const uncommitted = dirty.stdout.split('\n').filter((line) => line !== '').length;
        const preview = formatPushPreview(plan, uncommitted);
        if (preview !== '') {
          say(context);
          sayBlock(context, preview);
        }
      }
    } catch (error) {
      // A preview is a courtesy; it must not take the status with it.
      warn(context, error instanceof Error ? error.message : String(error));
    }
  }
  return 0;
}
