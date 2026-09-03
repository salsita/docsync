/**
 * The helper as git runs it: `git-remote-docsync <remote> docsync::<manifest>`
 * with `GIT_DIR` in the environment (MANUAL §9).
 *
 * `createCommands` turns the environment into the `Commands` the protocol
 * dispatches to; `runHelper` reads lines, answers them, and says how to exit.
 * Both take every dependency — the sources, the credential provider, the
 * streams, the clock — so that the same code runs under git with the real
 * adapters and under a test with the fake ones. Nothing here knows Notion or
 * Drive by name.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CredentialProvider } from '../auth/index.js';
import { parseManifest, validateRoots } from '../manifest/index.js';
import type { Manifest } from '../manifest/types.js';
import { refreshSkillFiles } from '../skill.js';
import type { SourceRegistry } from '../source.js';
import { fetchCommit } from './fetch.js';
import { createGit, type Git } from './git.js';
import type { Commands } from './protocol.js';
import { runProtocol } from './protocol.js';
import { pushRef } from './push.js';

/** The one branch a docsync remote serves. */
export const BRANCH = 'refs/heads/main';

export const URL_PREFIX = 'docsync::';

export interface HelperOptions {
  /** `[<remote>, <url>]`, as git passes them after the program name. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  sources: SourceRegistry;
  provider: CredentialProvider;
  /** Lines from git. */
  input: AsyncIterable<string>;
  /** A line to git. */
  write: (line: string) => void;
  /** A line to the user, through git. */
  stderr: (line: string) => void;
  now?: () => Date;
  git?: Git;
  refresh?: (worktree: string) => Promise<void>;
}

/** Where the manifest of a run is, from argv and the environment. */
export function resolveManifest(options: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}): { remote: string; gitDir: string; worktree: string; manifestPath: string } {
  const [remote = 'origin', url] = options.argv;
  if (url === undefined) {
    throw new Error('usage: git-remote-docsync <remote> docsync::<manifest>');
  }
  const address = url.startsWith(URL_PREFIX) ? url.slice(URL_PREFIX.length) : url;
  const gitDir = resolve(options.cwd, options.env.GIT_DIR ?? '.git');
  const worktree = resolve(options.cwd, options.env.GIT_WORK_TREE ?? dirname(gitDir));
  const manifestPath = isAbsolute(address) ? address : resolve(worktree, address);
  return { remote, gitDir, worktree, manifestPath };
}

/** The manifest, parsed and validated, or an error naming the file and line. */
export async function loadManifest(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    throw new Error(`${path}: ${failure.code === 'ENOENT' ? 'no such file' : failure.message}`);
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    throw new Error(parsed.errors.map((one) => `${path}:${one.line}: ${one.message}`).join('; '));
  }
  const invalid = validateRoots(parsed.manifest.roots);
  if (invalid.length > 0) {
    throw new Error(
      invalid
        .map((one) => `${path}: root ${one.rootIndex + 1} (${one.path}): ${one.message}`)
        .join('; '),
    );
  }
  return parsed.manifest;
}

/** The protocol's commands over one run's environment. */
export function createCommands(options: HelperOptions): Commands {
  const { remote, gitDir, worktree, manifestPath } = resolveManifest(options);
  const git = options.git ?? createGit(gitDir);
  const ref = `refs/docsync/${remote}/main`;
  let verbosity = 1;
  const deps = {
    git,
    sources: options.sources,
    provider: options.provider,
    log: (line: string) => {
      if (verbosity > 0) options.stderr(line);
    },
    now: options.now ?? (() => new Date()),
  };

  let manifest: Promise<Manifest> | undefined;
  const theManifest = async (): Promise<Manifest> => {
    if (manifest === undefined) {
      manifest = (options.refresh ?? refreshSkillFiles)(worktree).then(() =>
        loadManifest(manifestPath),
      );
    }
    return manifest;
  };

  return {
    capabilities: () => ['fetch', 'push', 'option'],

    async option(name, value) {
      if (name !== 'verbosity') return 'unsupported';
      verbosity = Number.parseInt(value, 10) || 0;
      return 'ok';
    },

    async list(forPush) {
      const served = await git.revParse(ref);
      let sha = served;
      if (!forPush) {
        const outcome = await fetchCommit(deps, await theManifest(), served);
        if (outcome.changed) await git.updateRef(ref, outcome.commit);
        sha = outcome.commit;
      }
      // Before the first fetch there is nothing to push against; git treats an
      // empty list as a remote with no branches.
      if (sha === undefined) return [];
      return [`${sha} ${BRANCH}`, `@${BRANCH} HEAD`];
    },

    async fetch() {
      // The objects were written when `list` ran; there is nothing to fetch.
    },

    async push(refspecs) {
      const lines: string[] = [];
      for (const refspec of refspecs) {
        const destination = refspec.replace(/^\+/, '').split(':')[1] ?? BRANCH;
        try {
          const outcome = await pushRef(deps, {
            manifest: await theManifest(),
            refspec,
            ref,
            branch: BRANCH,
          });
          lines.push(outcome.ok ? `ok ${destination}` : `error ${destination} ${outcome.message}`);
        } catch (error) {
          lines.push(`error ${destination} ${oneLine(error)}`);
        }
      }
      return lines;
    },
  };
}

/** An error as the one line git's protocol has room for. */
export function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s*\n\s*/g, ' ').trim();
}

/**
 * One run: reads git's commands until EOF and answers the exit code. A
 * failure outside a push — a fetch that could not happen, a manifest that
 * does not parse — is written to stderr and ends the run with 1.
 */
export async function runHelper(options: HelperOptions): Promise<number> {
  try {
    await runProtocol(options.input, options.write, createCommands(options));
    return 0;
  } catch (error) {
    options.stderr(`docsync: ${oneLine(error)}`);
    return 1;
  }
}
