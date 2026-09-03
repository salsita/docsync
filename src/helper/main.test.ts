import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import { createFakeRegistry, createMemoryStore } from './fake-source.mock.js';
import { main } from './main.js';

function fakeProcess(argv: string[], input: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  stdin.end(input);
  return {
    proc: { argv: ['node', 'helper', ...argv], env: {}, cwd: () => '/', stdin, stdout, stderr },
    out: () => out,
    err: () => err,
  };
}

describe('main', () => {
  it('wires stdin lines to the helper and its replies to stdout', async () => {
    const { proc, out } = fakeProcess(['origin', 'docsync::m.yaml'], 'capabilities\r\n');
    const code = await main(
      createFakeRegistry(createMemoryStore()),
      createFakeCredentialProvider(),
      proc,
    );
    expect(code).toBe(0);
    expect(out()).toBe('fetch\npush\noption\n\n');
  });

  it('reports a failed run on stderr with a non-zero code', async () => {
    const { proc, err } = fakeProcess([], 'capabilities\n');
    const code = await main(
      createFakeRegistry(createMemoryStore()),
      createFakeCredentialProvider(),
      proc,
    );
    expect(code).toBe(1);
    expect(err()).toBe('docsync: usage: git-remote-docsync <remote> docsync::<manifest>\n');
  });
});
