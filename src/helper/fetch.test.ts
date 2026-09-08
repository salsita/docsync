import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import type { Manifest } from '../manifest/types.js';
import {
  addObject,
  createFakeRegistry,
  createMemoryStore,
  editObject,
  emptyState,
  type FakeState,
  fakeId,
  rewriteObject,
} from './fake-source.mock.js';
import { COMMITTER, type FetchDeps, fetchCommit } from './fetch.js';
import { INDEX_PATH, parseIndex } from './index-file.js';
import type { FetchReport } from './report.js';
import { createTempRepo, type TempRepo } from './temp-repo.mock.js';
import { buildTree, readTree } from './tree.js';

const NOTION_ROOT = fakeId('notion', 1);
const DRIVE_ROOT = fakeId('gdocs', 1);
const ADA = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const NAMELESS = { id: 'u-42' };

function seed(): FakeState {
  const state = emptyState();
  addObject(state, {
    id: NOTION_ROOT,
    source: 'notion',
    kind: 'page',
    title: 'Specs',
    body: 'The root page.\n',
    editor: NAMELESS,
  });
  addObject(state, {
    id: fakeId('notion', 2),
    source: 'notion',
    kind: 'page',
    title: 'Auth',
    parent: NOTION_ROOT,
    body: 'Log in first.\n',
    editor: ADA,
  });
  addObject(state, { id: DRIVE_ROOT, source: 'gdocs', kind: 'folder', title: 'Contracts' });
  addObject(state, {
    id: fakeId('gdocs', 2),
    source: 'gdocs',
    kind: 'file',
    title: 'logo.png',
    parent: DRIVE_ROOT,
    bytes: Buffer.from([137, 80, 78, 71]).toString('base64'),
  });
  return state;
}

const manifest: Manifest = {
  version: 1,
  roots: [
    { src: { source: 'notion', id: NOTION_ROOT }, path: 'Specs.md', ignore: [] },
    { src: { source: 'gdocs', id: DRIVE_ROOT }, path: 'Contracts/', ignore: [] },
  ],
};

describe('fetchCommit', () => {
  let repo: TempRepo;
  let store: ReturnType<typeof createMemoryStore>;
  let deps: FetchDeps;
  let logged: string[];

  beforeAll(() => {
    repo = createTempRepo('docsync-fetch-');
  });
  afterAll(() => repo.remove());

  const reset = (state = seed()): void => {
    store = createMemoryStore(state);
    logged = [];
    deps = {
      git: repo.git,
      sources: createFakeRegistry(store),
      provider: createFakeCredentialProvider({
        notion: { accessToken: 't', identity: { name: 'N' } },
        gdocs: { accessToken: 't', identity: { name: 'G' } },
      }),
      log: (line) => logged.push(line),
      now: () => new Date('2026-04-01T00:00:00Z'),
    };
  };

  it('writes the first commit with every file, the index, the last editor and their date', async () => {
    reset();
    const { commit, changed } = await fetchCommit(deps, manifest, undefined);
    expect(changed).toBe(true);

    const tree = await readTree(repo.git, commit);
    expect([...tree.keys()].sort()).toEqual([
      '.docsync/index.yaml',
      'Contracts/logo.png',
      'Specs.md',
      'Specs/Auth.md',
    ]);
    const auth = (await repo.git.catBlob(tree.get('Specs/Auth.md')?.sha ?? '')).toString();
    expect(auth).toBe(
      `---\nid: notion:${fakeId('notion', 2)}\ntitle: Auth\n` +
        `url: https://www.notion.so/${fakeId('notion', 2)}\n---\n\nLog in first.\n`,
    );

    const index = parseIndex((await repo.git.catBlob(tree.get(INDEX_PATH)?.sha ?? '')).toString());
    expect([...index.keys()]).toEqual(['Contracts/logo.png', 'Specs.md', 'Specs/Auth.md']);
    expect(index.get('Contracts/logo.png')).toMatchObject({
      type: 'drive-file',
      md5: expect.any(String),
    });

    // The most recently edited changed document is the logo, which has no
    // editor; the latest one that does is Ada.
    const edited = store.load().objects[fakeId('notion', 2)]?.lastEditedTime ?? '';
    expect(await repo.git.text(['log', '-1', '--format=%an|%ae|%at|%cn|%ce|%ct|%P', commit])).toBe(
      `Ada Lovelace|ada@example.com|${Date.parse(edited) / 1000}|${COMMITTER.name}|${COMMITTER.email}|${Date.parse('2026-04-01T00:00:00Z') / 1000}|`,
    );
    expect(await repo.git.text(['log', '-1', '--format=%B', commit])).toBe(
      'Add 3 documents\n\nContracts/logo.png\nSpecs.md\nSpecs/Auth.md\n',
    );
    expect(logged).toEqual([
      'listing Specs.md',
      '1 Specs.md',
      '2 Specs/Auth.md',
      'notion: 2 changed',
      'listing Contracts/',
      '1/1 Contracts/logo.png',
      'gdocs: 1 changed',
    ]);
  });

  it('adds no commit when nothing changed, and does not download anything', async () => {
    reset();
    const first = await fetchCommit(deps, manifest, undefined);
    logged = [];
    const second = await fetchCommit(deps, manifest, first.commit);
    expect(second).toMatchObject({ commit: first.commit, changed: false });
    expect(logged).toEqual([
      'listing Specs.md',
      'notion: unchanged',
      'listing Contracts/',
      'gdocs: unchanged',
    ]);
  });

  it('commits one edit on top of the previous commit, touching that file only', async () => {
    reset();
    const first = await fetchCommit(deps, manifest, undefined);
    const state = store.load();
    editObject(state, fakeId('notion', 2), { body: 'Log in first, then out.\n', editor: NAMELESS });
    store.save(state);

    const second = await fetchCommit(deps, manifest, first.commit);
    expect(second.changed).toBe(true);
    expect(await repo.git.text(['rev-parse', `${second.commit}^`])).toBe(first.commit);
    expect(
      (await repo.git.diffTree(first.commit, second.commit)).map((e) => e.path).sort(),
    ).toEqual(['.docsync/index.yaml', 'Specs/Auth.md']);
    expect(await repo.git.text(['log', '-1', '--format=%an <%ae>%n%B', second.commit])).toBe(
      'u-42 <u-42@notion>\nUpdate 1 document\n\nSpecs/Auth.md\n',
    );
  });

  it('leaves the files of a root that left the manifest, which are local now', async () => {
    reset();
    const first = await fetchCommit(deps, manifest, undefined);
    const fewer: Manifest = { version: 1, roots: manifest.roots.slice(0, 1) };
    const second = await fetchCommit(deps, fewer, first.commit);
    // Nothing writes `Contracts/` any more, and a file under no root is local:
    // a fetch never loses one (ticket 35). `docsync remove` is what deletes
    // them, in a commit of its own (MANUAL §5).
    const tree = await readTree(repo.git, second.commit);
    expect([...tree.keys()].sort()).toEqual([
      '.docsync/index.yaml',
      'Contracts/logo.png',
      'Specs.md',
      'Specs/Auth.md',
    ]);
    // Only the index moved: the unsubscribed document left it.
    expect(await repo.git.text(['log', '-1', '--format=%an|%at|%B', second.commit])).toBe(
      `docsync|${Date.parse('2026-04-01T00:00:00Z') / 1000}|Update the index\n`,
    );
    const index = parseIndex((await repo.git.catBlob(tree.get(INDEX_PATH)?.sha ?? '')).toString());
    expect(index.has('Contracts/logo.png')).toBe(false);
  });

  describe('local files (MANUAL §7, ticket 35)', () => {
    /** A commit that adds one file on top of a fetch, as a push would. */
    const withFile = async (parent: string, path: string, body: string): Promise<string> => {
      const tree = await readTree(repo.git, parent);
      tree.set(path, { sha: await repo.git.hashObject(Buffer.from(body)) });
      const when = '2026-03-01T00:00:00Z';
      const who = { name: 'Test', email: 'test@example.com', date: when };
      return repo.git.commitTree({
        tree: await buildTree(repo.git, tree),
        parents: [parent],
        message: 'notes\n',
        author: who,
        committer: who,
      });
    };

    it('carries every file under no root over from the parent commit', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      const pushed = await withFile(first.commit, 'notes/a.md', 'hi\n');

      const state = store.load();
      editObject(state, fakeId('notion', 2), { body: 'Log in, then out.\n', editor: ADA });
      store.save(state);
      const second = await fetchCommit(deps, manifest, pushed);

      const tree = await readTree(repo.git, second.commit);
      expect([...tree.keys()].sort()).toEqual([
        '.docsync/index.yaml',
        'Contracts/logo.png',
        'Specs.md',
        'Specs/Auth.md',
        'notes/a.md',
      ]);
      expect((await repo.git.catBlob(tree.get('notes/a.md')?.sha ?? '')).toString()).toBe('hi\n');
      // It is not a document, so the index says nothing about it.
      const index = parseIndex(
        (await repo.git.catBlob(tree.get(INDEX_PATH)?.sha ?? '')).toString(),
      );
      expect(index.has('notes/a.md')).toBe(false);
    });

    it('makes no commit when the parent’s only news is a local file', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      const pushed = await withFile(first.commit, 'notes/a.md', 'hi\n');
      expect(await fetchCommit(deps, manifest, pushed)).toMatchObject({
        commit: pushed,
        changed: false,
      });
    });

    it('lets a root write over what the parent held inside its territory', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      // A path inside a root that the source does not have: the root's answer
      // is the whole of its territory, so the stray file goes.
      const pushed = await withFile(first.commit, 'Contracts/stray.txt', 'stray\n');
      const second = await fetchCommit(deps, manifest, pushed);
      expect([...(await readTree(repo.git, second.commit)).keys()]).not.toContain(
        'Contracts/stray.txt',
      );
    });
  });

  it('commits an index-only change when a time moved but no content did', async () => {
    reset();
    const first = await fetchCommit(deps, manifest, undefined);
    const state = store.load();
    editObject(state, fakeId('gdocs', 2), {});
    store.save(state);
    const second = await fetchCommit(deps, manifest, first.commit);
    expect(second.changed).toBe(true);
    expect(await repo.git.text(['log', '-1', '--format=%B', second.commit])).toBe(
      'Update the index\n',
    );
  });

  it('holds a directory root the way the adapters lay one out', async () => {
    reset();
    // Written by hand or by an earlier version: the page goes inside the
    // directory and its children in the sibling directory beside it (MANUAL §4).
    const directory: Manifest = {
      version: 1,
      roots: [{ src: { source: 'notion', id: NOTION_ROOT }, path: 'Specs/', ignore: [] }],
    };

    const { commit } = await fetchCommit(deps, directory, undefined);

    expect([...(await readTree(repo.git, commit)).keys()].sort()).toEqual([
      '.docsync/index.yaml',
      'Specs/Specs.md',
      'Specs/Specs/Auth.md',
    ]);
  });

  it('refuses a file the source calls unchanged that the last commit does not hold', async () => {
    reset();
    const first = await fetchCommit(deps, manifest, undefined);
    // A root that moved: same objects, new paths, index times unchanged.
    const moved: Manifest = {
      version: 1,
      roots: [{ src: { source: 'notion', id: NOTION_ROOT }, path: 'Moved/', ignore: [] }],
    };
    await expect(fetchCommit(deps, moved, first.commit)).rejects.toThrow(
      'Moved/Specs.md: the source reports it unchanged, but the last fetch did not write it',
    );
  });

  it('refuses a changed file that came with no content', async () => {
    reset();
    deps.sources = {
      ...deps.sources,
      notion: {
        ...deps.sources.notion,
        fetchRoot: async (root, provider, previous) => {
          const result = await createFakeRegistry(store).notion.fetchRoot(root, provider, previous);
          for (const file of result.files) {
            file.text = undefined;
            file.bytes = undefined;
          }
          return result;
        },
      },
    };
    await expect(fetchCommit(deps, manifest, undefined)).rejects.toThrow(
      'Specs.md: the source reports it changed but sent no content',
    );
  });

  it('ends the run with the sign-in command when a credential is missing', async () => {
    reset();
    deps.provider = createFakeCredentialProvider({});
    await expect(fetchCommit(deps, manifest, undefined)).rejects.toThrow(
      'Not signed in to Notion. Run: docsync auth notion',
    );
  });

  it('reports every changed document with its editor, for the CLI to print', async () => {
    reset();
    const reports: FetchReport[] = [];
    deps.report = {
      fetch: async (one) => {
        reports.push(one);
      },
      push: async () => undefined,
    };

    const { report } = await fetchCommit(deps, manifest, undefined);

    expect(reports).toEqual([report]);
    expect(report.at).toBe('2026-04-01T00:00:00.000Z');
    expect(report.changed.map((one) => one.path)).toEqual([
      'Specs.md',
      'Specs/Auth.md',
      'Contracts/logo.png',
    ]);
    expect(report.changed[1]).toEqual({
      path: 'Specs/Auth.md',
      lastEditedTime: store.load().objects[fakeId('notion', 2)]?.lastEditedTime,
      editor: ADA,
    });
    // The logo has no editor at the fake source, so it carries none.
    expect(report.changed[2]?.editor).toBeUndefined();
    expect(report.skipped).toEqual([]);
  });

  it('reports an empty change list when the fetch found nothing new', async () => {
    reset();
    const reports: FetchReport[] = [];
    const first = await fetchCommit(deps, manifest, undefined);
    deps.report = {
      fetch: async (one) => {
        reports.push(one);
      },
      push: async () => undefined,
    };

    const second = await fetchCommit(deps, manifest, first.commit);

    expect(second.changed).toBe(false);
    expect(reports).toEqual([{ at: '2026-04-01T00:00:00.000Z', changed: [], skipped: [] }]);
  });

  describe('a re-fetch (MANUAL §7, `--all`)', () => {
    /** The same deps, with every document downloaded and converted again. */
    const everything = (): FetchDeps => ({ ...deps, all: true });

    it('rewrites a document whose conversion came out differently', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      // A converter fix: the body differs, the source never moved.
      const state = store.load();
      rewriteObject(state, fakeId('notion', 2), { body: 'Log in **first**.\n' });
      store.save(state);

      // A plain fetch cannot see it: nothing at the source moved.
      expect(await fetchCommit(deps, manifest, first.commit)).toMatchObject({ changed: false });

      const second = await fetchCommit(everything(), manifest, first.commit);

      expect(second.changed).toBe(true);
      expect((await repo.git.diffTree(first.commit, second.commit)).map((one) => one.path)).toEqual(
        ['Specs/Auth.md'],
      );
      const tree = await readTree(repo.git, second.commit);
      expect((await repo.git.catBlob(tree.get('Specs/Auth.md')?.sha ?? '')).toString()).toContain(
        'Log in **first**.\n',
      );
    });

    it('is authored by docsync, dated now, when only the conversion moved', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      const state = store.load();
      rewriteObject(state, fakeId('notion', 2), { body: 'Log in **first**.\n' });
      store.save(state);

      const second = await fetchCommit(everything(), manifest, first.commit);

      // Not Ada: she edited the page a fetch ago, and this commit is not hers.
      expect(await repo.git.text(['log', '-1', '--format=%an|%ae|%at|%B', second.commit])).toBe(
        `${COMMITTER.name}|${COMMITTER.email}|${Date.parse('2026-04-01T00:00:00Z') / 1000}|` +
          'Update 1 document\n\nSpecs/Auth.md\n',
      );
    });

    it('credits the editor when a document really did change in the same run', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      const state = store.load();
      rewriteObject(state, fakeId('notion', 2), { body: 'Log in **first**.\n' });
      editObject(state, NOTION_ROOT, { body: 'The root page, edited.\n', editor: ADA });
      store.save(state);

      const second = await fetchCommit(everything(), manifest, first.commit);

      expect(await repo.git.text(['log', '-1', '--format=%an <%ae>', second.commit])).toBe(
        'Ada Lovelace <ada@example.com>',
      );
    });

    it('commits nothing when every document comes out as it already is', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      logged = [];

      const second = await fetchCommit(everything(), manifest, first.commit);

      expect(second).toMatchObject({ commit: first.commit, changed: false });
      expect(second.report.changed).toEqual([]);
      // Every document was downloaded, so every one is counted (ticket 24).
      expect(logged).toEqual([
        'listing Specs.md',
        '1 Specs.md',
        '2 Specs/Auth.md',
        'notion: 2 changed',
        'listing Contracts/',
        '1/1 Contracts/logo.png',
        'gdocs: 1 changed',
      ]);
    });

    it('marks a re-rendered document in the report and leaves the unmoved out', async () => {
      reset();
      const first = await fetchCommit(deps, manifest, undefined);
      const state = store.load();
      rewriteObject(state, fakeId('notion', 2), { body: 'Log in **first**.\n' });
      editObject(state, NOTION_ROOT, { body: 'The root page, edited.\n', editor: ADA });
      store.save(state);

      const { report } = await fetchCommit(everything(), manifest, first.commit);

      // The logo came down again and is byte for byte what it was, so it is
      // not a change; the page nobody edited is one, and says why.
      expect(report.changed).toEqual([
        {
          path: 'Specs.md',
          lastEditedTime: store.load().objects[NOTION_ROOT]?.lastEditedTime,
          editor: ADA,
        },
        {
          path: 'Specs/Auth.md',
          lastEditedTime: store.load().objects[fakeId('notion', 2)]?.lastEditedTime,
          editor: ADA,
          reRendered: true,
        },
      ]);
    });
  });

  describe('the comment sidecar (MANUAL §6)', () => {
    /** The same roots, with the Notion one asking for comments (MANUAL §4). */
    const commented: Manifest = {
      version: 1,
      roots: [
        {
          src: { source: 'notion', id: NOTION_ROOT },
          path: 'Specs.md',
          ignore: [],
          comments: true,
        },
        { src: { source: 'gdocs', id: DRIVE_ROOT }, path: 'Contracts/', ignore: [] },
      ],
    };

    /** The sidecar of `Specs/Auth.md`, stamped at `fetched`. */
    const sidecar = (fetched: string, thread = 'Is this still true?'): string =>
      [
        '---',
        `document: notion:${fakeId('notion', 2)}`,
        `fetched: ${fetched}`,
        '---',
        '',
        '## d1 — comment',
        '',
        '> Log in first.',
        '',
        'in: (top)',
        '',
        `**Jane Client** · 2026-04-01 09:00`,
        thread,
        '',
      ].join('\n');

    const withComments = (text?: string): FakeState => {
      const state = seed();
      const auth = state.objects[fakeId('notion', 2)];
      if (auth !== undefined && text !== undefined) auth.comments = text;
      return state;
    };

    it('writes it beside the document and keeps it out of the index', async () => {
      reset(withComments(sidecar('2026-04-01T00:00:00Z')));
      const { commit } = await fetchCommit(deps, commented, undefined);

      const tree = await readTree(repo.git, commit);
      expect([...tree.keys()].sort()).toContain('Specs/Auth.comments.md');
      const index = parseIndex(
        (await repo.git.catBlob(tree.get(INDEX_PATH)?.sha ?? '')).toString(),
      );
      expect([...index.keys()]).not.toContain('Specs/Auth.comments.md');
      // It is nobody's edit, so it is not a changed document of the report.
      expect(logged).toEqual([
        'listing Specs.md',
        '1 Specs.md',
        '2 Specs/Auth.md',
        'notion: 2 changed',
        'listing Contracts/',
        '1/1 Contracts/logo.png',
        'gdocs: 1 changed',
      ]);
    });

    it('has none for a document with no thread', async () => {
      reset();
      const { commit } = await fetchCommit(deps, commented, undefined);

      expect([...(await readTree(repo.git, commit)).keys()]).not.toContain(
        'Specs/Auth.comments.md',
      );
    });

    it('commits nothing when only the time of the fetch moved', async () => {
      reset(withComments(sidecar('2026-04-01T00:00:00Z')));
      const first = await fetchCommit(deps, commented, undefined);

      const state = store.load();
      const auth = state.objects[fakeId('notion', 2)];
      if (auth !== undefined) auth.comments = sidecar('2026-04-02T10:11:12Z');
      store.save(state);

      expect(await fetchCommit(deps, commented, first.commit)).toMatchObject({
        commit: first.commit,
        changed: false,
      });
    });

    it('commits a new comment as `Update comments on 1 document`', async () => {
      reset(withComments(sidecar('2026-04-01T00:00:00Z')));
      const first = await fetchCommit(deps, commented, undefined);

      const state = store.load();
      const auth = state.objects[fakeId('notion', 2)];
      if (auth !== undefined) auth.comments = sidecar('2026-04-02T10:11:12Z', 'Answered.');
      store.save(state);

      const second = await fetchCommit(deps, commented, first.commit);

      expect(second.changed).toBe(true);
      expect(await repo.git.text(['log', '-1', '--format=%B', second.commit])).toBe(
        'Update comments on 1 document\n\nSpecs/Auth.comments.md\n',
      );
      // Nobody edited a document, so the commit is docsync's own.
      expect(await repo.git.text(['log', '-1', '--format=%an', second.commit])).toBe(
        COMMITTER.name,
      );
    });

    it('names the commit after the documents a suggesting push made (MANUAL §7)', async () => {
      reset(withComments(sidecar('2026-04-01T00:00:00Z')));
      const first = await fetchCommit(deps, commented, undefined);

      const state = store.load();
      const auth = state.objects[fakeId('notion', 2)];
      if (auth !== undefined) auth.comments = sidecar('2026-04-02T10:11:12Z', 'Answered.');
      store.save(state);

      // The post-push fetch after a push that suggested: nothing was written to
      // the documents, and the commit says so rather than `Update comments on`.
      const second = await fetchCommit(deps, commented, first.commit, {
        suggested: ['Auth', 'Brief'],
      });

      expect(await repo.git.text(['log', '-1', '--format=%B', second.commit])).toBe(
        'Suggested: Auth, Brief\n\nSpecs/Auth.comments.md\n',
      );
    });

    it('removes the file when the root turns the option off', async () => {
      reset(withComments(sidecar('2026-04-01T00:00:00Z')));
      const first = await fetchCommit(deps, commented, undefined);
      expect([...(await readTree(repo.git, first.commit)).keys()]).toContain(
        'Specs/Auth.comments.md',
      );

      // `manifest` is the same two roots without `comments: true`, which is
      // what a hand edit of the manifest produces.
      const second = await fetchCommit(deps, manifest, first.commit);

      expect(second.changed).toBe(true);
      expect([...(await readTree(repo.git, second.commit)).keys()]).not.toContain(
        'Specs/Auth.comments.md',
      );
    });

    it('removes the file when the last thread is resolved', async () => {
      reset(withComments(sidecar('2026-04-01T00:00:00Z')));
      const first = await fetchCommit(deps, commented, undefined);

      const state = store.load();
      const auth = state.objects[fakeId('notion', 2)];
      if (auth !== undefined) auth.comments = undefined;
      store.save(state);

      const second = await fetchCommit(deps, commented, first.commit);

      expect(second.changed).toBe(true);
      expect([...(await readTree(repo.git, second.commit)).keys()]).not.toContain(
        'Specs/Auth.comments.md',
      );
    });
  });

  it('reports what the source left out', async () => {
    reset();
    const skipped = { id: 'db', title: 'Tasks', path: 'Specs/Tasks', reason: 'database' };
    const plain = createFakeRegistry(store);
    deps.sources = {
      ...deps.sources,
      notion: {
        ...deps.sources.notion,
        fetchRoot: async (root, provider, previous) => ({
          ...(await plain.notion.fetchRoot(root, provider, previous)),
          skipped: [skipped],
        }),
      },
    };

    const { report } = await fetchCommit(deps, manifest, undefined);

    expect(report.skipped).toEqual([skipped]);
  });
});
