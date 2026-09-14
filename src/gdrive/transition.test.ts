/**
 * One tab becoming many, as git sees it (MANUAL §6, §7, ticket 37).
 *
 * The owner's condition on this ticket is that the transition is lossless in
 * both directions: nothing in the checkout is lost when a Doc gains a tab or
 * comes back down to one, and git's history follows the content across the
 * move. That is a claim about the *commits* a fetch writes, so this test runs
 * the whole read path — the real Drive adapter over the fake Drive, through
 * the helper's `fetchCommit` — into a real repository, and asks git.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import { type FetchDeps, fetchCommit } from '../helper/fetch.js';
import { createTempRepo, type TempRepo } from '../helper/temp-repo.mock.js';
import type { Manifest } from '../manifest/types.js';
import { parseMarkdown } from '../markdown.js';
import type { FetchOptions, SourceRegistry } from '../source.js';
import { createFakeDrive, type FakeDrive } from './fake-api.mock.js';
import { fetchRoot } from './index.js';
import { createGDriveWriter } from './write.js';

// Drive ids, long enough to be ones: the index is parsed back on every fetch.
const ROOT_ID = '1FolderRootIdXXXXXXXXXXX';
const DOC_ID = '1TabbedDocIdXXXXXXXXXXXX';

const manifest: Manifest = {
  version: 1,
  roots: [{ src: { source: 'gdocs', id: ROOT_ID }, path: 'drive/', ignore: [] }],
};

/** The registry `fetchCommit` calls, with the fake Drive behind the adapter. */
function registry(api: FakeDrive): SourceRegistry {
  const source = {
    fetchRoot: (
      root: Parameters<typeof fetchRoot>[0],
      provider: Parameters<typeof fetchRoot>[1],
      previous: Parameters<typeof fetchRoot>[2],
      options: FetchOptions = {},
    ) => fetchRoot(root, provider, previous, { ...options, api }),
    pushRoot: () => {
      throw new Error('this test does not push');
    },
    describe: () => {
      throw new Error('this test does not resolve');
    },
  };
  return { gdocs: source, notion: source } as unknown as SourceRegistry;
}

describe('a Doc that gains a tab', () => {
  let repo: TempRepo;
  let api: FakeDrive;
  let deps: FetchDeps;

  beforeAll(async () => {
    repo = createTempRepo('docsync-tabs-');
    api = createFakeDrive([
      { id: ROOT_ID, name: 'Docsync test', mimeType: 'application/vnd.google-apps.folder' },
      { id: DOC_ID, name: 'Tabbed', parents: [ROOT_ID], modifiedTime: '2026-09-01T00:00:00Z' },
    ]);
    await createGDriveWriter(api).writeTab(DOC_ID, 't.0', parseMarkdown('The only tab.\n'));
    deps = {
      git: repo.git,
      sources: registry(api),
      provider: createFakeCredentialProvider({ gdocs: { accessToken: 'x', identity: {} } }),
      log: () => {},
      now: () => new Date('2026-09-14T12:00:00Z'),
    };
  });

  afterAll(() => repo.remove());

  it('moves the file to the directory, and git calls it a rename', async () => {
    const first = await fetchCommit(deps, manifest, undefined);
    expect(namesIn(repo, first.commit)).toContain('drive/Tabbed.md');

    // The Doc gains a second tab, as a Gemini notes Doc always has.
    const writer = createGDriveWriter(api);
    const second = await writer.addTab(DOC_ID, 'Second tab');
    await writer.writeTab(DOC_ID, second, parseMarkdown('The second tab.\n'));
    const file = api.files.get(DOC_ID);
    if (file !== undefined) file.modifiedTime = '2026-09-02T00:00:00Z';

    const next = await fetchCommit(deps, manifest, first.commit);

    // One file per tab, under a directory named after the Doc.
    expect(namesIn(repo, next.commit)).toEqual([
      '.docsync/index.yaml',
      'drive/Tabbed/Second tab.md',
      'drive/Tabbed/Tabbed.md',
    ]);
    // The first tab's file is the old file moved: git pairs them, so
    // `git log --follow` crosses the move (ticket 37).
    const renames = repo
      .run('diff-tree', '-M', '-r', '--name-status', first.commit, next.commit)
      .split('\n')
      .filter((line) => line.startsWith('R'));
    expect(renames).toHaveLength(1);
    expect(renames[0]?.split('\t').slice(1)).toEqual(['drive/Tabbed.md', 'drive/Tabbed/Tabbed.md']);
    // And the body came across untouched: only the id line gained the tab.
    expect(blob(repo, next.commit, 'drive/Tabbed/Tabbed.md')).toContain('The only tab.');
    expect(blob(repo, next.commit, 'drive/Tabbed/Tabbed.md')).toContain(`id: gdocs:${DOC_ID}#t.0`);
  });

  it('comes back to one file when the Doc comes back down to one tab', async () => {
    const before = await fetchCommit(deps, manifest, undefined);
    // The second tab is deleted in Docs, which only the source can do.
    await api.batchUpdate(DOC_ID, [{ deleteTab: { tabId: 't.new1' } }]);
    const file = api.files.get(DOC_ID);
    if (file !== undefined) file.modifiedTime = '2026-09-03T00:00:00Z';

    const after = await fetchCommit(deps, manifest, before.commit);

    expect(namesIn(repo, after.commit)).toEqual(['.docsync/index.yaml', 'drive/Tabbed.md']);
    // The id loses the tab, and the surviving tab's text is the file's.
    expect(blob(repo, after.commit, 'drive/Tabbed.md')).toContain(`id: gdocs:${DOC_ID}\n`);
    expect(blob(repo, after.commit, 'drive/Tabbed.md')).toContain('The only tab.');
  });
});

/** Every path one commit holds, sorted. */
function namesIn(repo: TempRepo, commit: string): string[] {
  return repo.run('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean).sort();
}

/** One file of one commit, as text. */
function blob(repo: TempRepo, commit: string, path: string): string {
  return repo.run('show', `${commit}:${path}`);
}
