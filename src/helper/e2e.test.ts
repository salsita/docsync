/**
 * The helper end to end: real `git`, the built helper on PATH under the name
 * git discovers, the fake `Source` behind a JSON file. Each case starts from a
 * fresh temporary directory. `buildFakeHelper` compiles it once per run of
 * this file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildFakeHelper } from './fake-bin.mock.js';
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

let BIN = '';

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
  '    path: Specs/',
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
    PATH: `${BIN}${delimiter}${process.env.PATH ?? ''}`,
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
    const result = spawnSync('git', ['-c', 'pull.rebase=false', ...args], {
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

const frontmatter = (id: string, title: string, body: string): string =>
  `---\nid: notion:${id}\ntitle: ${title}\n---\n\n${body}`;

describe.skipIf(process.platform === 'win32')(
  'git-remote-docsync',
  () => {
    beforeAll(() => {
      BIN = buildFakeHelper('docsync-e2e');
    }, 120_000);

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
        'Specs/Auth.md',
        'Specs/Specs.md',
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
      w.write(co, 'Specs/Specs.md', frontmatter(NOTION_ROOT, 'Specs', 'Root, edited.\n'));
      w.commit(co, 'behind');

      const rejected = w.tryGit(co, 'push');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toMatch(/rejected.*non-fast-forward/);
      expect(w.store.load().objects[NOTION_ROOT]?.body).toBe('Root.\n');
    });

    it('9. a forced push is rejected', () => {
      const w = world();
      const co = w.clone();
      w.write(co, 'Specs/Specs.md', frontmatter(NOTION_ROOT, 'Specs', 'Root, edited.\n'));
      w.commit(co, 'edit');
      const rejected = w.tryGit(co, 'push', '--force');
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        '[remote rejected] main -> main (force push is not supported; fetch, merge and push again)',
      );
      expect(w.store.load().objects[NOTION_ROOT]?.body).toBe('Root.\n');
    });

    it('10. a root removed from the manifest disappears on pull and the source is untouched', () => {
      const w = world();
      const co = w.clone();
      writeFileSync(w.manifest, MANIFEST.split('\n').slice(0, 4).join('\n').concat('\n'));

      w.git(co, 'fetch', '--quiet');
      w.git(co, 'pull', '--quiet');
      expect(w.files(co)).toEqual(['.docsync/index.yaml', 'Specs/Auth.md', 'Specs/Specs.md']);
      expect(w.git(co, 'log', '-1', '--format=%s')).toBe('Update 3 documents');
      const after = w.store.load();
      expect(after.pushes).toEqual([]);
      expect(Object.values(after.objects).some((one) => one.trashed)).toBe(false);
    });

    it('11. a file outside every root, an edit to the index, an edit to a read-only export: each rejected by name', () => {
      const w = world();
      const co = w.clone();

      w.write(co, 'README.md', 'outside\n');
      w.commit(co, 'outside');
      expect(w.tryGit(co, 'push').stderr).toContain(
        '(README.md: not under any root in the manifest)',
      );
      w.git(co, 'reset', '--quiet', '--hard', 'origin/main');

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
          root: 'Specs/',
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
  },
  60_000,
);
