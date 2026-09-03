import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import { createFakeRegistry, createMemoryStore } from '../helper/fake-source.mock.js';
import { version } from '../version.js';
import { type Context, createContext } from './context.js';
import { COMMAND_REFERENCE } from './print.js';
import { runCli } from './program.js';

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Run> {
  let out = '';
  let err = '';
  const context: Context = createContext({
    cwd: '/nowhere',
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    sources: createFakeRegistry(createMemoryStore()),
    provider: createFakeCredentialProvider(),
    auth: {
      signIn: async () => ({ name: 'Ada' }),
      signOut: async () => true,
      whoAmI: async () => ({ name: 'Ada' }),
    },
  });
  return { code: await runCli(argv, context), out, err };
}

describe('the docsync command line', () => {
  it('prints the command reference of MANUAL §13 as its help', async () => {
    const run = await cli('--help');

    expect(run.out).toBe(`${COMMAND_REFERENCE}\n`);
    expect(run.code).toBe(0);
  });

  it('prints the reference when it is asked for nothing at all', async () => {
    const run = await cli();

    expect(`${run.out}${run.err}`).toContain('docsync resolve <src>');
  });

  it('prints the installed version', async () => {
    const run = await cli('--version');

    expect(run.out).toBe(`${version}\n`);
    expect(run.code).toBe(0);
  });

  it('still generates the help of one command, so a flag is documented', async () => {
    const run = await cli('add', '--help');

    expect(run.out).toContain('--no-fetch');
    expect(run.out).toContain('Stop once the manifest is written.');
  });

  it('refuses a command it does not have', async () => {
    const run = await cli('sync');

    expect(run.code).toBe(1);
    expect(run.err).toContain("unknown command 'sync'");
  });

  it('refuses an option it does not have', async () => {
    const run = await cli('status', '--force');

    expect(run.code).toBe(1);
    expect(run.err).toContain('--force');
  });

  it('names the argument a command is missing', async () => {
    const run = await cli('resolve');

    expect(run.code).toBe(1);
    expect(run.err).toContain("missing required argument 'src'");
  });

  it('says in one line what went wrong, and exits 1', async () => {
    const run = await cli('resolve', 'nonsense');

    expect(run.code).toBe(1);
    expect(run.err.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(run.err).toMatch(/^docsync: nonsense: /);
  });

  it('runs a command that needs no checkout, and exits 0', async () => {
    const run = await cli('auth', 'notion', '--logout');

    expect(run).toMatchObject({ code: 0, out: 'Signed out of notion.\n' });
  });

  it('takes google as a spelling of gdocs, and refuses anything else', async () => {
    expect((await cli('auth', 'google', '--logout')).out).toBe('Signed out of gdocs.\n');
    expect((await cli('auth', 'dropbox')).err).toContain('dropbox is not a source');
  });
});
