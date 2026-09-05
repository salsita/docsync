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
 */
import { readFetchReport } from '../../helper/report.js';
import { FETCH_ALL_ENV } from '../../helper/run.js';
import { type Context, openRepo, sayBlock } from '../context.js';
import { formatFetchReport } from '../print.js';

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
  const result = await repo.git.run(args, {
    relay: true,
    // This run, and no other: a plain `git fetch` is the fetch it always was.
    ...(options.all === true ? { env: { ...context.env, [FETCH_ALL_ENV]: '1' } } : {}),
  });
  if (result.status !== 0) return result.status;
  sayBlock(context, formatFetchReport(await readFetchReport(repo.gitDir)));
  return 0;
}

export async function fetch(context: Context, options: FetchOptions = {}): Promise<number> {
  return runFetching(context, ['fetch', 'origin'], options);
}
