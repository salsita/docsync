/**
 * `docsync resolve <src>` (MANUAL §5): what a source ref is, printed as a
 * short table. Useful before `add`, and the one command that talks to a source
 * without a checkout anywhere in sight.
 */
import { isSourceRefError, parseSourceRefOrUrl } from '../../source-ref.js';
import { CliError, type Context, say } from '../context.js';
import { formatResolved } from '../print.js';

export async function resolve(context: Context, argument: string): Promise<number> {
  const ref = parseSourceRefOrUrl(argument);
  if (isSourceRefError(ref)) throw new CliError(`${argument}: ${ref.message}`);

  const described = await context.sources[ref.source].describe(ref, context.provider);
  say(context, formatResolved(described));
  return 0;
}
