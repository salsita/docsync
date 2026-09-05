import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from './auth/provider.js';
import { createContext } from './cli/context.js';
import { runCli } from './cli/program.js';
import { createFakeRegistry, createMemoryStore } from './helper/fake-source.mock.js';
import { createStreamWriter } from './stdio.js';

/** A stream that answers every write the way a closed pipe does. */
function erroringStream(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, done) {
      done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
}

describe('createStreamWriter', () => {
  it('writes text verbatim while the reader is there, and flushes what it queued', async () => {
    const stream = new PassThrough();
    let seen = '';
    stream.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
    });
    const writer = createStreamWriter(stream);
    writer.write('two lines\n');
    writer.write('no newline of its own');
    await writer.flush();
    expect(writer.broken()).toBe(false);
    expect(seen).toBe('two lines\nno newline of its own');
  });

  it('goes quiet on a stdout the reader has closed, and never throws at the caller', async () => {
    const stream = new PassThrough();
    const writer = createStreamWriter(stream);
    // What `docsync status | head` leaves behind once head has its lines.
    stream.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(() => writer.write('a report line\n')).not.toThrow();
    await writer.flush();
    expect(writer.broken()).toBe(true);

    expect(() => writer.write('and the next one\n')).not.toThrow();
    await writer.flush();
  });

  it('goes quiet on a stdout that answers every write with an error', async () => {
    const writer = createStreamWriter(erroringStream());
    expect(() => writer.write('a report line\n')).not.toThrow();
    await writer.flush();
    expect(writer.broken()).toBe(true);
    expect(() => writer.write('and the next one\n')).not.toThrow();
    await writer.flush();
  });
});

describe('the command line over a broken stdout', () => {
  /** `cli.ts`'s own wiring, over the streams a test hands it. */
  async function cliOver(stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream) {
    const out = createStreamWriter(stdout);
    const err = createStreamWriter(stderr);
    const code = await runCli(
      ['--version'],
      createContext({
        cwd: '/nowhere',
        out: (text) => out.write(text),
        err: (text) => err.write(text),
        sources: createFakeRegistry(createMemoryStore()),
        provider: createFakeCredentialProvider(),
      }),
    );
    await out.flush();
    await err.flush();
    return code;
  }

  it('answers the same exit code when stdout is closed', async () => {
    const stdout = new PassThrough();
    stdout.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(cliOver(stdout, new PassThrough())).resolves.toBe(0);
  });

  it('answers the same exit code when stdout errors on every write', async () => {
    await expect(cliOver(erroringStream(), new PassThrough())).resolves.toBe(0);
  });
});
