/**
 * `docsync auth <source> [--logout]` (MANUAL §2).
 *
 * Signing in is `src/auth/`'s business; this command only decides which of its
 * three calls to make and how to say the result. The grant hint goes through
 * the same output as everything else, so that what to approve is on screen
 * before the browser opens.
 */
import { NotSignedInError } from '../../auth/errors.js';
import type { Identity } from '../../auth/types.js';
import { type SourceName, sourceNames } from '../../source.js';
import { CliError, type Context, say } from '../context.js';

/** The source names `docsync auth` takes, `google` included (MANUAL §2). */
export function parseSourceName(text: string): SourceName {
  const name = text.toLowerCase() === 'google' ? 'gdocs' : text.toLowerCase();
  if (!(sourceNames as string[]).includes(name)) {
    throw new CliError(`${text} is not a source. Expected one of: ${sourceNames.join(', ')}`);
  }
  return name as SourceName;
}

/** "signed in as" — whichever of the three things the source volunteered. */
export function describeIdentity(identity: Identity): string {
  const parts = [identity.name, identity.email, identity.workspace].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.length === 0 ? 'an unnamed account' : parts.join(', ');
}

export interface AuthOptions {
  logout: boolean;
}

export async function auth(
  context: Context,
  argument: string,
  options: AuthOptions,
): Promise<number> {
  const source = parseSourceName(argument);
  const deps = { log: (line: string) => say(context, line) };

  if (options.logout) {
    const had = await context.auth.signOut(source, deps);
    say(context, had ? `Signed out of ${source}.` : `Not signed in to ${source}.`);
    return 0;
  }

  try {
    // An existing token is verified rather than replaced (MANUAL §2).
    say(
      context,
      `Already signed in as ${describeIdentity(await context.auth.whoAmI(source, deps))}.`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof NotSignedInError)) throw error;
  }
  say(context, `Signed in as ${describeIdentity(await context.auth.signIn(source, deps))}.`);
  return 0;
}
