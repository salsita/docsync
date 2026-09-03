/**
 * What a command is given: the world, injected.
 *
 * Every command in `src/cli/commands/` is a function over a `Context` — the
 * directory it was started in, a git runner, the source registry, a credential
 * provider, the two output streams and the clock. Nothing reaches for a global,
 * so a command runs in a test against the fake source and a temporary
 * repository exactly as it runs under a terminal.
 *
 * `openRepo` is the other half: the checkout a command that needs one works
 * in, found from any subdirectory the way git finds it, with the manifest the
 * remote URL points at already parsed.
 */
import { isAbsolute, resolve } from 'node:path';
import { type AuthDeps, createCredentialProvider, type Identity } from '../auth/index.js';
import type { CredentialProvider } from '../auth/types.js';
import { loadManifest, URL_PREFIX } from '../helper/run.js';
import type { Manifest } from '../manifest/types.js';
import { refreshSkillFiles } from '../skill.js';
import { type SourceName, type SourceRegistry, sources } from '../source.js';
import { createGitRunner, type GitRunner } from './git.js';

/**
 * The three calls `docsync auth` makes, injected so that a test drives the
 * command without a keychain, a browser or a network (MANUAL §2).
 */
export interface AuthOps {
  signIn(source: SourceName, deps?: AuthDeps): Promise<Identity>;
  signOut(source: SourceName, deps?: AuthDeps): Promise<boolean>;
  whoAmI(source: SourceName, deps?: AuthDeps): Promise<Identity>;
}

export interface Context {
  /** Where docsync was started. Every relative path resolves against it. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  sources: SourceRegistry;
  provider: CredentialProvider;
  git: GitRunner;
  auth: AuthOps;
  /** Written verbatim: a command adds its own newline through `say`. */
  out(text: string): void;
  err(text: string): void;
  now(): Date;
  /** Brings a checkout's skill files up to date (MANUAL §10). */
  refresh(worktree: string): Promise<void>;
}

/**
 * Anything the user can fix, said in one line. `cli.ts` prints the message and
 * exits 1; nothing else about the error reaches the terminal.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ContextOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  sources?: SourceRegistry;
  provider?: CredentialProvider;
  auth?: AuthOps;
  now?: () => Date;
  refresh?: (worktree: string) => Promise<void>;
  git?: GitRunner;
}

/** The context of one real run, with every default in place. */
export function createContext(options: ContextOptions): Context {
  const env = options.env ?? process.env;
  const context: Context = {
    cwd: options.cwd,
    env,
    sources: options.sources ?? sources,
    provider: options.provider ?? createCredentialProvider(),
    auth: options.auth ?? lazyAuth(),
    out: options.out,
    err: options.err,
    now: options.now ?? (() => new Date()),
    refresh: options.refresh ?? refreshSkillFiles,
    git:
      options.git ?? createGitRunner({ cwd: options.cwd, env, out: options.out, err: options.err }),
  };
  return context;
}

/**
 * The real auth calls, imported when one is made. `src/auth/` opens a keychain
 * on the way in, which is not something `docsync status` should pay for.
 */
function lazyAuth(): AuthOps {
  return {
    async signIn(source, deps) {
      return (await import('../auth/index.js')).signIn(source, deps);
    },
    async signOut(source, deps) {
      return (await import('../auth/index.js')).signOut(source, deps);
    },
    async whoAmI(source, deps) {
      return (await import('../auth/index.js')).whoAmI(source, deps);
    },
  };
}

/** The same context, working in another directory: a git bound to it, and nothing else changed. */
export function inDirectory(context: Context, cwd: string): Context {
  return {
    ...context,
    cwd,
    git: createGitRunner({ cwd, env: context.env, out: context.out, err: context.err }),
  };
}

/** One line to the user. */
export function say(context: Context, text = ''): void {
  context.out(`${text}\n`);
}

/** A block of report text, when there is any. An absent report says nothing. */
export function sayBlock(context: Context, text: string): void {
  if (text !== '') say(context, text);
}

/** One line to stderr. */
export function warn(context: Context, text: string): void {
  context.err(`${text}\n`);
}

/** The checkout a command works in, and the manifest that defines it. */
export interface Repo {
  /** The working tree, absolute. */
  root: string;
  /** The repository directory, absolute: where the report files live. */
  gitDir: string;
  manifestPath: string;
  manifest: Manifest;
  /** A git bound to the working tree rather than to the starting directory. */
  git: GitRunner;
}

/**
 * Finds the checkout `context.cwd` is in and parses its manifest.
 *
 * The manifest is wherever the `origin` remote says (MANUAL §9): a relative
 * address resolves against the working tree, never against the shell's
 * directory, so the answer does not depend on where the command was typed.
 */
export async function openRepo(context: Context): Promise<Repo> {
  const root = await context.git.toplevel();
  const gitDir = await context.git.gitDir();
  if (root === undefined || gitDir === undefined) {
    throw new CliError(`${context.cwd} is not a git repository. Run: docsync init`);
  }

  const url = await context.git.remoteUrl('origin');
  if (url === undefined || !url.startsWith(URL_PREFIX)) {
    throw new CliError(
      `${root} has no docsync remote: "origin" is ${url === undefined ? 'not set' : url}`,
    );
  }
  const address = url.slice(URL_PREFIX.length);
  const manifestPath = isAbsolute(address) ? address : resolve(root, address);

  await context.refresh(root);
  return {
    root,
    gitDir,
    manifestPath,
    manifest: await loadManifest(manifestPath),
    git: inDirectory(context, root).git,
  };
}
