/**
 * The process around `runHelper`: stdin as lines, stdout and stderr as
 * writers, argv and the environment as they are. The real binary
 * (`src/remote-helper.ts`) and the test one (`fake-helper.mock.ts`) differ
 * only in the sources and the credential provider they hand over.
 */
import { createInterface } from 'node:readline';
import type { CredentialProvider } from '../auth/index.js';
import type { SourceRegistry } from '../source.js';
import { createStreamWriter } from '../stdio.js';
import { runHelper } from './run.js';

export interface ProcessLike {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd(): string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** A line writer that survives the reader going away, and can be waited on. */
export interface LineWriter {
  write(line: string): void;
  /** Whether the far end has closed: every write since is a no-op. */
  broken(): boolean;
  /** Resolves once every write handed over so far has been answered. */
  flush(): Promise<void>;
}

/**
 * One of the process's streams as a writer of lines that treats a closed pipe
 * as the end of the conversation rather than as a failure.
 *
 * Git closes the read end as soon as it has what it wants — after the last
 * reply of a batch, on a push it has decided to reject, or simply by exiting
 * first — and anything the helper still had to say then raises EPIPE. Without
 * an 'error' listener that is an unhandled event and the helper dies, which
 * git reports as exit 128 (ticket 22). There is nobody left to tell, so the
 * writer goes quiet instead and lets the run end on its own terms.
 *
 * The guard itself is `src/stdio.ts`, which the front end uses as well; the
 * protocol's unit is a line, so this is that writer plus the newline.
 */
export function createLineWriter(stream: NodeJS.WritableStream): LineWriter {
  const writer = createStreamWriter(stream);
  return {
    write: (line) => writer.write(`${line}\n`),
    broken: () => writer.broken(),
    flush: () => writer.flush(),
  };
}

/** Runs the helper over a process and answers its exit code. */
export async function main(
  sources: SourceRegistry,
  provider: CredentialProvider,
  proc: ProcessLike = process,
): Promise<number> {
  const lines = createInterface({ input: proc.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const out = createLineWriter(proc.stdout);
  const err = createLineWriter(proc.stderr);
  try {
    const code = await runHelper({
      argv: proc.argv.slice(2),
      env: proc.env,
      cwd: proc.cwd(),
      sources,
      provider,
      input: lines,
      write: (line) => out.write(line),
      stderr: (line) => err.write(line),
    });
    // Every reply is git's to read before the process goes: an exit with a
    // write still queued is a truncated protocol.
    await out.flush();
    await err.flush();
    return code;
  } finally {
    // A run that ended early — a fetch that failed — leaves stdin open, and an
    // open stdin keeps the process alive while git waits for it to exit.
    lines.close();
  }
}
