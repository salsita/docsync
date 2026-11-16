/**
 * Installs the native entry point Git for Windows needs for a remote helper.
 *
 * npm puts an extensionless POSIX shell shim on PATH for every `bin` entry.
 * Git for Windows finds that exact file before trying `.cmd` or `.exe`, but
 * cannot reliably execute it with protocol pipes attached (#12). Replacing
 * that npm-owned file means npm will still remove it on uninstall.
 */
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {{ platform: string, global: boolean, packageRoot: string, prefix: string }} options
 * @returns {boolean} whether this install wrote the launcher
 */
export function installWindowsRemoteHelper(options) {
  if (options.platform !== 'win32' || !options.global) return false;
  copyFileSync(
    join(options.packageRoot, 'launcher', 'git-remote-docsync.exe'),
    join(options.prefix, 'git-remote-docsync'),
  );
  return true;
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === script) {
  installWindowsRemoteHelper({
    platform: process.platform,
    global: process.env.npm_config_global === 'true',
    packageRoot: resolve(dirname(script), '..'),
    prefix: process.env.npm_config_prefix ?? '',
  });
}
