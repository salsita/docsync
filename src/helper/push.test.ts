import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import type { Manifest } from '../manifest/types.js';
import {
  addObject,
  createFakeRegistry,
  createMemoryStore,
  editObject,
  emptyState,
  type FakeStore,
  fakeId,
} from './fake-source.mock.js';
import { type FetchDeps, fetchCommit } from './fetch.js';
import { pushRef } from './push.js';
import type { PushReportFile } from './report.js';
import { createTempRepo, type TempRepo } from './temp-repo.mock.js';
import { readTree } from './tree.js';

const NOTION_ROOT = fakeId('notion', 1);
const DRIVE_ROOT = fakeId('gdocs', 1);
const AUTH = fakeId('notion', 2);
const REF = 'refs/docsync/origin/main';
const BRANCH = 'refs/heads/main';

const manifest: Manifest = {
  version: 1,
  roots: [
    { src: { source: 'notion', id: NOTION_ROOT }, path: 'Specs.md', ignore: [] },
    { src: { source: 'gdocs', id: DRIVE_ROOT }, path: 'Files/', ignore: [] },
  ],
};

function seed() {
  const state = emptyState();
  addObject(state, {
    id: NOTION_ROOT,
    source: 'notion',
    kind: 'page',
    title: 'Specs',
    body: 'Root.\n',
  });
  addObject(state, {
    id: AUTH,
    source: 'notion',
    kind: 'page',
    title: 'Auth',
    parent: NOTION_ROOT,
    body: 'Log in.\n',
  });
  addObject(state, { id: DRIVE_ROOT, source: 'gdocs', kind: 'folder', title: 'Files' });
  addObject(state, {
    id: fakeId('gdocs', 2),
    source: 'gdocs',
    kind: 'file',
    title: 'logo.png',
    parent: DRIVE_ROOT,
    bytes: Buffer.from('PNG').toString('base64'),
  });
  return state;
}

describe('pushRef', () => {
  let repo: TempRepo;
  let store: FakeStore;
  let deps: FetchDeps;
  let logged: string[];

  beforeAll(() => {
    repo = createTempRepo('docsync-push-');
  });
  afterAll(() => repo.remove());

  /** A served commit on the private ref, and the working tree checked out at it. */
  async function serve(): Promise<string> {
    store = createMemoryStore(seed());
    logged = [];
    deps = {
      git: repo.git,
      sources: createFakeRegistry(store),
      provider: createFakeCredentialProvider({
        notion: { accessToken: 't', identity: {} },
        gdocs: { accessToken: 't', identity: {} },
      }),
      log: (line) => logged.push(line),
      now: () => new Date('2026-04-01T00:00:00Z'),
    };
    const { commit } = await fetchCommit(deps, manifest, undefined);
    await repo.git.updateRef(REF, commit);
    repo.run('checkout', '--quiet', '-B', 'main', commit);
    logged = [];
    return commit;
  }

  const write = (path: string, body: string | Buffer): void => {
    mkdirSync(dirname(join(repo.root, path)), { recursive: true });
    writeFileSync(join(repo.root, path), body);
  };
  const commit = (message: string): string => {
    repo.run('add', '-A');
    repo.run('commit', '--quiet', '--allow-empty', '-m', message);
    return repo.run('rev-parse', 'HEAD');
  };
  const push = (refspec = `${BRANCH}:${BRANCH}`) =>
    pushRef(deps, { manifest, refspec, ref: REF, branch: BRANCH });

  it('applies an edit, then fetches on top of the pushed commit', async () => {
    const served = await serve();
    write('Specs/Auth.md', `---\nid: notion:${AUTH}\ntitle: Auth\n---\n\nLog in, then out.\n`);
    const pushed = commit('edit');

    expect(await push()).toEqual({ ok: true });
    expect(store.load().objects[AUTH]?.body).toBe('Log in, then out.\n');
    expect(store.load().pushes).toEqual([
      {
        root: 'Specs.md',
        changes: [
          { kind: 'modified', path: 'Specs/Auth.md', text: expect.stringContaining('then out') },
        ],
      },
    ]);
    // The post-push commit sits on the pushed one, and the ref moved there.
    const after = await repo.git.revParse(REF);
    expect(after).not.toBe(served);
    expect(await repo.git.text(['rev-parse', `${after}^`])).toBe(pushed);
    expect(logged).toContain('notion: updated Specs/Auth.md');
  });

  it('answers ok and advances the ref when the pushed diff is empty', async () => {
    await serve();
    const pushed = commit('nothing');
    expect(await push()).toEqual({ ok: true });
    expect(await repo.git.revParse(REF)).toBe(pushed);
    expect(store.load().pushes).toEqual([]);
  });

  it('refuses a forced push before touching anything', async () => {
    await serve();
    expect(await push(`+${BRANCH}:${BRANCH}`)).toEqual({
      ok: false,
      message: 'force push is not supported; fetch, merge and push again',
    });
    expect(logged).toEqual([]);
  });

  it('refuses a push to any other branch', async () => {
    await serve();
    expect(await push(`${BRANCH}:refs/heads/topic`)).toEqual({
      ok: false,
      message: 'only refs/heads/main can be pushed to a docsync remote',
    });
  });

  it('refuses when the source changed, and serves the new state', async () => {
    const served = await serve();
    const state = store.load();
    editObject(state, AUTH, { body: 'Changed at the source.\n' });
    store.save(state);
    write('Specs/Auth.md', `---\nid: notion:${AUTH}\ntitle: Auth\n---\n\nChanged locally.\n`);
    commit('edit');

    expect(await push()).toEqual({
      ok: false,
      message: 'the source changed since the last fetch; fetch and merge first',
    });
    const now = await repo.git.revParse(REF);
    expect(now).not.toBe(served);
    expect(await repo.git.text(['rev-parse', `${now}^`])).toBe(served);
    expect(store.load().objects[AUTH]?.body).toBe('Changed at the source.\n');
  });

  it('refuses a non-fast-forward push and a source that is not a commit', async () => {
    const served = await serve();
    repo.run('checkout', '--quiet', '-B', 'main', `${served}^{}`);
    repo.run('checkout', '--quiet', '--orphan', 'other');
    const pushed = commit('unrelated');
    expect(await push(`${pushed}:${BRANCH}`)).toEqual({
      ok: false,
      message: 'non-fast-forward; fetch and merge first',
    });
    expect(await push(`refs/heads/nope:${BRANCH}`)).toEqual({
      ok: false,
      message: 'refs/heads/nope is not a commit',
    });
    expect(await repo.git.revParse(REF)).toBe(served);
  });

  it('lets a refusal from the diff through with its path, ref untouched', async () => {
    const served = await serve();
    write('.docsync/index.yaml', '[]\n');
    commit('edit the index');
    await expect(push()).rejects.toThrow(
      '.docsync/index.yaml: the index is written by fetch; do not edit it',
    );
    expect(await repo.git.revParse(REF)).toBe(served);
    expect(store.load().pushes).toEqual([]);
  });

  it('sends no request for a file under no root, and the post-push fetch keeps it (ticket 35)', async () => {
    await serve();
    write('notes/a.md', 'hi\n');
    const pushed = commit('notes');

    expect(await push()).toEqual({ ok: true });
    expect(store.load().pushes).toEqual([]);
    // The pushed commit is the parent of the post-push fetch, so the file is
    // in the served tree without anyone having fetched it from a source.
    const after = (await repo.git.revParse(REF)) ?? '';
    expect(await repo.git.isAncestor(pushed, after)).toBe(true);
    expect([...(await readTree(repo.git, after)).keys()]).toContain('notes/a.md');
  });

  it('creates, trashes and renames through the adapter, and logs each', async () => {
    await serve();
    write('Specs/New.md', '---\ntitle: New page\n---\n\nFresh.\n');
    rmSync(join(repo.root, 'Files/logo.png'));
    write('Files/plain.txt', 'plain\n');
    commit('several');

    expect(await push()).toEqual({ ok: true });
    // Pre-flight, then the adapters, then the post-push fetch.
    expect(logged).toEqual([
      'listing Specs.md',
      'notion: unchanged',
      'listing Files/',
      'gdocs: unchanged',
      '1/1 Specs/New.md',
      'notion: created Specs/New.md',
      '1/2 Files/logo.png',
      '2/2 Files/plain.txt',
      'gdocs: trashed Files/logo.png',
      'gdocs: created Files/plain.txt',
      'listing Specs.md',
      '1 Specs/New page.md',
      'notion: 1 changed',
      'listing Files/',
      '1/1 Files/plain.txt',
      'gdocs: 1 changed',
    ]);
    const tree = await readTree(repo.git, (await repo.git.revParse(REF)) ?? '');
    expect([...tree.keys()].sort()).toEqual([
      '.docsync/index.yaml',
      'Files/plain.txt',
      'Specs.md',
      'Specs/Auth.md',
      'Specs/New page.md',
    ]);
  });

  it('reports every document it touched, for `docsync push` to print', async () => {
    await serve();
    const reports: PushReportFile[] = [];
    deps.report = {
      fetch: async () => undefined,
      push: async (one) => {
        reports.push(one);
      },
    };
    write('Specs/New.md', '---\ntitle: New page\n---\n\nFresh.\n');
    rmSync(join(repo.root, 'Files/logo.png'));
    commit('a create and a trash');

    expect(await push()).toEqual({ ok: true });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.at).toBe('2026-04-01T00:00:00.000Z');
    expect(reports[0]?.documents).toEqual([
      { path: 'Specs/New.md', title: 'New page', action: 'created' },
      { path: 'Files/logo.png', title: 'logo.png', action: 'trashed' },
    ]);
    expect(reports[0]?.skipped).toEqual([]);
    delete deps.report;
  });

  it('writes no push report when the push is refused', async () => {
    await serve();
    const reports: PushReportFile[] = [];
    deps.report = {
      fetch: async () => undefined,
      push: async (one) => {
        reports.push(one);
      },
    };

    expect(await push(`+${BRANCH}:${BRANCH}`)).toMatchObject({ ok: false });

    expect(reports).toEqual([]);
    delete deps.report;
  });
});
