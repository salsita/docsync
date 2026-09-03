/**
 * The process around `runHelper`: stdin as lines, stdout and stderr as
 * writers, argv and the environment as they are. The real binary
 * (`src/remote-helper.ts`) and the test one (`fake-helper.mock.ts`) differ
 * only in the sources and the credential provider they hand over.
 */
import { createInterface } from 'node:readline';
import type { CredentialProvider } from '../auth/index.js';
import type { SourceRegistry } from '../source.js';
import { runHelper } from './run.js';

export interface ProcessLike {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd(): string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Runs the helper over a process and answers its exit code. */
export async function main(
  sources: SourceRegistry,
  provider: CredentialProvider,
  proc: ProcessLike = process,
): Promise<number> {
  const lines = createInterface({ input: proc.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    return await runHelper({
      argv: proc.argv.slice(2),
      env: proc.env,
      cwd: proc.cwd(),
      sources,
      provider,
      input: lines,
      write: (line) => proc.stdout.write(`${line}\n`),
      stderr: (line) => proc.stderr.write(`${line}\n`),
    });
  } finally {
    // A run that ended early — a fetch that failed — leaves stdin open, and an
    // open stdin keeps the process alive while git waits for it to exit.
    lines.close();
  }
}
