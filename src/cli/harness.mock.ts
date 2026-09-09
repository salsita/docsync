/**
 * A world for the command tests: a temporary directory, real `git`, the fake
 * helper on PATH, and the fake `Source` behind one JSON file.
 *
 * A command is run in process — `runCli` over a `Context` — while everything
 * it shells out to is real: the git it spawns discovers `git-remote-docsync`
 * on the PATH this sets up, and that helper reads and writes the same fake
 * store the CLI's own registry does. So a test asserts on printed output and
 * on what reached the source, and nothing about the wiring is simulated.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createFakeCredentialProvider } from '../auth/provider.js';
import type { Identity } from '../auth/types.js';
import { HELPER_BIN } from '../helper/fake-bin.mock.js';
import {
  createFakeRegistry,
  createFileStore,
  type FakeState,
  type FakeStore,
} from '../helper/fake-source.mock.js';
import type { AuthOps, Context } from './context.js';
import { createContext } from './context.js';
import { runCli } from './program.js';

/** What one `docsync` invocation printed and answered. */
export interface Run {
  code: number;
  out: string;
  err: string;
  /** Both streams in one string, for a test that does not care which. */
  all: string;
}

/** Every `auth` call, recorded, so no test needs a keychain or a browser. */
export interface FakeAuth extends AuthOps {
  calls: string[];
  identity: Identity;
  signedIn: boolean;
}

export interface World {
  /** The temporary directory every checkout is made under. */
  dir: string;
  store: FakeStore;
  env: NodeJS.ProcessEnv;
  auth: FakeAuth;
  /** Runs `docsync <argv...>` in `cwd`. */
  run(cwd: string, ...argv: string[]): Promise<Run>;
  /** Runs git directly, for setup and for reading the result. */
  git(cwd: string, ...args: string[]): string;
  write(cwd: string, path: string, body: string): void;
  read(cwd: string, path: string): string;
  /** Every tracked file, sorted. */
  files(cwd: string): string[];
  remove(): void;
}

/** Where the fake helper the global setup built is, to put on PATH. */
export function fakeHelperBin(): string {
  return HELPER_BIN;
}

export function createWorld(state: FakeState): World {
  const dir = mkdtempSync(join(tmpdir(), 'docsync-cli-'));
  const storePath = join(dir, 'store.json');
  const store = createFileStore(storePath);
  store.save(state);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeHelperBin()}${delimiter}${process.env.PATH ?? ''}`,
    DOCSYNC_FAKE_STORE: storePath,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    // Nothing here says how to reconcile divergent branches: the refresh puts
    // `pull.rebase=true` in the checkout's own config (MANUAL §10), and that is
    // what the bare `git pull` of `docsync pull` reads.
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  const auth: FakeAuth = {
    calls: [],
    identity: { name: 'Ada Lovelace', email: 'ada@example.com' },
    signedIn: false,
    async signIn(source) {
      auth.calls.push(`signIn ${source}`);
      auth.signedIn = true;
      return auth.identity;
    },
    async signOut(source) {
      auth.calls.push(`signOut ${source}`);
      const had = auth.signedIn;
      auth.signedIn = false;
      return had;
    },
    async whoAmI(source) {
      auth.calls.push(`whoAmI ${source}`);
      if (!auth.signedIn) {
        const { NotSignedInError } = await import('../auth/errors.js');
        throw new NotSignedInError(source);
      }
      return auth.identity;
    },
  };

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trimEnd();

  return {
    dir,
    store,
    env,
    auth,
    async run(cwd, ...argv) {
      let out = '';
      let err = '';
      const context: Context = createContext({
        cwd,
        env,
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
        sources: createFakeRegistry(store),
        provider: createFakeCredentialProvider({
          notion: { accessToken: 'fake', identity: {} },
          gdocs: { accessToken: 'fake', identity: {} },
        }),
        auth,
        now: () => new Date('2026-09-03T10:12:00Z'),
      });
      const code = await runCli(argv, context);
      return { code, out, err, all: `${out}${err}` };
    },
    git,
    write(cwd, path, body) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), body);
    },
    read: (cwd, path) => readFileSync(join(cwd, path), 'utf8'),
    files: (cwd) =>
      git(cwd, 'ls-files')
        .split('\n')
        .filter((line) => line !== '')
        .sort(),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
