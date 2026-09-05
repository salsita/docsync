/**
 * Every command, end to end: `runCli` in process over real `git`, the fake
 * helper on PATH, and the fake `Source` behind one JSON file. Nothing about
 * the wiring is simulated — a `docsync push` here really spawns git, which
 * really runs the helper, which really applies the changes to the store.
 */
process.env.TZ = 'UTC';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addObject,
  editObject,
  emptyState,
  type FakeState,
  fakeId,
  rewriteObject,
} from '../helper/fake-source.mock.js';
import { createWorld, type World } from './harness.mock.js';

const SPECS = fakeId('notion', 1);
const AUTH = fakeId('notion', 2);
const LEAF = fakeId('notion', 3);
const CONTRACTS = fakeId('gdocs', 1);
const TERMS = fakeId('gdocs', 2);
const LOGO = fakeId('gdocs', 3);
const ROADMAP = fakeId('gdocs', 4);
const INPUTS = fakeId('gdocs', 5);
const BRIEF = fakeId('gdocs', 6);
const ADA = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };

function seed(): FakeState {
  const state = emptyState();
  addObject(state, {
    id: SPECS,
    source: 'notion',
    kind: 'page',
    title: 'Product Specs',
    body: 'The specs.\n',
    editor: ADA,
  });
  addObject(state, {
    id: AUTH,
    source: 'notion',
    kind: 'page',
    title: 'Auth',
    parent: SPECS,
    body: 'Log in.\n',
    editor: ADA,
    // Only a root with `comments: true` ever sees this (MANUAL §4).
    comments: '## AAACFLfYEtk — comment\n\nAda: Is this still true?\n',
  });
  addObject(state, {
    id: LEAF,
    source: 'notion',
    kind: 'page',
    title: 'Leaf',
    body: 'Nothing under me.\n',
    editor: ADA,
  });
  addObject(state, { id: CONTRACTS, source: 'gdocs', kind: 'folder', title: 'Contracts' });
  addObject(state, {
    id: TERMS,
    source: 'gdocs',
    kind: 'doc',
    title: 'Terms',
    parent: CONTRACTS,
    body: 'The terms.\n',
    editor: ADA,
  });
  addObject(state, {
    id: LOGO,
    source: 'gdocs',
    kind: 'file',
    title: 'logo.png',
    parent: CONTRACTS,
    bytes: Buffer.from('PNG').toString('base64'),
  });
  addObject(state, {
    id: ROADMAP,
    source: 'gdocs',
    kind: 'doc',
    title: 'Roadmap',
    body: 'Later.\n',
    editor: ADA,
  });
  // The client's own folder: pulled for context, never pushed to (ticket 25).
  addObject(state, { id: INPUTS, source: 'gdocs', kind: 'folder', title: 'Inputs' });
  addObject(state, {
    id: BRIEF,
    source: 'gdocs',
    kind: 'doc',
    title: 'Brief',
    parent: INPUTS,
    body: 'What they want.\n',
    editor: ADA,
  });
  return state;
}

const worlds: World[] = [];

function world(state: FakeState = seed()): World {
  const made = createWorld(state);
  worlds.push(made);
  return made;
}

/** A checkout with the two roots of the quick start, and where it is. */
async function checkout(w: World, ...refs: string[]): Promise<string> {
  const run = await w.run(w.dir, 'init', 'my-docs', ...refs);
  expect(run.code).toBe(0);
  return join(w.dir, 'my-docs');
}

describe.skipIf(process.platform === 'win32')(
  'the docsync commands',
  () => {
    afterEach(() => {
      for (const one of worlds.splice(0)) one.remove();
    });

    it('init builds the checkout of the quick start', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`, `gdocs:${CONTRACTS}`);

      // The listing of MANUAL §3: the page is a file, its children sit in the
      // sibling directory, and the Drive folder is a directory.
      expect(w.files(co)).toEqual([
        '.docsync/index.yaml',
        'Contracts/Terms.md',
        'Contracts/logo.png',
        'Product Specs.md',
        'Product Specs/Auth.md',
      ]);
      expect(w.read(co, 'Product Specs/Auth.md')).toContain('Log in.');
      // The manifest, the formatter files and the skill files belong to the
      // checkout and not to the documents (MANUAL §5 step 4, §6, §10).
      expect(w.read(co, '.docsync.yaml')).toContain(`src: notion:${SPECS}`);
      expect(w.read(co, '.prettierrc')).toBe('{\n  "proseWrap": "preserve"\n}\n');
      expect(w.read(co, '.editorconfig')).toContain('trim_trailing_whitespace = false');
      expect(w.read(co, '.gitattributes')).toBe('*.assets/** binary\n');
      expect(readFileSync(join(co, '.git/info/exclude'), 'utf8')).toContain('.prettierrc');
      expect(readFileSync(join(co, '.git/info/exclude'), 'utf8')).toContain('.gitattributes');
      expect(readFileSync(join(co, '.git/info/exclude'), 'utf8')).toContain('.DS_Store');
      expect(readFileSync(join(co, '.git/info/exclude'), 'utf8')).toContain('.gitignore');
      expect(w.git(co, 'status', '--porcelain')).toBe('');

      expect(w.git(co, 'remote', 'get-url', 'origin')).toBe('docsync::.docsync.yaml');
      expect(w.git(co, 'config', 'core.autocrlf')).toBe('false');
      expect(w.git(co, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(w.git(co, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
    });

    it('init with no sources leaves a repo with one commit and no documents', async () => {
      const w = world();
      const co = await checkout(w);

      expect(w.files(co)).toEqual(['.docsync/index.yaml']);
      expect(w.git(co, 'rev-list', '--count', 'HEAD')).toBe('1');
    });

    it('init refuses a directory that is not empty, and accepts an empty repo', async () => {
      const w = world();
      mkdirSync(join(w.dir, 'taken'));
      writeFileSync(join(w.dir, 'taken', 'notes.txt'), 'mine\n');

      const refused = await w.run(w.dir, 'init', 'taken');
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('is not empty');
      expect(existsSync(join(w.dir, 'taken', '.docsync.yaml'))).toBe(false);

      mkdirSync(join(w.dir, 'fresh'));
      w.git(w.dir, 'init', '--quiet', join(w.dir, 'fresh'));
      expect((await w.run(w.dir, 'init', 'fresh')).code).toBe(0);
    });

    it('init resolves every ref before it builds anything', async () => {
      const w = world();

      const run = await w.run(w.dir, 'init', 'my-docs', 'notion:0'.padEnd(39, '0'));

      expect(run.code).toBe(1);
      expect(existsSync(join(w.dir, 'my-docs'))).toBe(false);
    });

    it('add takes every alias form of the manual', async () => {
      const w = world();
      const co = await checkout(w);

      const added = await w.run(
        co,
        'add',
        '--no-fetch',
        `notion:${LEAF}`,
        `gdocs:${ROADMAP}=notes/`,
        `notion:${SPECS}=specs/product.md`,
        `gdocs:${CONTRACTS}=filed/`,
      );

      expect(added.code).toBe(0);
      expect(w.read(co, '.docsync.yaml')).toContain('path: Leaf.md');
      expect(w.read(co, '.docsync.yaml')).toContain('path: notes/Roadmap.md');
      expect(w.read(co, '.docsync.yaml')).toContain('path: specs/product.md');
      expect(w.read(co, '.docsync.yaml')).toContain('path: filed/');
      // `--no-fetch` stops at the manifest (ticket 10).
      expect(w.files(co)).toEqual(['.docsync/index.yaml']);
    });

    it('add names a leaf that was given a path with no extension', async () => {
      const w = world();
      const co = await checkout(w);

      const run = await w.run(co, 'add', '--no-fetch', `notion:${LEAF}=specs/leaf`);

      expect(run.code).toBe(1);
      expect(run.err).toContain('needs an extension');
    });

    it('add refuses a Drive folder that was given a file name', async () => {
      const w = world();
      const co = await checkout(w);

      const run = await w.run(co, 'add', '--no-fetch', `gdocs:${CONTRACTS}=filed/terms.md`);

      expect(run.code).toBe(1);
      expect(run.err).toContain('a folder cannot be a file');
    });

    it('add gives a page with children a file of its own, children beside it', async () => {
      const w = world();
      const co = await checkout(w);

      const run = await w.run(co, 'add', '--no-fetch', `notion:${SPECS}`);

      expect(run.code).toBe(0);
      expect(run.out).toContain('Added Product Specs.md');
      expect(w.read(co, '.docsync.yaml')).toContain('path: Product Specs.md');
    });

    it('add fetches and fast-forwards when the tree is clean', async () => {
      const w = world();
      const co = await checkout(w);

      const run = await w.run(co, 'add', `notion:${SPECS}`);

      expect(run.code).toBe(0);
      expect(run.out).toContain('Added Product Specs.md');
      expect(w.files(co)).toEqual([
        '.docsync/index.yaml',
        'Product Specs.md',
        'Product Specs/Auth.md',
      ]);
      expect(run.out).toContain('Product Specs/Auth.md');
      expect(run.out).toContain('by Ada Lovelace');
    });

    it('remove commits the deletion, and the next push leaves the source alone', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);

      const removed = await w.run(co, 'remove', 'Product Specs.md');
      expect(removed.code).toBe(0);
      expect(w.files(co)).toEqual(['.docsync/index.yaml']);
      expect(w.git(co, 'log', '-1', '--format=%s')).toBe('Remove Product Specs.md');
      expect(w.read(co, '.docsync.yaml')).not.toContain(SPECS);

      // The removal reaches the remote as an unsubscribe: nothing is trashed.
      expect((await w.run(co, 'pull')).code).toBe(0);
      const pushed = await w.run(co, 'push');
      expect(pushed.code).toBe(0);
      expect(w.store.load().pushes).toEqual([]);
      expect(w.store.load().objects[AUTH]?.trashed).toBeUndefined();
    });

    it('remove says which root it does not have', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);

      const run = await w.run(co, 'remove', 'Nowhere/');

      expect(run.code).toBe(1);
      expect(run.err).toContain('no root at Nowhere/');
    });

    it('status prints git’s own status and then one line per root', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`, `gdocs:${CONTRACTS}`);

      const quiet = await w.run(co, 'status');
      expect(quiet.all).toContain('## main...origin/main');
      expect(quiet.out).toContain(`notion:${SPECS.slice(0, 4)}…  Product Specs.md  fetched 20`);
      expect(quiet.out).toContain('up to date');

      const state = w.store.load();
      editObject(state, AUTH, { body: 'Log in twice.\n' });
      w.store.save(state);

      const moved = await w.run(co, 'status');
      expect(moved.out).toContain('1 changed at source');
      expect(moved.out).toContain('Contracts/  fetched 20');
    });

    it('add --readonly marks the root, status says so, and fetch still fills it', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);

      const added = await w.run(co, 'add', '--readonly', `gdocs:${INPUTS}`);

      expect(added.code).toBe(0);
      expect(w.read(co, '.docsync.yaml')).toContain('readonly: true');
      // Read-only is about push only: the fetch is the fetch it always was.
      expect(w.read(co, 'Inputs/Brief.md')).toContain('What they want.');

      const shown = await w.run(co, 'status');
      expect(shown.out).toContain('Inputs/');
      const line = shown.out.split('\n').find((one) => one.includes('Inputs/')) ?? '';
      expect(line.endsWith('read-only')).toBe(true);
      // Only the root that asked for it says so.
      expect(shown.out.split('\n').filter((one) => one.includes('read-only'))).toHaveLength(1);
    });

    it('push refuses a change under a read-only root and pushes the sibling root', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      expect((await w.run(co, 'add', '--readonly', `gdocs:${INPUTS}`)).code).toBe(0);

      w.write(co, 'Inputs/Brief.md', `${w.read(co, 'Inputs/Brief.md')}Mine now.\n`);
      w.git(co, 'commit', '--quiet', '-a', '-m', 'Edit the client folder');

      const refused = await w.run(co, 'push');

      expect(refused.code).not.toBe(0);
      expect(refused.all).toContain('Inputs/Brief.md is under a read-only root (Inputs/)');
      expect(refused.all).toContain('git checkout -- Inputs/Brief.md');
      expect(w.store.load().objects[BRIEF]?.body).not.toContain('Mine now.');

      // The other root is untouched by the rule, and pushes.
      w.git(co, 'reset', '--quiet', '--hard', 'origin/main');
      w.write(co, 'Product Specs/Auth.md', `${w.read(co, 'Product Specs/Auth.md')}And out.\n`);
      w.git(co, 'commit', '--quiet', '-a', '-m', 'Edit the spec');

      const pushed = await w.run(co, 'push');

      expect(pushed.code).toBe(0);
      expect(w.store.load().objects[AUTH]?.body).toContain('And out.');
    });

    it('status previews the push: the verbs, the refusals and the uncommitted note', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`, `gdocs:${CONTRACTS}`);
      expect((await w.run(co, 'add', '--readonly', `gdocs:${INPUTS}`)).code).toBe(0);
      // Sidecars have no flag of their own: the manifest is where they go on.
      w.write(
        co,
        '.docsync.yaml',
        w
          .read(co, '.docsync.yaml')
          .replace('path: Product Specs.md\n', 'path: Product Specs.md\n    comments: true\n'),
      );
      expect((await w.run(co, 'pull')).code).toBe(0);

      // On the served commit there is nothing to preview, and no line saying so.
      expect((await w.run(co, 'status')).out).not.toContain('To push:');

      w.write(co, 'Product Specs/Auth.md', `${w.read(co, 'Product Specs/Auth.md')}And out.\n`);
      w.write(co, 'Contracts/New.md', '---\ntitle: New\n---\n\nBody.\n');
      w.git(co, 'add', '--', 'Contracts/New.md');
      w.git(co, 'mv', 'Contracts/Terms.md', 'Contracts/Conditions.md');
      w.git(co, 'rm', '--quiet', 'Contracts/logo.png');
      w.write(co, 'Product Specs/Auth.comments.md', 'my answer\n');
      w.write(co, 'Inputs/Brief.md', 'mine now\n');
      w.git(co, 'commit', '--quiet', '-a', '-m', 'Everything at once');
      // An edit nobody committed is not in the list, only counted at the end.
      w.write(co, 'Product Specs.md', `${w.read(co, 'Product Specs.md')}Later.\n`);

      const shown = await w.run(co, 'status');
      const lines = shown.out.split('\n').map((one) => one.trim().replace(/\s+/g, ' '));

      expect(shown.out).toContain('To push:');
      expect(lines).toContain('update Product Specs/Auth.md');
      expect(lines).toContain('create Contracts/New.md');
      expect(lines).toContain('rename Contracts/Terms.md -> Contracts/Conditions.md');
      expect(lines).toContain('trash Contracts/logo.png');
      expect(lines).toContain(
        'refused Product Specs/Auth.comments.md: read-only; comments are only pulled in this version',
      );
      expect(lines).toContain('refused Inputs/Brief.md: under read-only root Inputs/');
      expect(lines).toContain('(1 uncommitted change is not pushed)');
      // The preview is local: nothing was pushed to see it.
      expect(w.store.load().pushes).toEqual([]);
    });

    it('fetch prints what changed at the source and who changed it', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Log in twice.\n', editor: ADA });
      w.store.save(state);

      const run = await w.run(co, 'fetch');

      expect(run.code).toBe(0);
      expect(run.out).toMatch(/Product Specs\/Auth\.md {2}by Ada Lovelace {2}\d{4}-/);
      // A fetch never touches the working tree (MANUAL §7).
      expect(w.read(co, 'Product Specs/Auth.md')).toContain('Log in.');
    });

    it('fetch says so when nothing moved', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);

      expect((await w.run(co, 'fetch')).out).toContain('No documents changed at the source.');
    });

    it('pull prints the same report and updates the working tree', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Log in twice.\n', editor: ADA });
      w.store.save(state);

      const run = await w.run(co, 'pull');

      expect(run.code).toBe(0);
      expect(run.out).toContain('Product Specs/Auth.md  by Ada Lovelace');
      expect(w.read(co, 'Product Specs/Auth.md')).toContain('Log in twice.');
    });

    it('pull --all re-renders a document the source never touched', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      // A converter fix: the same page comes out differently, and nothing at
      // the source moved (MANUAL §7).
      const state = w.store.load();
      rewriteObject(state, AUTH, { body: 'Log in **first**.\n' });
      w.store.save(state);

      // The variable is set for the one git run that asks for it, so a plain
      // pull is the fetch it always was.
      const plain = await w.run(co, 'pull');
      expect(plain.out).toContain('No documents changed at the source.');
      expect(w.read(co, 'Product Specs/Auth.md')).toContain('Log in.');

      const run = await w.run(co, 'pull', '--all');

      expect(run.code).toBe(0);
      expect(run.out).toContain('Product Specs/Auth.md');
      expect(run.out).toContain('(re-rendered)');
      expect(w.read(co, 'Product Specs/Auth.md')).toContain('Log in **first**.');
      // Nobody edited anything, so the commit is docsync's own (MANUAL §7).
      expect(w.git(co, 'log', '-1', '--format=%an <%ae>', 'origin/main')).toBe(
        'docsync <docsync@salsita.com>',
      );
    });

    it('fetch --all commits nothing when every document comes out as it is', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      const before = w.git(co, 'rev-parse', 'origin/main');

      const run = await w.run(co, 'fetch', '--all');

      expect(run.code).toBe(0);
      expect(run.out).toContain('No documents changed at the source.');
      expect(w.git(co, 'rev-parse', 'origin/main')).toBe(before);
      // Every document was downloaded, so every one was counted (ticket 24).
      expect(run.err).toContain('1 Product Specs.md');
      expect(run.err).toContain('2 Product Specs/Auth.md');
    });

    it('names --all in the help of fetch and pull', async () => {
      const w = world();

      expect((await w.run(w.dir, 'fetch', '--help')).out).toContain('--all');
      expect((await w.run(w.dir, 'pull', '--help')).out).toContain('--all');
      expect((await w.run(w.dir, '--help')).out).toContain('docsync fetch   [--all]');
    });

    it('pull relays the progress the helper printed while it ran', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      const state = w.store.load();
      editObject(state, AUTH, { body: 'Log in twice.\n', editor: ADA });
      w.store.save(state);

      const run = await w.run(co, 'pull');

      // git relays the helper's stderr as the fetch runs; the report is
      // printed on stdout only once git has returned (MANUAL §5, §7).
      expect(run.err).toContain('listing Product Specs.md');
      expect(run.err).toContain('1 Product Specs/Auth.md');
      expect(run.out).toContain('Product Specs/Auth.md  by Ada Lovelace');
      // Progress is transient: it is not in the report file.
      expect(readFileSync(join(co, '.git/docsync/last-fetch.json'), 'utf8')).not.toContain(
        'listing',
      );
    });

    it('push prints what it did, with the trashed documents last', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`, `gdocs:${CONTRACTS}`);
      w.write(co, 'Product Specs/Auth.md', w.read(co, 'Product Specs/Auth.md') + 'And out.\n');
      w.git(co, 'rm', '--quiet', 'Contracts/logo.png');
      w.git(co, 'commit', '--quiet', '-a', '-m', 'Edit one, drop one');

      const run = await w.run(co, 'push');

      expect(run.code).toBe(0);
      // The trashed document comes last, under its own heading (MANUAL §8).
      expect(run.out).toContain('updated  Product Specs/Auth.md');
      expect(run.out).toContain('Trashed:\n  Contracts/logo.png');
      expect(run.out.indexOf('Trashed:')).toBeGreaterThan(run.out.indexOf('updated  '));
      expect(w.store.load().objects[AUTH]?.body).toContain('And out.');
      expect(w.store.load().objects[LOGO]?.trashed).toBe(true);
      // The follow-up commit of §7 was merged, so nothing is left behind.
      expect(w.git(co, 'status', '--porcelain')).toBe('');
      expect(w.git(co, 'rev-parse', 'HEAD')).toBe(w.git(co, 'rev-parse', 'origin/main'));
    });

    it('add fast-forwards around an edit in progress elsewhere', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      w.write(co, 'Product Specs/Auth.md', 'still editing\n');
      w.write(co, 'notes.txt', 'untracked\n');

      const run = await w.run(co, 'add', `gdocs:${CONTRACTS}`);

      expect(run.code).toBe(0);
      expect(run.out).not.toContain('Nothing was merged');
      expect(w.git(co, 'rev-parse', 'HEAD')).toBe(w.git(co, 'rev-parse', 'origin/main'));
      // The edit in progress is untouched, and the new root is in place.
      expect(w.read(co, 'Product Specs/Auth.md')).toBe('still editing\n');
      expect(w.files(co)).toContain('.docsync/index.yaml');
    });

    it('push fast-forwards onto the follow-up commit around an edit in progress', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      w.write(co, 'Product Specs/Auth.md', w.read(co, 'Product Specs/Auth.md') + 'And out.\n');
      w.git(co, 'commit', '--quiet', '-a', '-m', 'Edit');
      w.write(co, 'Product Specs/Auth.md', 'still editing\n');

      const run = await w.run(co, 'push');

      expect(run.code).toBe(0);
      // The follow-up commit touches the index, not the file being edited, so
      // git fast-forwards and the edit in progress is still there.
      expect(run.out).not.toContain('Nothing was merged');
      expect(w.git(co, 'rev-parse', 'HEAD')).toBe(w.git(co, 'rev-parse', 'origin/main'));
      expect(w.read(co, 'Product Specs/Auth.md')).toBe('still editing\n');
    });

    it('add says why when what came in would overwrite a file of yours', async () => {
      const w = world();
      const co = await checkout(w);
      w.write(co, 'Product Specs/Auth.md', 'mine\n');

      const run = await w.run(co, 'add', `notion:${SPECS}`);

      expect(run.code).toBe(0);
      expect(run.out).toContain('Nothing was merged:');
      expect(run.out).toContain('Product Specs/Auth.md');
      expect(run.out).toContain('docsync pull');
      expect(w.read(co, 'Product Specs/Auth.md')).toBe('mine\n');
      expect(w.git(co, 'rev-parse', 'HEAD')).not.toBe(w.git(co, 'rev-parse', 'origin/main'));
    });

    it('push says so when the commits carried no document change', async () => {
      const w = world();
      const co = await checkout(w, `notion:${SPECS}`);
      w.git(co, 'commit', '--quiet', '--allow-empty', '-m', 'Nothing');

      const run = await w.run(co, 'push');

      expect(run.code).toBe(0);
      expect(run.out).toContain('No documents changed at the source.');
    });

    it('resolve prints what a ref is, without a checkout in sight', async () => {
      const w = world();

      const run = await w.run(w.dir, 'resolve', `notion:${SPECS}`);

      expect(run.code).toBe(0);
      expect(run.out.split('\n').slice(0, 4)).toEqual([
        `ref       notion:${SPECS}`,
        'type      document',
        'title     Product Specs',
        'children  1',
      ]);
      expect(run.out).toContain('editor    Ada Lovelace <ada@example.com>');
    });

    it('a command outside a checkout says what to do', async () => {
      const w = world();

      const run = await w.run(w.dir, 'status');

      expect(run.code).toBe(1);
      expect(run.err).toContain('docsync init');
    });

    it('auth signs in, reports the identity, and signs out', async () => {
      const w = world();

      expect((await w.run(w.dir, 'auth', 'notion')).out).toBe(
        'Signed in as Ada Lovelace, ada@example.com.\n',
      );
      expect((await w.run(w.dir, 'auth', 'notion')).out).toBe(
        'Already signed in as Ada Lovelace, ada@example.com.\nTo sign in again, run `docsync auth notion --logout` first.\n',
      );
      expect((await w.run(w.dir, 'auth', 'notion', '--logout')).out).toBe(
        'Signed out of notion.\n',
      );
      expect(w.auth.calls).toEqual([
        'whoAmI notion',
        'signIn notion',
        'whoAmI notion',
        'signOut notion',
      ]);
    });

    it('runs the quick start of MANUAL §3 as it is written', async () => {
      const w = world();

      // docsync init my-docs notion:2f3a9c… gdocs:1AbCdE…
      const init = await w.run(w.dir, 'init', 'my-docs', `notion:${SPECS}`, `gdocs:${CONTRACTS}`);
      expect(init.code).toBe(0);
      const co = join(w.dir, 'my-docs');

      // cd my-docs; ls
      expect(w.files(co)).toContain('Product Specs/Auth.md');
      expect(w.files(co)).toContain('Contracts/Terms.md');

      // $EDITOR "Product Specs/Auth.md"
      w.write(
        co,
        'Product Specs/Auth.md',
        w.read(co, 'Product Specs/Auth.md') + '\nSession expiry is 30 days.\n',
      );
      // git diff
      expect(w.git(co, 'diff', '--name-only')).toBe('Product Specs/Auth.md');
      // git commit -am "Clarify session expiry"
      w.git(co, 'commit', '-a', '--quiet', '-m', 'Clarify session expiry');
      // git push
      w.git(co, 'push', '--quiet');
      // git pull
      w.git(co, 'pull', '--quiet');

      expect(w.store.load().objects[AUTH]?.body).toContain('Session expiry is 30 days.');
      expect(w.git(co, 'status', '--porcelain')).toBe('');
      expect(w.git(co, 'rev-parse', 'HEAD')).toBe(w.git(co, 'rev-parse', 'origin/main'));
    });
  },
  120_000,
);
