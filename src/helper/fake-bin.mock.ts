/**
 * The fake `git-remote-docsync` on a PATH, for every test that runs real git.
 *
 * git discovers a remote helper by name, so a test that wants `git clone
 * docsync::…` — or a `docsync` command that shells out to git — needs the
 * helper as an executable file. This builds `fake-helper.mock.ts` (the real
 * helper over the fake `Source`) with `tsc` and puts a shim in a directory a
 * test prepends to PATH.
 *
 * The build happens once for the whole run, in `global-setup.mock.ts`, before
 * any test file starts. It used to happen once per test file, into a cache
 * directory per caller, because two builds into one directory would race —
 * which meant `tsc` ran twice and the two real-git files were the slowest
 * things in CI, slow enough to time out under load (ticket 22). A single build
 * ahead of the workers costs one compile and needs no cache name: `HELPER_BIN`
 * is where it lands, and every caller reads it from there.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUILD = join(PACKAGE_ROOT, 'node_modules', '.cache', 'docsync-helper');

/** The directory holding the `git-remote-docsync` shim, to put on PATH. */
export const HELPER_BIN = join(BUILD, 'bin');

/** Compiles the fake helper and writes the shim. Called once per run. */
export function buildFakeHelper(): string {
  rmSync(BUILD, { recursive: true, force: true });
  execFileSync(
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.e2e.json', '--outDir', BUILD],
    { cwd: PACKAGE_ROOT, stdio: 'inherit' },
  );
  writeFileSync(join(BUILD, 'package.json'), '{ "type": "module" }\n');
  mkdirSync(HELPER_BIN, { recursive: true });
  // Windows needs a .cmd shim and is ticket 12; here the shim is a shell script.
  const shim = join(HELPER_BIN, 'git-remote-docsync');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${join(BUILD, 'helper', 'fake-helper.mock.js')}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return HELPER_BIN;
}
