/**
 * Vitest's global setup: build the fake helper once, before any test file.
 *
 * `e2e.test.ts` and `cli/commands.test.ts` both need `git-remote-docsync` on a
 * PATH, and both used to compile it themselves. Building it here instead means
 * one `tsc` per run rather than one per file, and no test file paying for the
 * compile inside its own timeout (ticket 22).
 *
 * The two files that use it are skipped on Windows until ticket 12, so the
 * build is skipped there too rather than producing a shim nothing can run.
 */
import { buildFakeHelper } from './fake-bin.mock.js';

export function setup(): void {
  if (process.platform === 'win32') return;
  buildFakeHelper();
}
