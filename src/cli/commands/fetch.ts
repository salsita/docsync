/**
 * `docsync fetch` (MANUAL §5).
 *
 * A thin wrapper over `git fetch` with docsync's own output: git relays the
 * helper's progress, and afterwards the report file says which documents
 * changed and who changed them. `docsync pull` is the same wrapper over
 * `git pull`, which is why the two share this function.
 */
import { readFetchReport } from '../../helper/report.js';
import { type Context, openRepo, say } from '../context.js';
import { formatFetchReport } from '../print.js';

/** Runs one git command that fetches, then prints what the fetch found. */
export async function runFetching(context: Context, args: readonly string[]): Promise<number> {
  const repo = await openRepo(context);
  const result = await repo.git.run(args, { relay: true });
  if (result.status !== 0) return result.status;
  say(context, formatFetchReport(await readFetchReport(repo.gitDir)));
  return 0;
}

export async function fetch(context: Context): Promise<number> {
  return runFetching(context, ['fetch', 'origin']);
}
