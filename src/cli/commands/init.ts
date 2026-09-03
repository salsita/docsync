/**
 * `docsync init [<dir>] [<src>[=<path>]...]` (MANUAL §5, §6 "Formatters and
 * editors", §10).
 *
 * The steps of the manual, in that order, with one liberty the manual's own
 * prose asks for: every source ref is resolved *before* the directory is
 * created, so that a missing credential or a page that was never shared fails
 * without leaving half a checkout behind.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { readFetchReport } from '../../helper/report.js';
import { serializeManifest } from '../../manifest/index.js';
import type { Manifest } from '../../manifest/types.js';
import { CliError, type Context, inDirectory, say } from '../context.js';
import { formatFetchReport } from '../print.js';
import { appendRoots, looksLikeSource, parseSpec } from './add.js';

/** The manifest a new checkout starts with, and the remote that points at it. */
export const MANIFEST_NAME = '.docsync.yaml';
export const REMOTE_URL = `docsync::${MANIFEST_NAME}`;

/** `.prettierrc`, so that formatting a fetched file changes nothing (MANUAL §6). */
export const PRETTIERRC = `${JSON.stringify({ proseWrap: 'preserve' }, null, 2)}\n`;

/** `.editorconfig`, so that an IDE's defaults cannot undo the dialect (MANUAL §6). */
export const EDITORCONFIG = [
  'root = true',
  '',
  '[*]',
  'end_of_line = lf',
  'insert_final_newline = true',
  '',
  '[*.md]',
  'trim_trailing_whitespace = false',
  '',
].join('\n');

/**
 * What git must not see (MANUAL §5 step 4, §6, §10): the manifest, the three
 * skill files, and the two formatter files. They belong to the checkout, not
 * to the documents, and every one of them is rewritten by docsync itself.
 */
export const EXCLUDED = [
  MANIFEST_NAME,
  '.agents/skills/docsync/SKILL.md',
  '.claude/skills/docsync/SKILL.md',
  '.cursor/skills/docsync/SKILL.md',
  '.prettierrc',
  '.editorconfig',
];

/** Whether a directory can become a checkout: empty, or an empty git repo. */
async function checkTarget(context: Context, directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // Nothing there yet, which is the ordinary case.
    return;
  }
  if (entries.length === 0) return;
  if (entries.length === 1 && entries[0] === '.git') {
    const inside = inDirectory(context, directory);
    // An empty repository has no commit to lose, so `init` may fill it in.
    if ((await inside.git.run(['rev-parse', '--verify', 'HEAD'])).status !== 0) return;
  }
  throw new CliError(`${directory} is not empty`);
}

/** Adds the paths docsync owns to `.git/info/exclude`, keeping what is there. */
async function exclude(gitDir: string): Promise<void> {
  const path = join(gitDir, 'info', 'exclude');
  await mkdir(join(gitDir, 'info'), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // A repository git made without an `info/exclude`; the file is ours to write.
  }
  const have = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = EXCLUDED.filter((one) => !have.has(one));
  if (missing.length === 0) return;
  const head = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeFile(path, `${head}${missing.join('\n')}\n`);
}

export async function init(context: Context, args: readonly string[]): Promise<number> {
  // `<dir>` is optional and comes first, so anything that parses as a source
  // ref is one, and anything else in that position is the directory.
  const [head, ...rest] = args;
  const directoryArgument = head !== undefined && !looksLikeSource(head) ? head : undefined;
  const specs = (directoryArgument === undefined ? args : rest).map(parseSpec);
  const directory = resolvePath(context.cwd, directoryArgument ?? '.');

  await checkTarget(context, directory);
  // Resolving is where a missing credential or an unshared page fails, and the
  // manual promises that happens before the repo is built (MANUAL §5).
  for (const spec of specs) {
    await context.sources[spec.ref.source].describe(spec.ref, context.provider);
  }

  await mkdir(directory, { recursive: true });
  const empty: Manifest = { version: 1, roots: [] };
  const manifestPath = join(directory, MANIFEST_NAME);
  await writeFile(manifestPath, serializeManifest(empty));

  const inside = inDirectory(context, directory);
  await inside.git.must(['init', '--quiet', '-b', 'main']);
  // LF everywhere, whatever the platform's default is (MANUAL §5 step 3).
  await inside.git.must(['config', 'core.autocrlf', 'false']);
  const gitDir = (await inside.git.gitDir()) ?? join(directory, '.git');
  const root = (await inside.git.toplevel()) ?? directory;

  await exclude(gitDir);
  await context.refresh(root);
  await writeFile(join(directory, '.prettierrc'), PRETTIERRC);
  await writeFile(join(directory, '.editorconfig'), EDITORCONFIG);

  if (specs.length > 0) {
    const added = await appendRoots(inside, empty, manifestPath, specs);
    for (const one of added) say(context, `Added ${one.root.path}`);
  }

  await inside.git.must(['remote', 'add', 'origin', REMOTE_URL]);
  const fetched = await inside.git.run(['fetch', 'origin'], { relay: true });
  if (fetched.status !== 0) return fetched.status;
  const checkedOut = await inside.git.run(['checkout', '--track', 'origin/main'], { relay: true });
  if (checkedOut.status !== 0) return checkedOut.status;

  // The fetch above already ran the helper; its report is what to print.
  say(context, formatFetchReport(await readFetchReport(gitDir)));
  return 0;
}
