/**
 * The fake `git-remote-docsync` and `docsync` on a PATH, for every test that
 * runs real git.
 *
 * git discovers a remote helper by name, so a test that wants `git clone
 * docsync::…` — or a `docsync` command that shells out to git — needs the
 * helper as an executable file. This builds `fake-helper.mock.ts` (the real
 * helper over the fake `Source`) and `cli/fake-cli.mock.ts` (the real front
 * end over the same store) with `tsc`, and puts both shims in a directory a
 * test prepends to PATH.
 *
 * The build happens once for the whole run, in `global-setup.mock.ts`, before
 * any test file starts. It used to happen once per test file, into a cache
 * directory per caller, because two builds into one directory would race —
 * which meant `tsc` ran twice and the two real-git files were the slowest
 * things in CI, slow enough to time out under load (ticket 22). A single build
 * ahead of the workers costs one compile and needs no cache name: `HELPER_BIN`
 * is where it lands, and every caller reads it from there.
 *
 * The compiled sources go under `BUILD/src` and the package's `skill/`
 * directory is copied to `BUILD/skill`, so that the layout the build runs in
 * is the one `src/skill.ts` resolves the bundled skill file against: one
 * directory below a root that has `skill/` in it, exactly as `src/` and
 * `dist/` are (MANUAL §10).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUILD = join(PACKAGE_ROOT, 'node_modules', '.cache', 'docsync-helper');
const OUT = join(BUILD, 'src');

/** The directory holding the two shims, to put on PATH. */
export const HELPER_BIN = join(BUILD, 'bin');

/** Compiles the fake helper and the fake CLI and writes the shims. Once per run. */
export function buildFakeHelper(): string {
  rmSync(BUILD, { recursive: true, force: true });
  execFileSync(
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.e2e.json', '--outDir', OUT],
    { cwd: PACKAGE_ROOT, stdio: 'inherit' },
  );
  // ESM, and a version: `docsync --version` reads the package.json one
  // directory above the module, wherever the build sits (`src/version.ts`).
  const { version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  writeFileSync(join(BUILD, 'package.json'), `${JSON.stringify({ type: 'module', version })}\n`);
  // What `refreshSkillFiles` reads, at the place it looks for it.
  cpSync(join(PACKAGE_ROOT, 'skill'), join(BUILD, 'skill'), { recursive: true });
  mkdirSync(HELPER_BIN, { recursive: true });
  // Windows needs .cmd shims and is ticket 12; here a shim is a shell script.
  shim('git-remote-docsync', join(OUT, 'helper', 'fake-helper.mock.js'));
  shim('docsync', join(OUT, 'cli', 'fake-cli.mock.js'));
  return HELPER_BIN;
}

function shim(name: string, entry: string): void {
  const path = join(HELPER_BIN, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
  chmodSync(path, 0o755);
}
