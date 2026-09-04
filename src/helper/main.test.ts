import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import { createFakeRegistry, createMemoryStore } from './fake-source.mock.js';
import { createLineWriter, main } from './main.js';

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

describe('createLineWriter', () => {
  it('keeps writing while the reader is there, and flushes what it queued', async () => {
    const stream = new PassThrough();
    let seen = '';
    stream.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
    });
    const writer = createLineWriter(stream);
    writer.write('ok refs/heads/main');
    writer.write('');
    await writer.flush();
    expect(writer.broken()).toBe(false);
    expect(seen).toBe('ok refs/heads/main\n\n');
  });

  it('goes quiet once the reader has gone, and never throws at the caller', async () => {
    const stream = new PassThrough();
    const writer = createLineWriter(stream);
    // What git leaves behind when it has read all it wanted and exited.
    stream.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(() => writer.write('ok refs/heads/main')).not.toThrow();
    await writer.flush();
    expect(writer.broken()).toBe(true);

    // A later line — a report on stderr, the batch's closing blank — is a
    // no-op rather than a second chance to die.
    expect(() => writer.write('')).not.toThrow();
    await writer.flush();
  });
});
