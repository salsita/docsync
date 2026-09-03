/**
 * The git remote-helper protocol, as the helper speaks it (gitremote-helpers(7)).
 *
 * Git writes commands on the helper's stdin and reads replies on stdout. The
 * shape is small: `capabilities`, `option`, `list [for-push]` are one line in
 * and a few lines out; `fetch` and `push` arrive as a batch of lines ended by
 * a blank line and are answered once per batch. This module is only that
 * shape. What the commands do is `Commands`, which the helper wires and the
 * tests fake, so that the protocol can be tested with strings.
 */

/** One `fetch` line: the object git wants, and the ref it asked for. */
export interface FetchRequest {
  sha: string;
  name: string;
}

/** What the helper does for each command. */
export interface Commands {
  capabilities(): string[];
  /** `ok`, `unsupported`, or `error <message>`. */
  option(name: string, value: string): Promise<string>;
  /** The lines to print: `<sha> <ref>` and `@<ref> HEAD`, no trailing blank. */
  list(forPush: boolean): Promise<string[]>;
  fetch(refs: FetchRequest[]): Promise<void>;
  /** One `ok <dst>` or `error <dst> <message>` per refspec, in order. */
  push(refspecs: string[]): Promise<string[]>;
}

/**
 * Reads commands until EOF and writes replies. Throws on a command it does not
 * know and lets a command's own error through: git's protocol has no channel
 * for either, so the helper's exit is the message.
 */
export async function runProtocol(
  input: AsyncIterable<string>,
  write: (line: string) => void,
  commands: Commands,
): Promise<void> {
  let fetching: FetchRequest[] = [];
  let pushing: string[] = [];

  const flush = async (): Promise<void> => {
    if (fetching.length > 0) {
      const batch = fetching;
      fetching = [];
      await commands.fetch(batch);
      write('');
    }
    if (pushing.length > 0) {
      const batch = pushing;
      pushing = [];
      for (const line of await commands.push(batch)) write(line);
      write('');
    }
  };

  for await (const raw of input) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      await flush();
      continue;
    }
    const [command = '', ...rest] = line.split(' ');
    switch (command) {
      case 'capabilities':
        for (const capability of commands.capabilities()) write(capability);
        write('');
        break;
      case 'option':
        write(await commands.option(rest[0] ?? '', rest.slice(1).join(' ')));
        break;
      case 'list':
        for (const entry of await commands.list(rest[0] === 'for-push')) write(entry);
        write('');
        break;
      case 'fetch':
        fetching.push({ sha: rest[0] ?? '', name: rest.slice(1).join(' ') });
        break;
      case 'push':
        pushing.push(rest.join(' '));
        break;
      default:
        throw new Error(`unknown command from git: ${line}`);
    }
  }
  // Git ends every batch with a blank line, but a helper that is careful about
  // it costs nothing.
  await flush();
}
