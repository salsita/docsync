/**
 * `docsync pull` (MANUAL §5): `git pull`, then the same report `docsync fetch`
 * prints, since a pull is a fetch with a merge after it. `--all` reaches the
 * helper exactly as it does for `fetch`.
 */
import type { Context } from '../context.js';
import { type FetchOptions, runFetching } from './fetch.js';

export async function pull(context: Context, options: FetchOptions = {}): Promise<number> {
  return runFetching(context, ['pull'], options);
}
