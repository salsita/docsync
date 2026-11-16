/**
 * Vitest's global setup: build the fake helper once, before any test file.
 *
 * `e2e.test.ts` and `cli/commands.test.ts` both need `git-remote-docsync` on a
 * PATH, and both used to compile it themselves. Building it here instead means
 * one `tsc` per run rather than one per file, and no test file paying for the
 * compile inside its own timeout (#22).
 *
 * The real-git suites use shell shims off Windows. The focused Windows test
 * invokes the compiled fake helper through the native launcher (#12).
 */
import { buildFakeHelper } from './fake-bin.mock.js';

export function setup(): void {
  buildFakeHelper();
}
