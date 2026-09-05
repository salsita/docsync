#!/usr/bin/env node
/**
 * `docsync`: the front end (MANUAL §5, §13). Everything is in `src/cli/`; this
 * file only builds the context of a real run — the real sources, the
 * keychain-backed credentials, the process streams — and answers an exit code.
 *
 * The streams are guarded (`src/stdio.ts`): `docsync status | head` closes
 * stdout as soon as head has its lines, and a report the user truncated on
 * purpose must not become a stack trace or a different exit code. The flush at
 * the end is the other half: an exit with a write still in flight loses it.
 */
import { createContext } from './cli/context.js';
import { runCli } from './cli/program.js';
import { createStreamWriter } from './stdio.js';

const out = createStreamWriter(process.stdout);
const err = createStreamWriter(process.stderr);

process.exitCode = await runCli(
  process.argv.slice(2),
  createContext({
    cwd: process.cwd(),
    out: (text) => out.write(text),
    err: (text) => err.write(text),
  }),
);

await out.flush();
await err.flush();
