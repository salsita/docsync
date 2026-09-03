import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import {
  addObject,
  createFakeRegistry,
  createMemoryStore,
  emptyState,
  fakeId,
} from './fake-source.mock.js';
import { type Commands, runProtocol } from './protocol.js';
import {
  createCommands,
  type HelperOptions,
  loadManifest,
  resolveManifest,
  runHelper,
} from './run.js';
import { createTempRepo, type TempRepo } from './temp-repo.mock.js';

const ROOT = fakeId('notion', 1);
const MANIFEST = `version: 1\nroots:\n  - src: notion:${ROOT}\n    path: Specs/\n`;

async function* lines(text: string): AsyncGenerator<string> {
  for (const line of text.split('\n')) yield line;
}

describe('resolveManifest', () => {
  it('resolves a relative manifest against the working tree, an absolute one as is', () => {
    const env = { GIT_DIR: '/repo/.git' };
    expect(resolveManifest({ argv: ['origin', 'docsync::.docsync.yaml'], env, cwd: '/x' })).toEqual(
      {
        remote: 'origin',
        gitDir: '/repo/.git',
        worktree: '/repo',
        manifestPath: '/repo/.docsync.yaml',
      },
    );
    expect(
      resolveManifest({
        argv: ['origin', '/abs/m.yaml'],
        env: { ...env, GIT_WORK_TREE: '/wt' },
        cwd: '/x',
      }).manifestPath,
    ).toBe('/abs/m.yaml');
    expect(
      resolveManifest({
        argv: ['origin', '../m.yaml'],
        env: { ...env, GIT_WORK_TREE: '/wt' },
        cwd: '/x',
      }).manifestPath,
    ).toBe('/m.yaml');
  });

  it('falls back to .git under the current directory and a remote called origin', () => {
    expect(resolveManifest({ argv: ['origin', 'm.yaml'], env: {}, cwd: '/here' })).toMatchObject({
      gitDir: '/here/.git',
      worktree: '/here',
      manifestPath: '/here/m.yaml',
    });
  });

  it('says how to call it when the URL is missing', () => {
    expect(() => resolveManifest({ argv: [], env: {}, cwd: '/' })).toThrow(
      'usage: git-remote-docsync <remote> docsync::<manifest>',
    );
  });
});

describe('loadManifest', () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = createTempRepo('docsync-run-');
  });
  afterAll(() => repo.remove());

  it('names the file when it is missing, the line when it does not parse, the root when it is invalid', async () => {
    const missing = join(repo.root, 'missing.yaml');
    await expect(loadManifest(missing)).rejects.toThrow(`${missing}: no such file`);

    const broken = join(repo.root, 'broken.yaml');
    writeFileSync(broken, 'version: 1\nroots:\n  - src: nonsense\n    path: Specs/\n');
    await expect(loadManifest(broken)).rejects.toThrow(new RegExp(`^${broken}:3: `));

    const overlapping = join(repo.root, 'overlap.yaml');
    writeFileSync(
      overlapping,
      `version: 1\nroots:\n  - src: notion:${ROOT}\n    path: Specs/\n  - src: notion:${fakeId('notion', 2)}\n    path: Specs/Inner/\n`,
    );
    await expect(loadManifest(overlapping)).rejects.toThrow(
      new RegExp(`^${overlapping}: root 2 \\(Specs/Inner/\\): `),
    );

    const unreadable = join(repo.root, 'dir.yaml');
    mkdirSync(unreadable);
    await expect(loadManifest(unreadable)).rejects.toThrow(
      new RegExp(`^${unreadable}: Error: EISDIR`),
    );
  });

  it('answers the manifest', async () => {
    const good = join(repo.root, 'good.yaml');
    writeFileSync(good, MANIFEST);
    expect((await loadManifest(good)).roots).toEqual([
      { src: { source: 'notion', id: ROOT }, path: 'Specs/', ignore: [] },
    ]);
  });
});

describe('createCommands', () => {
  let repo: TempRepo;
  let options: HelperOptions;
  let commands: Commands;
  let errors: string[];
  let refreshed: string[];

  beforeAll(() => {
    repo = createTempRepo('docsync-commands-');
    writeFileSync(join(repo.root, '.docsync.yaml'), MANIFEST);
    const state = emptyState();
    addObject(state, { id: ROOT, source: 'notion', kind: 'page', title: 'Specs', body: 'Root.\n' });
    errors = [];
    refreshed = [];
    options = {
      argv: ['origin', 'docsync::.docsync.yaml'],
      env: { GIT_DIR: repo.gitDir },
      cwd: '/',
      sources: createFakeRegistry(createMemoryStore(state)),
      provider: createFakeCredentialProvider({ notion: { accessToken: 't', identity: {} } }),
      input: lines(''),
      write: () => {},
      stderr: (line) => errors.push(line),
      now: () => new Date('2026-04-01T00:00:00Z'),
      refresh: async (worktree) => {
        refreshed.push(worktree);
      },
    };
    commands = createCommands(options);
  });
  afterAll(() => repo.remove());

  it('advertises fetch, push and option', () => {
    expect(commands.capabilities()).toEqual(['fetch', 'push', 'option']);
  });

  it('lists nothing for a push before the first fetch', async () => {
    expect(await commands.list(true)).toEqual([]);
  });

  it('fetches on list, refreshes the skill files first, and serves the commit', async () => {
    const listed = await commands.list(false);
    const served = await repo.git.revParse('refs/docsync/origin/main');
    expect(listed).toEqual([`${served} refs/heads/main`, '@refs/heads/main HEAD']);
    expect(refreshed).toEqual([repo.root]);
    expect(errors).toEqual(['notion: 1 changed']);

    // Unchanged: same commit, and `list for-push` answers it without fetching.
    expect(await commands.list(false)).toEqual(listed);
    expect(await commands.list(true)).toEqual(listed);
    expect(errors).toEqual(['notion: 1 changed', 'notion: unchanged']);
  });

  it('acknowledges fetch without doing anything', async () => {
    await expect(commands.fetch([{ sha: 'x', name: 'refs/heads/main' }])).resolves.toBeUndefined();
  });

  it('answers ok, a refusal and an error per refspec', async () => {
    const served = (await repo.git.revParse('refs/docsync/origin/main')) ?? '';
    repo.run('checkout', '--quiet', '-B', 'main', served);
    writeFileSync(join(repo.root, 'README.md'), 'outside\n');
    repo.run('add', 'README.md');
    repo.run('commit', '--quiet', '-m', 'outside');

    expect(
      await commands.push([
        `${served}:refs/heads/main`,
        '+refs/heads/main:refs/heads/main',
        'refs/heads/main:refs/heads/main',
      ]),
    ).toEqual([
      'ok refs/heads/main',
      'error refs/heads/main force push is not supported; fetch, merge and push again',
      'error refs/heads/main README.md: not under any root in the manifest',
    ]);
  });

  it('goes quiet at verbosity 0 and declines other options', async () => {
    expect(await commands.option('progress', 'true')).toBe('unsupported');
    expect(await commands.option('verbosity', '0')).toBe('ok');
    errors = [];
    await commands.list(false);
    expect(errors).toEqual([]);
    expect(await commands.option('verbosity', 'lots')).toBe('ok');
  });
});

describe('runHelper', () => {
  it('answers 0 after a clean run and 1 with the message on stderr after a failure', async () => {
    const errors: string[] = [];
    const out: string[] = [];
    const base = {
      env: {},
      cwd: '/',
      sources: createFakeRegistry(createMemoryStore()),
      provider: createFakeCredentialProvider(),
      write: (line: string) => out.push(line),
      stderr: (line: string) => errors.push(line),
    };
    expect(
      await runHelper({
        ...base,
        argv: ['origin', 'docsync::m.yaml'],
        input: lines('capabilities\n'),
      }),
    ).toBe(0);
    expect(out).toEqual(['fetch', 'push', 'option', '']);

    expect(await runHelper({ ...base, argv: [], input: lines('capabilities\n') })).toBe(1);
    expect(errors).toEqual(['docsync: usage: git-remote-docsync <remote> docsync::<manifest>']);
    expect(
      await runHelper({ ...base, argv: ['origin', 'docsync::m.yaml'], input: lines('import x\n') }),
    ).toBe(1);
    expect(errors.at(-1)).toBe('docsync: unknown command from git: import x');
  });
});

describe('the protocol over the commands', () => {
  it('speaks the whole exchange git makes for a clone', async () => {
    const repo = createTempRepo('docsync-clone-');
    try {
      writeFileSync(join(repo.root, '.docsync.yaml'), MANIFEST);
      const state = emptyState();
      addObject(state, {
        id: ROOT,
        source: 'notion',
        kind: 'page',
        title: 'Specs',
        body: 'Root.\n',
      });
      const out: string[] = [];
      const commands = createCommands({
        argv: ['origin', 'docsync::.docsync.yaml'],
        env: { GIT_DIR: repo.gitDir },
        cwd: '/',
        sources: createFakeRegistry(createMemoryStore(state)),
        provider: createFakeCredentialProvider({ notion: { accessToken: 't', identity: {} } }),
        input: lines(''),
        write: () => {},
        stderr: () => {},
      });
      await runProtocol(
        lines('capabilities\noption verbosity 1\nlist\nfetch 0000 refs/heads/main\n\n'),
        (line) => out.push(line),
        commands,
      );
      const served = await repo.git.revParse('refs/docsync/origin/main');
      expect(out).toEqual([
        'fetch',
        'push',
        'option',
        '',
        'ok',
        `${served} refs/heads/main`,
        '@refs/heads/main HEAD',
        '',
        '',
      ]);
    } finally {
      repo.remove();
    }
  });
});
