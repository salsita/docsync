/**
 * Git, as a handful of plumbing calls over one `GIT_DIR`.
 *
 * The helper never reimplements an object, a tree or a pack: it spawns `git`
 * and lets git do it. Everything the helper needs is here, one function per
 * command, so that the rest of the helper reads as intent and not as argument
 * arrays. Nothing here knows what docsync is.
 */
import { execFile } from 'node:child_process';

/** One entry in a tree: a blob or a subtree, under a single name. */
export interface TreeEntry {
  /** `100644`, `100755`, `120000` for a blob; `040000` for a subtree. */
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  /** A single path component for `mktree`, a full path from `lsTree`. */
  name: string;
}

/** Who a commit is by, and when. */
export interface Identity {
  name: string;
  email: string;
  /** Anything `git commit-tree` accepts, ISO 8601 included. */
  date: string;
}

/** One line of `git diff-tree --name-status`. */
export interface DiffEntry {
  /** `A`, `M`, `D`, `R100`, `T`, … as git spells it. */
  status: string;
  path: string;
  /** Where a rename came from. */
  previousPath?: string;
}

/** A git command that failed, with git's own message. */
export class GitError extends Error {
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'no output'}`);
    this.name = 'GitError';
  }
}

// A tree of a few thousand documents fits in a few megabytes of `ls-tree`
// output; a single fetched file can be larger still. Node's 1 MB default is
// the wrong order of magnitude for both.
const MAX_BUFFER = 256 * 1024 * 1024;

export interface Git {
  /** Runs git and answers stdout as bytes. Throws `GitError` on a non-zero exit. */
  raw(
    args: readonly string[],
    options?: { input?: Uint8Array; env?: NodeJS.ProcessEnv },
  ): Promise<Buffer>;
  /** The same, as UTF-8 text with the trailing newline removed. */
  text(args: readonly string[], options?: { input?: Uint8Array }): Promise<string>;
  /** Writes bytes as a blob and answers its sha. */
  hashObject(content: Uint8Array): Promise<string>;
  /** Writes one tree object from entries that are all in the same directory. */
  mktree(entries: readonly TreeEntry[]): Promise<string>;
  /** Every blob under a tree-ish, keyed by full path. */
  lsTree(treeish: string): Promise<TreeEntry[]>;
  /** A blob's bytes. */
  catBlob(sha: string): Promise<Buffer>;
  /** The sha a revision names, or undefined when it does not exist. */
  revParse(revision: string): Promise<string | undefined>;
  /** The tree of a commit. */
  treeOf(commit: string): Promise<string>;
  commitTree(options: {
    tree: string;
    parents?: readonly string[];
    message: string;
    author: Identity;
    committer: Identity;
  }): Promise<string>;
  updateRef(ref: string, sha: string): Promise<void>;
  /** Whether `ancestor` is reachable from `descendant`. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** What changed between two commits, renames detected. */
  diffTree(from: string, to: string): Promise<DiffEntry[]>;
}

/** A `Git` bound to one repository. `gitDir` is passed to git as `GIT_DIR`. */
export function createGit(gitDir: string, gitBinary = 'git'): Git {
  async function raw(
    args: readonly string[],
    options: { input?: Uint8Array; env?: NodeJS.ProcessEnv } = {},
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        gitBinary,
        [...args],
        {
          // `GIT_WORK_TREE` is deliberately not passed on: every command here
          // is an object-store command, and a work tree would only let one of
          // them touch the user's files.
          env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: undefined, ...options.env },
          encoding: 'buffer',
          maxBuffer: MAX_BUFFER,
        },
        (error, stdout, stderr) => {
          if (error) reject(new GitError(args, stderr.toString('utf8')));
          else resolve(stdout);
        },
      );
      // Most of the commands here never read stdin, and git is free to exit
      // before the input is handed over: the write then lands on a closed pipe
      // and raises EPIPE on the child's stdin. That is the normal end of the
      // race and not a failure — the exit code above is the answer — but an
      // 'error' with no listener is an unhandled event that takes the whole
      // helper down mid-protocol, which git reports as exit 128 (ticket 22).
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.input ?? Buffer.alloc(0));
    });
  }

  const text = async (
    args: readonly string[],
    options: { input?: Uint8Array } = {},
  ): Promise<string> => (await raw(args, options)).toString('utf8').replace(/\n$/, '');

  return {
    raw,
    text,

    async hashObject(content) {
      return text(['hash-object', '-w', '-t', 'blob', '--stdin'], { input: content });
    },

    async mktree(entries) {
      const lines = entries.map(
        (entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\0`,
      );
      // `-z` so that a name holding a newline or a quote goes through verbatim.
      return text(['mktree', '-z'], { input: Buffer.from(lines.join(''), 'utf8') });
    },

    async lsTree(treeish) {
      const out = await text(['ls-tree', '-r', '-z', treeish]);
      const entries: TreeEntry[] = [];
      for (const record of out.split('\0')) {
        if (record === '') continue;
        const tab = record.indexOf('\t');
        const [mode = '', type = '', sha = ''] = record.slice(0, tab).split(' ');
        entries.push({ mode, type: type as 'blob' | 'tree', sha, name: record.slice(tab + 1) });
      }
      return entries;
    },

    async catBlob(sha) {
      return raw(['cat-file', 'blob', sha]);
    },

    async revParse(revision) {
      try {
        return await text(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
      } catch {
        // `--quiet` makes an unknown revision an exit code and no message,
        // which is the answer "there is none" rather than a failure.
        return undefined;
      }
    },

    async treeOf(commit) {
      return text(['rev-parse', '--verify', `${commit}^{tree}`]);
    },

    async commitTree({ tree, parents = [], message, author, committer }) {
      const args = ['commit-tree', tree];
      for (const parent of parents) args.push('-p', parent);
      // The message arrives on stdin, where `commit-tree` reads it when no
      // `-m` is given, so that no argument limit can touch it: it holds one
      // line per changed path.
      const out = await raw(args, {
        input: Buffer.from(message, 'utf8'),
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_DATE: author.date,
          GIT_COMMITTER_NAME: committer.name,
          GIT_COMMITTER_EMAIL: committer.email,
          GIT_COMMITTER_DATE: committer.date,
        },
      });
      return out.toString('utf8').trim();
    },

    async updateRef(ref, sha) {
      await text(['update-ref', ref, sha]);
    },

    async isAncestor(ancestor, descendant) {
      try {
        await text(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
      } catch {
        return false;
      }
    },

    async diffTree(from, to) {
      const out = await text(['diff-tree', '-r', '-M', '-z', '--name-status', from, to]);
      const fields = out.split('\0').filter((field) => field !== '');
      const entries: DiffEntry[] = [];
      for (let at = 0; at < fields.length; ) {
        const status = fields[at] ?? '';
        // A rename or a copy carries two paths, everything else one.
        if (status.startsWith('R') || status.startsWith('C')) {
          entries.push({
            status,
            previousPath: fields[at + 1] ?? '',
            path: fields[at + 2] ?? '',
          });
          at += 3;
        } else {
          entries.push({ status, path: fields[at + 1] ?? '' });
          at += 2;
        }
      }
      return entries;
    },
  };
}
