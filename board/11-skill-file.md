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
