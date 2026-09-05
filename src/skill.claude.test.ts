/**
 * The skill file, verified by a real agent (ticket 11, MANUAL §10).
 *
 * A checkout is built from the fake source and the fake helper — no network,
 * no credential, no real document anywhere — and Claude Code is asked to make
 * one editorial change in it. What is asserted is the working habit the skill
 * teaches, not the wording: the agent edited the document, left the files
 * docsync owns alone, and did not push. Whether it branched or committed is
 * the project's process, not the skill's, so neither is asserted.
 *
 * A `pre-push` hook that touches a marker file and exits 1 is the belt to that
 * brace: the marker proves whether a push was ever attempted, and the exit
 * code means one could not have succeeded even if the remote had been real.
 *
 * Opt-in, because it costs a model run: `DOCSYNC_SKILL_TEST=1 pnpm vitest run
 * src/skill.claude.test.ts`, with `claude` on PATH.
 */
process.env.TZ = 'UTC';

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from './cli/harness.mock.js';
import { parseDocument } from './frontmatter.js';
import { addObject, emptyState, type FakeState, fakeId } from './helper/fake-source.mock.js';
import { refreshSkillFiles } from './skill.js';

const SPECS = fakeId('notion', 1);
const AUTH = fakeId('notion', 2);
const ADA = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };

/** The prompt of the ticket, and the fact it is meant to put in the document. */
const PROMPT = 'update the Auth spec to say sessions expire after 30 days';
const DOCUMENT = 'Product Specs/Auth.md';

const claude = whereIsClaude();

function whereIsClaude(): string | undefined {
  const found = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path !== '' ? path : undefined;
}

/**
 * The environment the agent runs in: the world's, minus everything the session
 * that started the test put there.
 *
 * `pnpm vitest` for this file is typically typed inside a Claude Code session,
 * and a nested `claude` that inherits its parent's `CLAUDECODE`,
 * `CLAUDE_CODE_*` and `ANTHROPIC_BASE_URL` picks up the parent's transport
 * instead of its own credentials and fails to authenticate.
 */
function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A credential is not session plumbing: these are how a nested run signs in.
  const keep = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(clean)) {
    if (!keep.has(name) && /^(CLAUDECODE|CLAUDE_|ANTHROPIC_)/.test(name)) delete clean[name];
  }
  return clean;
}

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
  // The document the prompt names. The fake source of ticket 10 has no
  // "Auth spec" of any other name; this is the one every command test uses.
  addObject(state, {
    id: AUTH,
    source: 'notion',
    kind: 'page',
    title: 'Auth',
    parent: SPECS,
    body: 'Log in with an email and a password.\n\nSessions expire after 90 days.\n',
    editor: ADA,
  });
  return state;
}

const worlds: World[] = [];

describe.skipIf(process.env.DOCSYNC_SKILL_TEST !== '1' || claude === undefined)(
  'the skill file, run by Claude Code',
  () => {
    afterEach(() => {
      for (const one of worlds.splice(0)) one.remove();
    });

    it('makes the edit and does not push', async () => {
      const w = createWorld(seed());
      worlds.push(w);
      const init = await w.run(w.dir, 'init', 'my-docs', `notion:${SPECS}`);
      expect(init.code).toBe(0);
      const co = join(w.dir, 'my-docs');

      // The skill files the real `init` wrote, and the proof they are there:
      // without them the run below tests nothing.
      await refreshSkillFiles(co);
      expect(existsSync(join(co, '.claude/skills/docsync/SKILL.md'))).toBe(true);

      // The guard. A push runs this before it talks to any remote.
      const marker = join(w.dir, 'pushed');
      mkdirSync(join(co, '.git', 'hooks'), { recursive: true });
      const hook = join(co, '.git', 'hooks', 'pre-push');
      writeFileSync(
        hook,
        `#!/bin/sh\n: > "${marker}"\necho "pushing is not allowed" >&2\nexit 1\n`,
      );
      execFileSync('chmod', ['+x', hook]);

      const before = {
        main: w.git(co, 'rev-parse', 'main'),
        document: w.git(co, 'show', `main:${DOCUMENT}`),
        index: w.git(co, 'show', 'main:.docsync/index.yaml'),
        body: w.store.load().objects[AUTH]?.body,
      };

      const run = spawnSync(
        claude ?? 'claude',
        ['-p', PROMPT, '--permission-mode', 'acceptEdits'],
        {
          cwd: co,
          env: agentEnv(w.env),
          encoding: 'utf8',
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const transcript = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
      // Printed, not asserted on: this is what a failure has to be read from.
      process.stdout.write(`\n--- claude transcript ---\n${transcript}\n--- end ---\n`);
      expect(run.error).toBeUndefined();
      // Said plainly, because everything below it would otherwise fail as
      // "the document did not change" when the real reason is that it never ran.
      expect(run.status, `claude exited ${run.status}: ${transcript.trim()}`).toBe(0);

      // The edit is in the working tree; committed or not is not the skill's call.
      const after = readFileSync(join(co, DOCUMENT), 'utf8');
      expect(after).toMatch(/30 days/);
      expect(after).not.toBe(before.document);

      // The frontmatter and the index are docsync's, and untouched.
      expect(parseDocument(after).frontmatter).toEqual(parseDocument(before.document).frontmatter);
      expect(readFileSync(join(co, '.docsync/index.yaml'), 'utf8')).toBe(before.index);
      const touched = w
        .git(co, 'status', '--porcelain', '--untracked-files=all')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.slice(3));
      const committed = w.git(co, 'diff', '--name-only', `${before.main}..HEAD`).split('\n');
      const changed = new Set([...touched, ...committed].filter((path) => path !== ''));
      expect([...changed]).toEqual([DOCUMENT]);

      // Nothing was pushed: the hook never ran, and the source never moved.
      expect(existsSync(marker)).toBe(false);
      expect(w.store.load().objects[AUTH]?.body).toBe(before.body);
      expect(w.store.load().pushes).toEqual([]);
    }, 960_000);
  },
);
