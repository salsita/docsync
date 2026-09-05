/**
 * The command line itself: what `docsync` accepts, and what each word runs
 * (MANUAL §5, §13).
 *
 * Commander does the parsing, so that unknown commands and unknown options are
 * errors and per-command `--help` is generated rather than maintained by hand.
 * The one thing that is not generated is the top-level help: it is the command
 * reference of MANUAL §13, verbatim, because that block is the specification
 * of what this program accepts and a generated approximation of it would drift.
 *
 * Every command is a function over a `Context` and lives in its own file under
 * `commands/`. Nothing here does work; it decides which function to call and
 * what to exit with.
 */
import { Command, CommanderError } from 'commander';
import { version } from '../version.js';
import { add } from './commands/add.js';
import { auth } from './commands/auth.js';
import { fetch } from './commands/fetch.js';
import { init } from './commands/init.js';
import { pull } from './commands/pull.js';
import { push } from './commands/push.js';
import { remove } from './commands/remove.js';
import { resolve } from './commands/resolve.js';
import { status } from './commands/status.js';
import type { Context } from './context.js';
import { COMMAND_REFERENCE } from './print.js';

/** An error as the one line the terminal gets (ticket 09's voice). */
export function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s*\n\s*/g, ' ').trim();
}

/**
 * The program, with every command registered. `exit` is handed the code a
 * command answered, since Commander's actions cannot return one.
 */
export function buildProgram(context: Context, exit: (code: number) => void): Command {
  const program = new Command();
  program
    .name('docsync')
    .description('A git workflow over documents that live in Notion and Google Drive')
    .version(version, '--version', 'Print the installed version.');

  // Set before any subcommand exists: Commander copies both into every command
  // it creates, and a subcommand writing to the real process streams, or
  // calling `process.exit`, would be untestable.
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => context.out(text),
    writeErr: (text) => context.err(text),
    outputError: (text, write) => write(text),
  });

  const run = async (work: () => Promise<number>): Promise<void> => {
    exit(await work());
  };

  program
    .command('init')
    .description('Create a checkout.')
    .argument('[args...]', '[<dir>] [<src>[=<path>]...]')
    .action((args: string[]) => run(() => init(context, args)));

  program
    .command('add')
    .description(
      'Resolve each source ref, append roots to the manifest, then fetch and ' +
        'fast-forward if the working tree is clean.',
    )
    .argument('<specs...>', '<src>[=<path>]...')
    .option('--no-fetch', 'Stop once the manifest is written.')
    .option(
      '--readonly',
      'Mark the roots read-only: a push that changes a file under one is refused.',
    )
    .action((specs: string[], options: { fetch: boolean; readonly?: boolean }) =>
      run(() => add(context, specs, { fetch: options.fetch, readOnly: options.readonly === true })),
    );

  program
    .command('remove')
    .description(
      'Remove the roots whose path matches, delete the local files, commit the ' +
        'deletion locally. The source is not touched.',
    )
    .argument('<paths...>')
    .action((paths: string[]) => run(() => remove(context, paths)));

  program
    .command('status')
    .description(
      'Like git status, plus one line per root: source, path, last fetched time, ' +
        'and whether the source has moved since.',
    )
    .action(() => run(() => status(context)));

  // One flag on both commands: every document under every root is downloaded
  // and converted again, and the fetch commit holds whatever came out
  // differently (MANUAL §5, §7).
  const ALL = 'Fetch every document again, whatever its last-edit time says.';

  program
    .command('fetch')
    .description('Print which documents changed at the source and who changed them.')
    .option('--all', ALL)
    .action((options: { all?: boolean }) => run(() => fetch(context, { all: options.all })));

  program
    .command('pull')
    .description('Print which documents changed at the source and who changed them.')
    .option('--all', ALL)
    .action((options: { all?: boolean }) => run(() => pull(context, { all: options.all })));

  program
    .command('push')
    .description(
      'Print, per document, what it did (created, updated, trashed), then run the ' +
        'post-push fetch and fast-forward the current branch when the working tree is clean.',
    )
    .action(() => run(() => push(context)));

  program
    .command('resolve')
    .description(
      'Print what a source ref is: type, title, child count, last editor, last edit time.',
    )
    .argument('<src>')
    .action((src: string) => run(() => resolve(context, src)));

  program
    .command('auth')
    .description('Sign in to a source, or verify the stored token and print who you are.')
    .argument('<source>', 'notion or gdocs')
    .option('--logout', 'Remove the stored token.')
    .action((source: string, options: { logout?: boolean }) =>
      run(() => auth(context, source, { logout: options.logout === true })),
    );

  // After the subcommands, so that only the program's own help is replaced:
  // Commander copies the help configuration at the moment a command is made,
  // and `docsync add --help` should still be the generated help.
  program.configureHelp({ formatHelp: () => `${COMMAND_REFERENCE}\n` });
  return program;
}

/** Parses `argv` (without node and the script) and answers the exit code. */
export async function runCli(argv: readonly string[], context: Context): Promise<number> {
  let code = 0;
  const program = buildProgram(context, (status) => {
    code = status;
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return code;
  } catch (error) {
    // `--help`, `--version` and a syntax error are all exits Commander has
    // already written through `configureOutput`; it only carries the code.
    if (error instanceof CommanderError) return error.exitCode;
    context.err(`docsync: ${oneLine(error)}\n`);
    return 1;
  }
}
