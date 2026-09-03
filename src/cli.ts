#!/usr/bin/env node
/**
 * `docsync`: the front end (MANUAL §5, §13). Everything is in `src/cli/`; this
 * file only builds the context of a real run — the real sources, the
 * keychain-backed credentials, the process streams — and answers an exit code.
 */
import { createContext } from './cli/context.js';
import { runCli } from './cli/program.js';

process.exitCode = await runCli(
  process.argv.slice(2),
  createContext({
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  }),
);
