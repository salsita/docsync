/**
 * `~/.docsync/oauth-apps.yaml` — the one file docsync asks a user to fill in by
 * hand (MANUAL §2). docsync ships no OAuth app of its own, so each user (or
 * each team) registers one per source and pastes the client id and secret here.
 *
 * The file is only ever *read*. The one time it is written is when it does not
 * exist at all, and then it is the commented template below, which is also the
 * instructions: the comments say where to click in each vendor's console. That
 * is why the template is a string rather than something serialised from a data
 * structure, and why a file that exists is never rewritten — the user's
 * comments and formatting are theirs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { Source } from '../source-ref.js';
import { AppsFileIncompleteError, AuthError } from './errors.js';
import { appKeyOf } from './sources.js';
import type { AuthDeps, OAuthApp } from './types.js';

/**
 * Written verbatim when the file does not exist. Kept in step with MANUAL §2,
 * including both Notion redirect URIs — Notion matches redirect URIs exactly,
 * so the fallback port has to be registered up front or the retry is useless.
 */
export const APPS_FILE_TEMPLATE = `# OAuth apps used by docsync. This file is yours; docsync only reads it.
# Your team registers one app per source and shares the values; paste them here.
# Registering the apps yourself is documented in MANUAL.md §2.

google:
  client_id: ""
  client_secret: ""

notion:
  client_id: ""
  client_secret: ""
`;

/** `<home>/.docsync/oauth-apps.yaml`. On Windows `home` is `%USERPROFILE%`. */
export function appsFilePath(home: string = homedir()): string {
  return join(home, '.docsync', 'oauth-apps.yaml');
}

/** How to spell "open this file and wait", given the environment and platform. */
export function editorCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  const configured = env.EDITOR?.trim();
  if (configured) {
    const [command = '', ...args] = configured.split(/\s+/);
    return { command, args };
  }
  return { command: platform === 'win32' ? 'notepad' : 'vi', args: [] };
}

/**
 * Open the apps file in the user's editor and block until it exits. `stdio` is
 * inherited so a terminal editor gets the terminal.
 */
export function defaultRunEditor(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const { command, args } = editorCommand(env, process.platform);
  const result = spawnSync(command, [...args, path], { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`Could not start the editor "${command}": ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`The editor "${command}" exited with ${result.status}.`);
  }
}

function entryOf(text: string, source: Source, path: string): OAuthApp | undefined {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (cause) {
    // The message is not included: a file half-way through being edited can
    // have a secret on the offending line.
    throw new AuthError(source, `Could not parse ${path} as YAML.`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entry = (parsed as Record<string, unknown>)[appKeyOf(source)];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { client_id: id, client_secret: secret } = entry as Record<string, unknown>;
  if (typeof id !== 'string' || typeof secret !== 'string') return undefined;
  if (id.trim() === '' || secret.trim() === '') return undefined;
  return { clientId: id.trim(), clientSecret: secret.trim() };
}

/**
 * The OAuth app for one source, asking the user to supply it if it is not there
 * yet: write the template when the file is missing, open the editor, re-read.
 * Fails with `AppsFileIncompleteError` if the entry is still blank afterwards,
 * rather than starting a browser flow that can only end in an error page.
 */
export async function loadOAuthApp(
  source: Source,
  deps: AuthDeps = {},
  /**
   * Whether it is this command's business to ask. `docsync auth` says yes; a
   * `CredentialProvider` renewing a token in the middle of `docsync pull` says
   * no, because opening `vi` under a progress bar is not a thing to do.
   */
  prompt = true,
): Promise<OAuthApp> {
  const path = appsFilePath(deps.home);
  const runEditor = deps.runEditor ?? defaultRunEditor;

  if (!existsSync(path)) {
    // 0700 / 0600: this file holds client secrets and nothing else (MANUAL §2).
    // The modes are a no-op on Windows, where the ACL inherited from the
    // profile directory is already owner-only.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, APPS_FILE_TEMPLATE, { mode: 0o600 });
  }

  const first = entryOf(await readFile(path, 'utf8'), source, path);
  if (first) return first;
  if (!prompt) throw new AppsFileIncompleteError(source, path);

  runEditor(path);

  const second = entryOf(await readFile(path, 'utf8'), source, path);
  if (second) return second;
  throw new AppsFileIncompleteError(source, path);
}
