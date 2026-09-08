/**
 * `docsync add <src>[=<path>]... [--no-fetch] [--readonly] [--suggest]` (MANUAL §5).
 *
 * Resolves each ref at its source, turns the optional `=<path>` alias into the
 * path the manifest stores, rewrites the manifest with the user's comments
 * intact, and then does what the user would have done by hand: fetch, and
 * fast-forward when the working tree is clean.
 *
 * `appendRoots` is the half `docsync init` shares, which is what makes "same
 * code path as `docsync add`" in the manual true rather than aspirational.
 */
import { writeFile } from 'node:fs/promises';
import { readFetchReport } from '../../helper/report.js';
import { resolveAlias, serializeManifest, validateRoots } from '../../manifest/index.js';
import type { Manifest, Root } from '../../manifest/types.js';
import type { SourceDescription } from '../../source.js';
import { isSourceRefError, parseSourceRefOrUrl, type SourceRef } from '../../source-ref.js';
import { CliError, type Context, openRepo, type Repo, say, sayBlock } from '../context.js';
import { formatFetchReport } from '../print.js';

/** One `<src>[=<path>]` argument, split but not yet resolved. */
export interface RootSpec {
  ref: SourceRef;
  alias?: string;
  /** The argument as the user typed it, for a message. */
  input: string;
}

/**
 * Whether an argument names a source rather than a directory, which is what
 * lets `docsync init` take an optional `<dir>` in front of its refs.
 */
export function looksLikeSource(argument: string): boolean {
  return !isSourceRefError(parseSourceRefOrUrl(splitSpec(argument).text));
}

/**
 * The `=` that separates the alias is the last one, and only when it is not a
 * URL's own: `?v=<id>`, `&usp=sharing` and `#heading=h.1` all carry one, and
 * the text before such a `=` ends in the parameter's name.
 */
export function splitSpec(argument: string): { text: string; alias?: string } {
  const at = argument.lastIndexOf('=');
  if (at === -1) return { text: argument };
  const text = argument.slice(0, at);
  if (/[?&#][^=?&#]*$/.test(text)) return { text: argument };
  return { text, alias: argument.slice(at + 1) };
}

/** `<src>[=<path>]` as the manual writes it, with URLs accepted (MANUAL §13). */
export function parseSpec(argument: string): RootSpec {
  const { text, alias } = splitSpec(argument);
  const ref = parseSourceRefOrUrl(text);
  if (isSourceRefError(ref)) throw new CliError(`${text}: ${ref.message}`);
  if (alias === '') throw new CliError(`${argument}: the "=" needs a path after it`);
  return { ref, ...(alias === undefined ? {} : { alias }), input: argument };
}

/** One resolved spec: what the source said, and where it will land. */
export interface AddedRoot {
  description: SourceDescription;
  root: Root;
}

/**
 * Resolves every spec and appends a root for each, writing the manifest.
 * Answers what the sources said and where each root landed, so a caller can
 * print it.
 */
export async function appendRoots(
  context: Context,
  manifest: Manifest,
  manifestPath: string,
  specs: readonly RootSpec[],
  options: { readOnly?: boolean; suggest?: boolean } = {},
): Promise<AddedRoot[]> {
  const resolved: AddedRoot[] = [];
  const added: Root[] = [];

  for (const spec of specs) {
    // Notion has no suggestions, and the manifest refuses the field there
    // (MANUAL §4); saying so here beats writing a manifest that will not parse.
    if (options.suggest === true && spec.ref.source !== 'gdocs') {
      throw new CliError(`${spec.input}: --suggest is only for Google Drive roots`);
    }
    const description = await context.sources[spec.ref.source].describe(spec.ref, context.provider);
    const path = resolveAlias(spec.alias, {
      title: description.title,
      kind: description.kind,
      ...(description.ext === undefined ? {} : { ext: description.ext }),
    });
    if (!path.ok) throw new CliError(`${spec.input}: ${path.message}`);
    const root: Root = {
      src: description.ref,
      path: path.path,
      ignore: [],
      // `--readonly` marks every root the one command adds: add is where the
      // intent is known (MANUAL §4, §5).
      ...(options.readOnly === true ? { readOnly: true } : {}),
      // `--suggest` needs the sidecars: a suggestion is read there (MANUAL §4).
      ...(options.suggest === true ? { comments: true, suggest: true } : {}),
    };
    resolved.push({ description, root });
    added.push(root);
  }

  // Every root is checked against every other, new and old alike: two refs
  // added in one command can collide with each other as easily as with a root
  // that was already there (MANUAL §4).
  const roots = [...manifest.roots, ...added];
  const invalid = validateRoots(roots);
  if (invalid.length > 0) {
    throw new CliError(invalid.map((one) => `${one.path}: ${one.message}`).join('; '));
  }

  await writeFile(manifestPath, serializeManifest({ ...manifest, roots }));
  return resolved;
}

/**
 * The fetch that follows a manifest change, in both `add` and `init`: git
 * fetches, then the branch fast-forwards. Git itself decides whether an edit
 * in progress is in the way — one to a file the fetch did not touch is not —
 * and when it refuses, the command says why and how to finish (MANUAL §5).
 */
export async function fetchAndFastForward(context: Context, repo: Repo): Promise<number> {
  const fetched = await repo.git.run(['fetch', 'origin'], { relay: true });
  if (fetched.status !== 0) return fetched.status;

  await fastForward(context, repo, ['merge', '--ff-only', 'origin/main']);
  sayBlock(context, formatFetchReport(await readFetchReport(repo.gitDir)));
  return 0;
}

/**
 * One fast-forward of the current branch, `merge` or `pull` as the caller
 * needs. A refusal is not a failure of the command that asked: what was
 * fetched or pushed stands, and the working tree is left exactly as it was.
 */
export async function fastForward(
  context: Context,
  repo: Repo,
  args: readonly string[],
): Promise<void> {
  const merged = await repo.git.run(args);
  if (merged.status === 0) {
    for (const line of merged.stdout.split('\n')) if (line !== '') say(context, line);
    return;
  }
  const why =
    merged.stderr
      .split('\n')
      .map((line) => line.replace(/^(error|fatal): /, '').trim())
      .find((line) => line !== '' && !line.startsWith('hint:')) ?? 'git refused';
  say(context, `Nothing was merged: ${why}`);
  say(context, 'Commit or stash your changes, then run: docsync pull');
}

export interface AddOptions {
  /** `--no-fetch`: stop once the manifest is written. */
  fetch: boolean;
  /** `--readonly`: the roots are pulled for context and never pushed to (MANUAL §4). */
  readOnly?: boolean;
  /**
   * `--suggest`: a push under these roots lands as suggestions the client
   * reviews in Docs, and the roots pull comment sidecars, which is where a
   * suggestion is read (MANUAL §4).
   */
  suggest?: boolean;
}

export async function add(
  context: Context,
  args: readonly string[],
  options: AddOptions,
): Promise<number> {
  const specs = args.map(parseSpec);
  const repo = await openRepo(context);
  const resolved = await appendRoots(context, repo.manifest, repo.manifestPath, specs, {
    readOnly: options.readOnly === true,
    suggest: options.suggest === true,
  });

  for (const one of resolved) say(context, `Added ${one.root.path}`);
  if (!options.fetch) return 0;
  return fetchAndFastForward(context, repo);
}
