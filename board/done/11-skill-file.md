# 11 — Skill file

Phase 1. Manual §10, §5 `init` step 6, §6 "Formatters and editors".

## Goal

Every checkout carries a skill file that makes an agent work the docsync
way: pull first, edit on a branch, respect what docsync owns, never push
unless asked. Written by `init`, refreshed by every command and helper run,
verified with Claude Code on a checkout that has no real source behind it.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Content | `skill/SKILL.md` in the package, with frontmatter `name: docsync` and a one-line `description`, then: what a checkout is (§1 in five lines); the loop (`docsync pull`, branch, edit, commit, stop: "do not push unless the person asked in this conversation"); what not to touch (frontmatter, `.docsync/index.yaml`, placeholders, `*.comments.md`, the skill files themselves); the dialect rules an agent gets wrong (`_italic_`, backslash line breaks, attribute comments above blocks, no empty paragraphs, table cells inline only); how to read `docsync status`, a fetch or push report, and a comment sidecar (reply by editing the body; threads are read-only); Windows note (`/` separators) | The manual is too long for a skill; this is the operating subset, under 120 lines. |
| Refresh | `refreshSkillFiles(worktree)` in `src/skill.ts`: read the bundled file, compare bytes with each of the three paths, write the ones that differ, create directories as needed, never delete. Errors are reported on stderr and never fail the command | Manual §10. Called already by every command and helper run. |
| Exclude | `init` already excludes the three paths. `refreshSkillFiles` also appends missing lines to `.git/info/exclude`, so a checkout made by an older version gets them | Upgrades. |
| Verification | `src/skill.claude.test.ts`, skipped unless `claude` is on PATH and `DOCSYNC_SKILL_TEST=1`: builds a checkout from the fake source and the fake helper (the ticket 10 harness), installs a `pre-push` hook that exits 1, runs `claude -p "update the Auth spec to say sessions expire after 30 days" --permission-mode acceptEdits` in the checkout, then asserts: a branch other than `main` has a commit; `Product Specs/Auth.md` contains the sentence; frontmatter unchanged; the index unchanged; `main` unchanged; no push attempted (the hook never fired). Run by the agent at least twice and the transcript summarised in the report | Done-when of the ticket, without a real source anywhere. |
| Guard | The test checkout's remote is the fake source; there are no credentials in play and the fake helper does not know real ids. The pre-push hook is the belt to that brace | Owner's concern: the test agent must not be able to push to a real Drive. |

## Module

| File | Purpose |
|---|---|
| `skill/SKILL.md` | The skill. |
| `src/skill.ts` | Refresh and exclude. |
| `src/skill.test.ts` | Refresh writes, rewrites on difference, leaves identical files alone, appends excludes. |
| `src/skill.claude.test.ts` | The Claude Code run, opt-in. |

## Done when

`pnpm check` green; the Claude Code run passes twice; the owner tries Codex
and Cursor on a checkout after landing and feeds back what they get wrong.

## Outcome

Landed as `4f13175` and `6f00e53`. `skill/SKILL.md` is 105 lines; every
dialect rule was checked against §6, which corrected two points of the
brief: empty paragraphs exist and must be left alone, and an attribute
comment needs a blank line before its block. `src/skill.ts` refreshes the
three copies byte-for-byte, finds `info/exclude` through
`git rev-parse --git-path` so a linked worktree works, and reports on stderr
without failing the command. `init` reuses `SKILL_PATHS`.

Beyond the ticket: a fake `docsync` binary for the e2e PATH
(`src/cli/fake-cli.mock.ts`), since the skill tells the agent to run
`docsync pull` and `docsync status`; and the fake helper build now lays out
`src/` and `skill/` like the package, because the real refresh runs on every
fetch and the flat layout pointed at nothing. The CLI harness no longer stubs
the refresh, so the command tests exercise it.

Not done: the two Claude Code runs. `claude -p` cannot authenticate from a
nested session on this machine ("OAuth session expired"), for the agent and
for the reviewer alike. The test itself was proven with a scripted stand-in
on PATH that follows the skill's loop, which found two harness bugs, both
fixed. The owner runs it after `claude` `/login`:

    DOCSYNC_SKILL_TEST=1 corepack pnpm vitest run src/skill.claude.test.ts

Until then the skill's wording is unvalidated by a model, and the Codex and
Cursor trial is the owner's after landing. Manual §10 gained the sentence on
a refresh that cannot write.
