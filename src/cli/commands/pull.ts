/**
 * `docsync pull` (MANUAL §5): `git pull`, then the same report `docsync fetch`
 * prints, since a pull is a fetch with a merge after it.
 */
import type { Context } from '../context.js';
import { runFetching } from './fetch.js';

export async function pull(context: Context): Promise<number> {
  return runFetching(context, ['pull']);
}
