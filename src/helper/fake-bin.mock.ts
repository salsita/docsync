/**
 * The fake `git-remote-docsync` on a PATH, for every test that runs real git.
 *
 * git discovers a remote helper by name, so a test that wants `git clone
 * docsync::…` — or a `docsync` command that shells out to git — needs the
 * helper as an executable file. This builds `fake-helper.mock.ts` (the real
 * helper over the fake `Source`) with `tsc` and puts a shim in a directory the
 * caller prepends to PATH.
 *
 * Each caller gets its own cache directory, because vitest runs test files in
 * parallel and two builds into one directory would race.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Builds the fake helper and answers the directory to put on PATH. */
export function buildFakeHelper(cacheName: string): string {
  const build = join(PACKAGE_ROOT, 'node_modules', '.cache', cacheName);
  const bin = join(build, 'bin');
  rmSync(build, { recursive: true, force: true });
  execFileSync(
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.e2e.json', '--outDir', build],
    { cwd: PACKAGE_ROOT, stdio: 'inherit' },
  );
  writeFileSync(join(build, 'package.json'), '{ "type": "module" }\n');
  mkdirSync(bin, { recursive: true });
  // Windows needs a .cmd shim and is ticket 12; here the shim is a shell script.
  const shim = join(bin, 'git-remote-docsync');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${join(build, 'helper', 'fake-helper.mock.js')}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return bin;
}
