/**
 * Git, spawned in a working tree (ticket 09's rule: never reimplement git).
 *
 * `src/helper/git.ts` is the object-store half — plumbing over one `GIT_DIR`,
 * with the work tree deliberately kept out of reach. This is the other half:
 * porcelain in the user's checkout, where the point is that `docsync push` and
 * `git push` do the same thing and only the printing differs. The two share
 * nothing but the idea, so they stay two files.
 *
 * Every call answers git's exit code rather than throwing, because a refused
 * push is an answer and not a crash; `must` is the wrapper for the calls that
 * had to work.
 */
import { spawn } from 'node:child_process';

/** What one git command did. `stdout` and `stderr` are captured either way. */
export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Also write git's output to the terminal, as git produces it. */
  relay?: boolean;
  /** Run in this directory instead of the runner's own. */
  cwd?: string;
  /**
   * The environment of this one run, in place of the runner's. It is how
   * `docsync fetch --all` reaches the helper (MANUAL §5, §7): git hands its
   * own environment to the helper it spawns, and no run but the one that asked
   * for it carries the variable.
   */
  env?: NodeJS.ProcessEnv;
}

export interface GitRunner {
  /** Where git runs unless a call says otherwise. */
  readonly cwd: string;
  run(args: readonly string[], options?: RunOptions): Promise<GitResult>;
  /** The same, but a non-zero exit throws with git's message. Answers stdout, trimmed. */
  must(args: readonly string[], options?: RunOptions): Promise<string>;
  /** The working tree this directory is in, or undefined when there is none. */
  toplevel(): Promise<string | undefined>;
  /** The repository directory (`.git`), absolute. */
  gitDir(): Promise<string | undefined>;
  /** Whether the working tree has no changes, staged or not. */
  isClean(): Promise<boolean>;
  /** A remote's URL, or undefined when there is no such remote. */
  remoteUrl(remote: string): Promise<string | undefined>;
}

export interface GitRunnerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Where relayed stdout goes. */
  out: (text: string) => void;
  /** Where relayed stderr goes. */
  err: (text: string) => void;
  /** The git to run. Tests of a missing git pass something else. */
  binary?: string;
}

/** A git that failed a call that had to work, with git's own message. */
export class GitCommandError extends Error {
  readonly result: GitResult;

  constructor(args: readonly string[], result: GitResult) {
    super(
      (result.stderr.trim() || result.stdout.trim()) === ''
        ? `git ${args.join(' ')} failed with status ${result.status}`
        : result.stderr.trim() || result.stdout.trim(),
    );
    this.name = 'GitCommandError';
    this.result = result;
  }
}

export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const binary = options.binary ?? 'git';

  async function run(args: readonly string[], run: RunOptions = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [...args], {
        cwd: run.cwd ?? options.cwd,
        env: run.env ?? options.env ?? process.env,
        // stdin is the user's: git may want to open an editor or ask a question.
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (run.relay === true) options.out(chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (run.relay === true) options.err(chunk);
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
    });
  }

  async function must(args: readonly string[], run: RunOptions = {}): Promise<string> {
    const result = await runner.run(args, run);
    if (result.status !== 0) throw new GitCommandError(args, result);
    return result.stdout.trimEnd();
  }

  async function ask(args: readonly string[]): Promise<string | undefined> {
    const result = await runner.run(args);
    return result.status === 0 ? result.stdout.trimEnd() : undefined;
  }

  const runner: GitRunner = {
    cwd: options.cwd,
    run,
    must,
    toplevel: () => ask(['rev-parse', '--show-toplevel']),
    gitDir: () => ask(['rev-parse', '--absolute-git-dir']),
    async isClean() {
      return (await must(['status', '--porcelain'])) === '';
    },
    remoteUrl: (remote) => ask(['remote', 'get-url', remote]),
  };
  return runner;
}
