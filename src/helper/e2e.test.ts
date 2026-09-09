/**
 * The helper end to end: real `git`, the built helper on PATH under the name
 * git discovers, the fake `Source` behind a JSON file. Each case starts from a
 * fresh temporary directory. The helper is compiled once for the whole run by
 * vitest's global setup; `HELPER_BIN` is where it lands.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELPER_BIN } from './fake-bin.mock.js';
import {
  addObject,
  createFileStore,
  editObject,
  emptyState,
  type FakeState,
  type FakeStore,
  fakeId,
} from './fake-source.mock.js';
import { parseIndex } from './index-file.js';

const NOTION_ROOT = fakeId('notion', 1);
const AUTH = fakeId('notion', 2);
const DRIVE_ROOT = fakeId('gdocs', 1);
const LOGO = fakeId('gdocs', 2);
const RATES = fakeId('gdocs', 3);
const PLAN = fakeId('gdocs', 4);
const ADA = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };

const MANIFEST = [
  'version: 1',
  'roots:',
  `  - src: notion:${NOTION_ROOT}`,
  '    path: Specs.md',
  `  - src: gdocs:${DRIVE_ROOT}`,
  '    path: Files/',
  '',
].join('\n');

function seed(): FakeState {
  const state = emptyState();
  addObject(state, {
    id: NOTION_ROOT,
    source: 'notion',
    kind: 'page',
    title: 'Specs',
    body: 'Root.\n',
    editor: ADA,
  });
  addObject(state, { id: DRIVE_ROOT, source: 'gdocs', kind: 'folder', title: 'Files' });
  addObject(state, {
    id: LOGO,
    source: 'gdocs',
    kind: 'file',
    title: 'logo.png',
    parent: DRIVE_ROOT,
    bytes: Buffer.from('PNG').toString('base64'),
  });
  addObject(state, {
    id: RATES,
    source: 'gdocs',
    kind: 'export',
    title: 'Rates.xlsx',
    parent: DRIVE_ROOT,
    bytes: Buffer.from('XLSX').toString('base64'),
  });
  addObject(state, {
    id: PLAN,
    source: 'gdocs',
    kind: 'doc',
    title: 'Plan',
    parent: DRIVE_ROOT,
    body: 'The plan.\n',
    editor: ADA,
  });
  addObject(state, {
    id: AUTH,
    source: 'notion',
    kind: 'page',
    title: 'Auth',
    parent: NOTION_ROOT,
    body: 'Log in.\n',
    editor: ADA,
  });
  return state;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

interface World {
  dir: string;
  store: FakeStore;
  manifest: string;
  env: NodeJS.ProcessEnv;
  /** Runs git and answers stdout; throws with stderr on failure. */
  git(cwd: string, ...args: string[]): string;
  /** Runs git and answers everything, for a command expected to fail. */
  tryGit(cwd: string, ...args: string[]): Run;
  /** `git clone docsync::<manifest> checkout`, answering the checkout. */
  clone(): string;
  write(checkout: string, path: string, body: string): void;
  read(checkout: string, path: string): string;
  files(checkout: string): string[];
  index(checkout: string): ReturnType<typeof parseIndex>;
  commit(checkout: string, message: string): string;
}

const worlds: World[] = [];

function world(options: { signedIn?: string; manifest?: string; state?: FakeState } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'docsync-e2e-'));
  const storePath = join(dir, 'store.json');
  const store = createFileStore(storePath);
  store.save(options.state ?? seed());
  const manifest = join(dir, 'manifest.yaml');
  writeFileSync(manifest, options.manifest ?? MANIFEST);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${HELPER_BIN}${delimiter}${process.env.PATH ?? ''}`,
    DOCSYNC_FAKE_STORE: storePath,
    ...(options.signedIn === undefined ? {} : { DOCSYNC_FAKE_SIGNED_IN: options.signedIn }),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const tryGit = (cwd: string, ...args: string[]): Run => {
    // No `-c pull.rebase=…`: the checkout's own config carries it (MANUAL §10),
    // and a test that passed it would never see what a user sees.
    const result = spawnSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  };
  const git = (cwd: string, ...args: string[]): string => {
    const result = tryGit(cwd, ...args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
    return result.stdout.trimEnd();
  };
  const checkout = join(dir, 'checkout');

  const made: World = {
    dir,
    store,
    manifest,
    env,
    git,
    tryGit,
    clone: () => {
      git(dir, 'clone', '--quiet', `docsync::${manifest}`, 'checkout');
      return checkout;
    },
    write: (at, path, body) => {
      mkdirSync(dirname(join(at, path)), { recursive: true });
      writeFileSync(join(at, path), body);
    },
    read: (at, path) => readFileSync(join(at, path), 'utf8'),
    files: (at) =>
      git(at, 'ls-files')
        .split('\n')
        .filter((line) => line !== ''),
    index: (at) => parseIndex(readFileSync(join(at, '.docsync/index.yaml'), 'utf8')),
    commit: (at, message) => {
      git(at, 'add', '-A');
      git(at, 'commit', '--quiet', '-m', message);
      return git(at, 'rev-parse', 'HEAD');
    },
  };
  worlds.push(made);
  return made;
}

/** A Notion document as a fetch writes it, `url` and all (MANUAL §6). */
const frontmatter = (id: string, title: string, body: string): string =>
  `---\nid: notion:${id}\ntitle: ${title}\nurl: https://www.notion.so/${id}\n---\n\n${body}`;

describe.skipIf(process.platform === 'win32')(
  'git-remote-docsync',
  () => {
    afterEach(() => {
      for (const one of worlds.splice(0)) rmSync(one.dir, { recursive: true, force: true });
    });

    it('1. clone produces the files, the index and one commit with the source’s author and date', () => {
      const w = world();
      const co = w.clone();

      expect(w.files(co)).toEqual([
        '.docsync/index.yaml',
        'Files/Plan.md',
        'Files/Rates.xlsx',
        'Files/logo.png',
        'Specs.md',
        'Specs/Auth.md',
      ]);
      expect(w.read(co, 'Specs/Auth.md')).toBe(frontmatter(AUTH, 'Auth', 'Log in.\n'));
      expect(w.read(co, 'Files/logo.png')).toBe('PNG');
      expect(w.index(co).get('Files/Rates.xlsx')).toMatchObject({
        type: 'drive-file',
        readOnly: true,
      });
      expect(w.index(co).get('Files/Plan.md')?.type).toBe('gdoc');

      const auth = w.store.load().objects[AUTH]?.lastEditedTime ?? '';
      expect(w.git(co, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(w.git(co, 'log', '-1', '--format=%an|%ae|%at|%cn|%s')).toBe(
        `Ada Lovelace|ada@example.com|${Date.parse(auth) / 1000}|docsync|Add 5 documents`,
      );
      expect(w.git(co, 'rev-parse', 'refs/docsync/origin/main')).toBe(
        w.git(co, 'rev-parse', 'HEAD'),
      );
    });

    it('2. a second fetch with no change adds no commit', () => {
      const w = world();
      const co = w.clone();
      const before = w.git(co, 'rev-parse', 'origin/main');
      const run = w.tryGit(co, 'fetch');
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('notion: unchanged');
      expect(w.git(co, 'rev-parse', 'origin/main')).toBe(before);
    });

    it('3. an edit at the source becomes one commit touching that file only', () => {
      const w = world();
      const co = w.clone();
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Log in, then out.\n', editor: { id: 'bob' } });
      w.store.save(state);

      w.git(co, 'fetch');
      expect(w.git(co, 'rev-list', '--count', 'origin/main')).toBe('2');
      expect(
        w.git(co, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'origin/main').split('\n'),
      ).toEqual(['.docsync/index.yaml', 'Specs/Auth.md']);
      expect(w.git(co, 'log', '-1', '--format=%an <%ae>%n%s', 'origin/main')).toBe(
        'bob <bob@notion>\nUpdate 1 document',
      );
      w.git(co, 'pull', '--quiet');
      expect(w.read(co, 'Specs/Auth.md')).toBe(frontmatter(AUTH, 'Auth', 'Log in, then out.\n'));
    });

    it('4. a local edit pushed reaches the source, and git pull fast-forwards to the post-push commit', () => {
      const w = world();
      const co = w.clone();
      w.write(co, 'Specs/Auth.md', frontmatter(AUTH, 'Auth', 'Log in, then out.\n'));
      const pushed = w.commit(co, 'edit');

      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      expect(push.stderr).toContain('notion: updated Specs/Auth.md');
      expect(w.store.load().objects[AUTH]?.body).toBe('Log in, then out.\n');
      expect(w.git(co, 'rev-parse', 'origin/main')).toBe(pushed);

      const pull = w.tryGit(co, 'pull');
      expect(pull.status, pull.stderr).toBe(0);
      expect(pull.stdout).toContain('Fast-forward');
      expect(w.git(co, 'rev-parse', 'HEAD^')).toBe(pushed);
      expect(w.git(co, 'log', '-1', '--format=%an|%s')).toBe('Push Er|Update the index');
      expect(w.index(co).get('Specs/Auth.md')?.lastEditedTime).toBe(
        w.store.load().objects[AUTH]?.lastEditedTime,
      );
    });

    it('5. a new document is created at the source and comes back with its id in the file and the index', () => {
      const w = world();
      const co = w.clone();
      w.write(co, 'Specs/Onboarding.md', '---\n---\n\nWelcome.\n');
      w.write(co, 'Files/notes.txt', 'plain notes\n');
      w.commit(co, 'add');

      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      expect(push.stderr).toContain('notion: created Specs/Onboarding.md');
      expect(push.stderr).toContain('gdocs: created Files/notes.txt');
      w.git(co, 'pull', '--quiet');

      const created = Object.values(w.store.load().objects).find(
        (one) => one.title === 'Onboarding',
      );
      expect(created).toMatchObject({ kind: 'page', parent: NOTION_ROOT, body: 'Welcome.\n' });
      expect(w.read(co, 'Specs/Onboarding.md')).toBe(
        frontmatter(created?.id ?? '', 'Onboarding', 'Welcome.\n'),
      );
      expect(w.index(co).get('Specs/Onboarding.md')).toMatchObject({
        type: 'notion-page',
        src: { id: created?.id },
      });
      expect(w.index(co).get('Files/notes.txt')?.type).toBe('drive-file');
      expect(w.read(co, 'Files/notes.txt')).toBe('plain notes\n');
    });

    it('6. a deleted file is trashed at the source and gone from origin/main', () => {
      const w = world();
      const co = w.clone();
      rmSync(join(co, 'Files/logo.png'));
      w.commit(co, 'delete');

      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      expect(push.stderr).toContain('gdocs: trashed Files/logo.png');
      expect(w.store.load().objects[LOGO]?.trashed).toBe(true);
      w.git(co, 'pull', '--quiet');
      expect(w.files(co)).not.toContain('Files/logo.png');
      expect(w.index(co).has('Files/logo.png')).toBe(false);
    });

    it('7. a push after a concurrent edit at the source is rejected until a pull merges it', () => {
      const w = world();
      const co = w.clone();
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Changed at the source.\n' });
      w.store.save(state);
      w.write(
        co,
        'Files/Plan.md',
        `---\nid: gdocs:${PLAN}\ntitle: Plan\n---\n\nThe plan, revised.\n`,
      );
      w.commit(co, 'edit');

      const rejected = w.tryGit(co, 'push');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        '[remote rejected] main -> main (the source changed since the last fetch; fetch and merge first)',
      );
      expect(w.store.load().objects[PLAN]?.body).toBe('The plan.\n');

      const pull = w.tryGit(co, 'pull', '--no-edit');
      expect(pull.status, pull.stderr).toBe(0);
      expect(w.read(co, 'Specs/Auth.md')).toBe(
        frontmatter(AUTH, 'Auth', 'Changed at the source.\n'),
      );
      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      expect(w.store.load().objects[PLAN]?.body).toBe('The plan, revised.\n');
    });

    it('8. a non-fast-forward push is rejected', () => {
      const w = world();
      const co = w.clone();
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Moved on.\n' });
      w.store.save(state);
      w.git(co, 'fetch', '--quiet');
      w.write(co, 'Specs.md', frontmatter(NOTION_ROOT, 'Specs', 'Root, edited.\n'));
      w.commit(co, 'behind');

      const rejected = w.tryGit(co, 'push');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toMatch(/rejected.*non-fast-forward/);
      expect(w.store.load().objects[NOTION_ROOT]?.body).toBe('Root.\n');
    });

    it('9. a forced push is rejected', () => {
      const w = world();
      const co = w.clone();
      w.write(co, 'Specs.md', frontmatter(NOTION_ROOT, 'Specs', 'Root, edited.\n'));
      w.commit(co, 'edit');
      const rejected = w.tryGit(co, 'push', '--force');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        '[remote rejected] main -> main (force push is not supported; fetch, merge and push again)',
      );
      expect(w.store.load().objects[NOTION_ROOT]?.body).toBe('Root.\n');
    });

    it('10. a root removed from the manifest leaves its files behind, local, and the source is untouched', () => {
      const w = world();
      const co = w.clone();
      writeFileSync(w.manifest, MANIFEST.split('\n').slice(0, 4).join('\n').concat('\n'));

      w.git(co, 'fetch', '--quiet');
      w.git(co, 'pull', '--quiet');
      // Nothing claims `Files/` any more, so its files are local: they stay
      // until someone deletes them, which is what `docsync remove` does
      // (MANUAL §5, ticket 35). Only the index lost the three documents.
      expect(w.files(co)).toEqual([
        '.docsync/index.yaml',
        'Files/Plan.md',
        'Files/Rates.xlsx',
        'Files/logo.png',
        'Specs.md',
        'Specs/Auth.md',
      ]);
      expect(w.git(co, 'log', '-1', '--format=%s')).toBe('Update the index');
      expect([...w.index(co).keys()]).toEqual(['Specs.md', 'Specs/Auth.md']);
      const after = w.store.load();
      expect(after.pushes).toEqual([]);
      expect(Object.values(after.objects).some((one) => one.trashed)).toBe(false);
    });

    it('11. an edit to the index and an edit to a read-only export: each rejected by name', () => {
      const w = world();
      const co = w.clone();

      w.write(co, '.docsync/index.yaml', '[]\n');
      w.commit(co, 'index');
      expect(w.tryGit(co, 'push').stderr).toContain(
        '(.docsync/index.yaml: the index is written by fetch; do not edit it)',
      );
      w.git(co, 'reset', '--quiet', '--hard', 'origin/main');

      w.write(co, 'Files/Rates.xlsx', 'XLSX2');
      w.commit(co, 'export');
      expect(w.tryGit(co, 'push').stderr).toContain(
        '(Files/Rates.xlsx: a read-only export; edit it at the source)',
      );
      expect(w.store.load().pushes).toEqual([]);
    });

    it('12. a rename with an unchanged body reaches the adapter as one renamed change with previousPath', () => {
      const w = world();
      const co = w.clone();
      w.git(co, 'mv', 'Specs/Auth.md', 'Specs/Login.md');
      w.commit(co, 'rename');

      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      expect(w.store.load().pushes).toEqual([
        {
          root: 'Specs.md',
          changes: [{ kind: 'renamed', path: 'Specs/Login.md', previousPath: 'Specs/Auth.md' }],
        },
      ]);
      expect(w.store.load().objects[AUTH]?.title).toBe('Login');
      w.git(co, 'pull', '--quiet');
      expect(w.files(co)).toContain('Specs/Login.md');
      expect(w.read(co, 'Specs/Login.md')).toBe(frontmatter(AUTH, 'Login', 'Log in.\n'));
    });

    it('13. the frontmatter rules for new files, on each side', () => {
      const w = world();
      const co = w.clone();

      // A plain .md under Drive is a file.
      w.write(co, 'Files/notes.md', 'just notes\n');
      w.commit(co, 'plain on drive');
      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      w.git(co, 'pull', '--quiet');
      const notes = Object.values(w.store.load().objects).find((one) => one.title === 'notes.md');
      expect(notes).toMatchObject({
        kind: 'file',
        bytes: Buffer.from('just notes\n').toString('base64'),
      });
      expect(w.index(co).get('Files/notes.md')?.type).toBe('drive-file');
      expect(w.read(co, 'Files/notes.md')).toBe('just notes\n');

      // The same under Notion is refused.
      w.write(co, 'Specs/Plain.md', 'just notes\n');
      w.commit(co, 'plain on notion');
      expect(w.tryGit(co, 'push').stderr).toContain(
        '(Specs/Plain.md: a new file under a Notion root must start with frontmatter (a --- line, then another) to become a page)',
      );
      w.git(co, 'reset', '--quiet', '--hard', 'origin/main');

      // A copy of a fetched document is refused.
      w.write(co, 'Specs/Auth copy.md', w.read(co, 'Specs/Auth.md'));
      w.commit(co, 'copy');
      expect(w.tryGit(co, 'push').stderr).toContain(
        `(Specs/Auth copy.md: its id notion:${AUTH} is already checked out as Specs/Auth.md; remove the id line to create a copy)`,
      );
      w.git(co, 'reset', '--quiet', '--hard', 'origin/main');

      // Frontmatter added to the plain file: the file is trashed, a Doc is made.
      w.write(co, 'Files/notes.md', '---\ntitle: Notes\n---\n\njust notes\n');
      w.commit(co, 'frontmatter added');
      const again = w.tryGit(co, 'push');
      expect(again.status, again.stderr).toBe(0);
      expect(again.stderr).toContain('gdocs: trashed Files/notes.md');
      expect(again.stderr).toContain('gdocs: created Files/notes.md');
      w.git(co, 'pull', '--quiet');
      expect(w.store.load().objects[notes?.id ?? '']?.trashed).toBe(true);
      const doc = Object.values(w.store.load().objects).find((one) => one.title === 'Notes');
      expect(doc).toMatchObject({ kind: 'doc', body: 'just notes\n' });
      expect(w.index(co).get('Files/Notes.md')?.type).toBe('gdoc');
      expect(w.files(co)).not.toContain('Files/notes.md');
    });

    it('14. a missing credential ends the run with the command to run', () => {
      const w = world({ signedIn: 'gdocs' });
      const clone = w.tryGit(w.dir, 'clone', `docsync::${w.manifest}`, 'checkout');
      expect(clone.status).not.toBe(0);
      expect(clone.stderr).toContain('docsync: Not signed in to Notion. Run: docsync auth notion');
      expect(existsSync(join(w.dir, 'checkout', '.git'))).toBe(false);
    });

    it('15. a manifest that is missing or wrong is named with its line', () => {
      const w = world({ manifest: 'version: 1\nroots:\n  - src: nonsense\n    path: Specs/\n' });
      const clone = w.tryGit(w.dir, 'clone', `docsync::${w.manifest}`, 'checkout');
      expect(clone.status).not.toBe(0);
      expect(clone.stderr).toContain(`docsync: ${w.manifest}:3: `);

      const gone = w.tryGit(w.dir, 'clone', 'docsync::nowhere.yaml', 'checkout2');
      expect(gone.status).not.toBe(0);
      expect(gone.stderr).toContain('nowhere.yaml: no such file');
    });

    it('16. the helper exits quietly when git stops reading its replies', async () => {
      const w = world();
      w.git(w.dir, 'init', '--quiet', 'reader');
      const helper = spawn(
        join(HELPER_BIN, 'git-remote-docsync'),
        ['origin', `docsync::${w.manifest}`],
        {
          cwd: join(w.dir, 'reader'),
          env: { ...w.env, GIT_DIR: join(w.dir, 'reader', '.git') },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      helper.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // git dies, or stops caring, before the reply lands: the read end of the
      // helper's stdout is gone while the helper still has lines to write.
      helper.stdout.destroy();
      helper.stdin.on('error', () => {});
      helper.stdin.end('capabilities\nlist\n\n');

      const code = await new Promise<number | null>((done) => helper.on('close', done));

      // A closed pipe is git's way of saying it is done, not a crash: no
      // unhandled 'error', no stack, and nothing for git to report as 128.
      expect(stderr).not.toContain('EPIPE');
      expect(stderr).not.toContain('Unhandled');
      expect(code).toBe(0);
    });
    it('17. a file under no root is pushed with no request, kept by every fetch, and deleted when you delete it', () => {
      const w = world();
      const co = w.clone();

      w.write(co, 'notes/a.md', 'hi\n');
      const pushed = w.commit(co, 'notes');
      const push = w.tryGit(co, 'push');
      expect(push.status, push.stderr).toBe(0);
      // Nothing was sent anywhere: the commit is the whole of what happened.
      expect(w.store.load().pushes).toEqual([]);
      expect(w.git(co, 'ls-tree', '--name-only', '-r', 'origin/main')).toContain('notes/a.md');
      expect(w.git(co, 'rev-parse', 'origin/main')).toBe(pushed);

      // The source moves, and the local file is still there afterwards.
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Log in, then out.\n' });
      w.store.save(state);
      w.git(co, 'pull', '--quiet');
      expect(w.read(co, 'notes/a.md')).toBe('hi\n');
      expect(w.index(co).has('notes/a.md')).toBe(false);

      // Moving it into a root creates the page; moving it out trashes it.
      w.write(co, 'notes/Draft.md', '---\ntitle: Draft\n---\n\nA draft.\n');
      w.commit(co, 'draft');
      expect(w.tryGit(co, 'push').status).toBe(0);
      w.git(co, 'mv', 'notes/Draft.md', 'Specs/Draft.md');
      w.commit(co, 'into the root');
      const created = w.tryGit(co, 'push');
      expect(created.status, created.stderr).toBe(0);
      expect(created.stderr).toContain('notion: created Specs/Draft.md');
      const draft = Object.values(w.store.load().objects).find((one) => one.title === 'Draft');
      expect(draft).toMatchObject({ kind: 'page', parent: NOTION_ROOT, body: 'A draft.\n' });
      w.git(co, 'pull', '--quiet');

      w.git(co, 'mv', 'Specs/Draft.md', 'notes/Draft.md');
      w.commit(co, 'out of the root');
      const trashed = w.tryGit(co, 'push');
      expect(trashed.status, trashed.stderr).toBe(0);
      expect(trashed.stderr).toContain('notion: trashed Specs/Draft.md');
      expect(w.store.load().objects[draft?.id ?? '']?.trashed).toBe(true);
      w.git(co, 'pull', '--quiet');
      expect(w.files(co)).toContain('notes/Draft.md');

      // Deleting a local file deletes it from `main`, and nothing else.
      rmSync(join(co, 'notes/a.md'));
      w.commit(co, 'drop the notes');
      expect(w.tryGit(co, 'push').status).toBe(0);
      w.git(co, 'pull', '--quiet');
      expect(w.files(co)).not.toContain('notes/a.md');
    });

    it('18. a clone carries pull.rebase=true, and a plain pull rebases a local commit onto the source', () => {
      const w = world();
      const co = w.clone();
      // The refresh runs during the clone itself, so a checkout has it before
      // any docsync command was ever run in it (MANUAL §10).
      expect(w.git(co, 'config', '--local', '--get', 'pull.rebase')).toBe('true');

      w.write(co, 'Specs/Auth.md', frontmatter(AUTH, 'Auth', 'Log in, then out.\n'));
      w.commit(co, 'edit');
      const state = w.store.load();
      editObject(state, NOTION_ROOT, { body: 'Root, moved on.\n' });
      w.store.save(state);

      // Plain `git pull`: the one git refuses to guess about when the branches
      // have diverged and nothing says how to reconcile them.
      const pull = w.tryGit(co, 'pull');
      expect(pull.status, pull.stderr).toBe(0);
      expect(`${pull.stdout}${pull.stderr}`).not.toContain('divergent branches');

      expect(w.read(co, 'Specs.md')).toBe(frontmatter(NOTION_ROOT, 'Specs', 'Root, moved on.\n'));
      expect(w.read(co, 'Specs/Auth.md')).toBe(frontmatter(AUTH, 'Auth', 'Log in, then out.\n'));
      // One commit ahead of what the source produced, and a straight line.
      expect(w.git(co, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1');
      expect(w.git(co, 'rev-parse', 'HEAD^')).toBe(w.git(co, 'rev-parse', 'origin/main'));
      expect(w.git(co, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
    });
  },
  60_000,
);
