#!/usr/bin/env node
/**
 * `git-remote-docsync`: what git runs for a `docsync::` remote (MANUAL §9).
 * Everything is in `src/helper/`; this file only picks the real sources and
 * the keychain-backed credentials, and answers `--version` without reading
 * stdin, which is what the install smoke test needs.
 */
import { createCredentialProvider } from './auth/index.js';
import { main } from './helper/main.js';
import { sources } from './source.js';
import { createStreamWriter } from './stdio.js';
import { version } from './version.js';

if (process.argv.includes('--version')) {
  // Guarded like every other write of ours (`src/stdio.ts`): the reader of a
  // `--version` is often a script that takes the one line and closes the pipe.
  const out = createStreamWriter(process.stdout);
  out.write(`${version}\n`);
  await out.flush();
} else {
  process.exitCode = await main(sources, createCredentialProvider());
}
