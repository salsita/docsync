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
import { type Context, openRepo, say, sayBlock } from '../context.js';
import { formatPushReport } from '../print.js';
import { fastForward } from './add.js';

export async function push(context: Context): Promise<number> {
  const repo = await openRepo(context);
  const pushed = await repo.git.run(['push'], { relay: true });
  if (pushed.status !== 0) return pushed.status;

  sayBlock(context, formatPushReport(await readPushReport(repo.gitDir)));

  // A pull, not a merge: git's `origin/main` still points at what was pushed,
  // and the follow-up commit of §7 only arrives with another fetch. An edit in
  // progress blocks it only when git says it would be overwritten, and
  // `--no-rebase` is what keeps it that way: the checkout's `pull.rebase=true`
  // (§10) sends even a fast-forward down the rebase path otherwise, and a
  // rebase refuses any unstaged change out of hand.
  say(context);
  await fastForward(context, repo, ['pull', '--ff-only', '--no-rebase']);
  return 0;
}
