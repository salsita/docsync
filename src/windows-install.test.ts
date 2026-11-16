import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { installWindowsRemoteHelper } from '../scripts/postinstall.js';
import { HELPER_BIN } from './helper/fake-bin.mock.js';

const made: string[] = [];
const execFileAsync = promisify(execFile);

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  made.push(path);
  return path;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('the Windows remote-helper installation', () => {
  it('replaces npm’s extensionless shell shim with the packaged launcher', () => {
    const root = temp('docsync-windows-package-');
    const prefix = temp('docsync-windows-prefix-');
    mkdirSync(join(root, 'launcher'));
    writeFileSync(join(root, 'launcher', 'git-remote-docsync.exe'), Buffer.from([0x4d, 0x5a, 1]));
    writeFileSync(join(prefix, 'git-remote-docsync'), '#!/bin/sh\n');

    expect(
      installWindowsRemoteHelper({
        platform: 'win32',
        global: true,
        packageRoot: root,
        prefix,
      }),
    ).toBe(true);
    expect(readFileSync(join(prefix, 'git-remote-docsync'))).toEqual(Buffer.from([0x4d, 0x5a, 1]));
  });

  it('does nothing for a local install or another platform', () => {
    const root = temp('docsync-windows-package-');
    const prefix = temp('docsync-windows-prefix-');

    expect(
      installWindowsRemoteHelper({
        platform: 'win32',
        global: false,
        packageRoot: root,
        prefix,
      }),
    ).toBe(false);
    expect(
      installWindowsRemoteHelper({
        platform: 'linux',
        global: true,
        packageRoot: root,
        prefix,
      }),
    ).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('the packaged Windows launcher', () => {
  it('is discovered by Git and relays the remote-helper protocol', async () => {
    const bin = temp('docsync-windows-bin-');
    const target = join(HELPER_BIN, '..', 'src', 'helper', 'fake-helper.mock.js');
    cpSync(
      join(import.meta.dirname, '..', 'launcher', 'git-remote-docsync.exe'),
      join(bin, 'git-remote-docsync.exe'),
    );
    writeFileSync(join(bin, '.docsync.yaml'), 'version: 1\nroots: []\n');

    execFileSync('git', ['init', '--quiet'], { cwd: bin });
    execFileSync('git', ['remote', 'add', 'origin', 'docsync::.docsync.yaml'], { cwd: bin });

    await expect(
      execFileAsync('git', ['fetch', 'origin'], {
        cwd: bin,
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${bin};${process.env.PATH ?? ''}`,
          DOCSYNC_HELPER_ENTRY: target,
        },
      }),
    ).resolves.toBeDefined();
  });
});
