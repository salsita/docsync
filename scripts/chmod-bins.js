#!/usr/bin/env node
// tsc keeps the shebang but not the executable bit. npm/pnpm set it when the
// package is installed; this makes `node dist/cli.js`-free local runs work too.
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const bin of ['cli.js', 'remote-helper.js']) {
  const path = fileURLToPath(new URL(`../dist/${bin}`, import.meta.url));
  if (existsSync(path)) {
    chmodSync(path, 0o755);
  }
}
