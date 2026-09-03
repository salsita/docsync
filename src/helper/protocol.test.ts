import { describe, expect, it, vi } from 'vitest';
import { type Commands, runProtocol } from './protocol.js';

async function* lines(text: string): AsyncGenerator<string> {
  for (const line of text.split('\n')) yield line;
}

function fakeCommands(): Commands & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    capabilities: () => ['fetch', 'push', 'option'],
    async option(name, value) {
      calls.push(['option', name, value]);
      return name === 'verbosity' ? 'ok' : 'unsupported';
    },
    async list(forPush) {
      calls.push(['list', forPush]);
      return [`${'a'.repeat(40)} refs/heads/main`, '@refs/heads/main HEAD'];
    },
    async fetch(refs) {
      calls.push(['fetch', refs]);
    },
    async push(refspecs) {
      calls.push(['push', refspecs]);
      return refspecs.map((spec) => `ok ${spec.split(':')[1]}`);
    },
  };
}

async function run(input: string, commands = fakeCommands()) {
  const out: string[] = [];
  await runProtocol(lines(input), (line) => out.push(line), commands);
  return { out, calls: commands.calls };
}

describe('runProtocol', () => {
  it('answers capabilities with one per line and a blank line', async () => {
    expect((await run('capabilities\n')).out).toEqual(['fetch', 'push', 'option', '']);
  });

  it('answers list and list for-push, each ended by a blank line', async () => {
    const { out, calls } = await run('list\nlist for-push\n');
    expect(out).toEqual([
      `${'a'.repeat(40)} refs/heads/main`,
      '@refs/heads/main HEAD',
      '',
      `${'a'.repeat(40)} refs/heads/main`,
      '@refs/heads/main HEAD',
      '',
    ]);
    expect(calls).toEqual([
      ['list', false],
      ['list', true],
    ]);
  });

  it('collects a batch of fetch lines up to the blank line, then acknowledges', async () => {
    const sha = 'b'.repeat(40);
    const { out, calls } = await run(`fetch ${sha} refs/heads/main\nfetch ${sha} HEAD\n\n`);
    expect(calls).toEqual([
      [
        'fetch',
        [
          { sha, name: 'refs/heads/main' },
          { sha, name: 'HEAD' },
        ],
      ],
    ]);
    expect(out).toEqual(['']);
  });

  it('collects a batch of push lines and answers one line per refspec plus a blank', async () => {
    const { out, calls } = await run(
      'push refs/heads/main:refs/heads/main\npush +refs/heads/x:refs/heads/y\n\n',
    );
    expect(calls).toEqual([
      ['push', ['refs/heads/main:refs/heads/main', '+refs/heads/x:refs/heads/y']],
    ]);
    expect(out).toEqual(['ok refs/heads/main', 'ok refs/heads/y', '']);
  });

  it('relays option replies', async () => {
    const { out } = await run('option verbosity 0\noption progress true\n');
    expect(out).toEqual(['ok', 'unsupported']);
  });

  it('runs a batch that EOF ends rather than a blank line', async () => {
    const { calls } = await run('push refs/heads/main:refs/heads/main');
    expect(calls).toEqual([['push', ['refs/heads/main:refs/heads/main']]]);
  });

  it('ignores a stray blank line and stops at EOF', async () => {
    const commands = fakeCommands();
    const { out } = await run('\n\ncapabilities\n', commands);
    expect(out).toEqual(['fetch', 'push', 'option', '']);
  });

  it('refuses a command it does not know', async () => {
    await expect(run('import refs/heads/main\n')).rejects.toThrow(
      'unknown command from git: import refs/heads/main',
    );
  });

  it('lets a failing command propagate', async () => {
    const commands = fakeCommands();
    commands.list = vi.fn(async () => {
      throw new Error('no manifest');
    });
    await expect(run('list\n', commands)).rejects.toThrow('no manifest');
  });
});
