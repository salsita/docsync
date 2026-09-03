/**
 * `docsync push` (MANUAL §5, §7, §8).
 *
 * `git push`, then the report: what happened to each document, with the
 * trashed ones last, because a push is the only thing in docsync that removes
 * something at the source. Then the fast-forward the manual's quick start
 * spells as a `git pull` after every push — a push always leaves one follow-up
 * commit at the remote (§7) — which is only safe when the working tree is
 * clean.
 */
import { readPushReport } from '../../helper/report.js';
import { type Context, openRepo, say } from '../context.js';
import { formatPushReport } from '../print.js';

export async function push(context: Context): Promise<number> {
  const repo = await openRepo(context);
  const pushed = await repo.git.run(['push'], { relay: true });
  if (pushed.status !== 0) return pushed.status;

  say(context, formatPushReport(await readPushReport(repo.gitDir)));

  if (!(await repo.git.isClean())) {
    say(context);
    say(
      context,
      'Your working tree has changes, so the follow-up commit was not merged. ' +
        'Commit or stash them, then run: docsync pull',
    );
    return 0;
  }
  // A pull, not a merge: git's `origin/main` still points at what was pushed,
  // and the follow-up commit of §7 only arrives with another fetch.
  const merged = await repo.git.run(['pull', '--ff-only'], { relay: true });
  return merged.status;
}
