/**
 * Run the real sign-in flow for one source, before the `docsync auth` command
 * exists (that is ticket 10).
 *
 *   corepack pnpm build
 *   node scripts/auth-smoke.ts notion
 *   node scripts/auth-smoke.ts gdocs
 *
 * It reads `~/.docsync/oauth-apps.yaml` (writing the template and opening
 * $EDITOR if the entry is not filled in yet), opens a browser, and stores the
 * token in the OS keychain. Then it reads the token back through `whoAmI` and
 * prints who you are.
 *
 * `--logout` removes the stored token instead.
 */
import { signIn, signOut, whoAmI } from '../dist/auth/index.js';

const ALIASES = { google: 'gdocs', notion: 'notion', gdocs: 'gdocs' };

function usage(message: string): never {
  console.error(`${message}\n\nUsage: node scripts/auth-smoke.ts <notion|gdocs> [--logout]`);
  process.exit(2);
}

const [rawSource, ...flags] = process.argv.slice(2);
const source = ALIASES[rawSource as keyof typeof ALIASES];
if (!source) usage(rawSource ? `Unknown source "${rawSource}".` : 'Which source?');

function describe(identity: { name?: string; email?: string; workspace?: string }): string {
  const who = [identity.name, identity.email].filter(Boolean).join(' ');
  return identity.workspace ? `${who || 'you'} in ${identity.workspace}` : who || '(no identity)';
}

try {
  if (flags.includes('--logout')) {
    console.log(
      (await signOut(source)) ? `Signed out of ${source}.` : `Was not signed in to ${source}.`,
    );
  } else {
    await signIn(source);
    console.log(`\nSigned in as ${describe(await whoAmI(source))}.`);
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
