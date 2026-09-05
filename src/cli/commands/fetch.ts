/**
 * `docsync fetch` (MANUAL §5).
 *
 * A thin wrapper over `git fetch` with docsync's own output: git relays the
 * helper's progress, and afterwards the report file says which documents
 * changed and who changed them. `docsync pull` is the same wrapper over
 * `git pull`, which is why the two share this function.
 *
 * `--all` is the one thing the wrapper adds to git's own run: git's protocol
 * has no option that could carry it, so the flag travels as a variable in the
 * environment of that one git command, which git hands to the helper (§7).
 *
 * On a branch other than `main` the merge half of a pull is not ours to do
 * (MANUAL §5, §10): git has no tracking information there, and merging into
 * someone's work branch is their decision. What docsync owes them is the
 * fetch, and a `main` that still means what the manual says it means — the
 * source's state. So the fetch runs, `main` fast-forwards to it, and the
 * command ends by saying where `main` now is and how to bring it in.
 */
import { readFetchReport } from '../../helper/report.js';
import { FETCH_ALL_ENV } from '../../helper/run.js';
import { type Context, openRepo, type Repo, say, sayBlock } from '../context.js';
import { formatFetchReport } from '../print.js';

/** The branch docsync keeps equal to the source's state (MANUAL §1, §5). */
const MAIN = 'main';

/** What `fetch` and `pull` take: `--all`, and nothing else (MANUAL §5). */
export interface FetchOptions {
  /** Download and convert every document again, whatever its edit time says. */
  all?: boolean;
}

/** Runs one git command that fetches, then prints what the fetch found. */
export async function runFetching(
  context: Context,
  args: readonly string[],
  options: FetchOptions = {},
): Promise<number> {
  const repo = await openRepo(context);
  const branch = await repo.git.branch();
  // Nothing is merged into a branch that is not `main`, so a pull there is
  // the fetch `docsync fetch` runs, and the same report after it.
  const elsewhere = branch !== MAIN;
  const result = await repo.git.run(elsewhere ? ['fetch', 'origin'] : args, {
    relay: true,
    // This run, and no other: a plain `git fetch` is the fetch it always was.
    ...(options.all === true ? { env: { ...context.env, [FETCH_ALL_ENV]: '1' } } : {}),
  });
  if (result.status !== 0) return result.status;
  sayBlock(context, formatFetchReport(await readFetchReport(repo.gitDir)));
  if (elsewhere) await fastForwardMain(context, repo, branch);
  return 0;
}

/**
 * The local `main`, moved up to what the fetch just brought in, and the one
 * line that says so.
 *
 * The move is a fetch from the checkout itself: no network and no helper — the
 * expensive part has already run — with git's own fast-forward check, which is
 * what refuses to rewrite a `main` that carries commits of its own. A refusal
 * is not a failure of the command: what was fetched stands, and `main` is left
 * where its owner put it.
 */
async function fastForwardMain(
  context: Context,
  repo: Repo,
  branch: string | undefined,
): Promise<void> {
  const moved = await repo.git.run([
    'fetch',
    '.',
    `refs/remotes/origin/${MAIN}:refs/heads/${MAIN}`,
  ]);
  if (moved.status !== 0) {
    say(context, `main was left where it is: it is not a fast-forward of origin/${MAIN}.`);
  }
  const at = await repo.git.run(['rev-parse', '--short', MAIN]);
  if (at.status !== 0) return;
  // A detached HEAD has no name to rebase into, and the command to run is the
  // same one either way.
  const here = branch ?? 'HEAD';
  say(
    context,
    `main is now at ${at.stdout.trim()}; rebase or merge it into ${here} ` +
      `when you are ready: git rebase ${MAIN}`,
  );
}

export async function fetch(context: Context, options: FetchOptions = {}): Promise<number> {
  return runFetching(context, ['fetch', 'origin'], options);
}
