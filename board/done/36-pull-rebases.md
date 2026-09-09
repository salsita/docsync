# 36 — A checkout pulls by rebase

Phase 1. Manual §3 quick start, §5 `init`, §7 push step 2, §10 "The skill
file".

## Problem

The remote's `main` is a straight line of fetch commits, and a checkout
carries edit commits on top. The first `git pull` after the source moved
therefore finds divergent branches, and git since 2.27 refuses to guess
how to reconcile them unless `pull.rebase` is set: "You have divergent
branches and need to specify how to reconcile them." Every new user hits
it, `docsync pull` (which runs plain `git pull`) hits it too, and the
answer is always the same: rebase. A merge works, since the helper pushes
the resulting tree, but every source change pulled in becomes a merge
bubble for nothing.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Setting | `pull.rebase=true` in the checkout's own config (`git config --local`), never global | The choice is docsync's, for docsync checkouts; a user's other repositories are not our business. |
| When | In the skill-file refresh (`refreshSkillFiles`), which every command and every helper run already does, so `init`, `git clone docsync::…` and every checkout made by an older version get it on their next touch | One place; matches how `.git/info/exclude` lines are back-filled (§10). |
| Respect | Set only when the repository config has no `pull.rebase` at all. An explicit `false` or `merges` in the repo config is kept | Someone who chose otherwise chose. Global and system values do not count: the local one is what makes the checkout's behaviour independent of the machine. |
| Failure | Cannot write (read-only checkout): say so on stderr once, like a skill refresh that cannot write, never fail the command | §10's rule for the refresh. |
| `init` | Nothing extra: step 6 runs the refresh, which sets it. The manual's step 4 lists it beside `core.autocrlf` because that is where a reader looks | Documentation only. |
| `docsync push` | Unchanged: its follow-up is `git pull --ff-only` | A fast-forward is a fast-forward under either setting. |
| The helper's clone | The refresh runs during the clone already, so a clone gets it with no docsync command ever run | Nothing to add; test it. |

## Module

| File | Purpose |
|---|---|
| `src/skill.ts` | `refreshSkillFiles`: after the exclude lines, read `git config --local --get pull.rebase`; on no value, `git config --local pull.rebase true`. Use the git runner the module already has. |
| Tests | `src/skill.test.ts`: a fresh repo gets `pull.rebase=true`; a repo with `pull.rebase=false` keeps it; a repo whose global config says `false` (set via `GIT_CONFIG_GLOBAL` to a temp file) still gets a local `true`; the refresh on a repo whose `.git/config` is read-only reports and does not throw. `src/cli/commands.test.ts` or the helper e2e: after `docsync init` and after `git clone docsync::…` the local config has it; a checkout with one local edit commit pulls a source change with plain `git pull` and ends one commit ahead, linear, no merge commit. |
| `MANUAL.md` | Owner's edits, already made: §3, §5 step 4, §10. |

## Done when

`pnpm check` green; in a checkout with a committed edit, after the source
changes, `git pull` without arguments rebases and `git log --oneline
--graph` shows a straight line.

## Outcome

Landed 2026-09-09 in two agent commits (`8534e9b`, `29f36c9`) plus the
landing commit. `pnpm check` green, 1551 tests (+6).

- `refreshSkillFiles` now tends the repository in one place
  (`tendRepository`): the exclude lines, then `pull.rebase=true` in the
  local config when there is none. A failed write is one stderr line.
- Deviation: the ticket claimed `docsync push`'s `git pull --ff-only` was
  unaffected. It is not: with `pull.rebase=true`, git takes the rebase path
  first and refuses any unstaged change before checking whether the pull is
  a fast-forward. The follow-up is now `git pull --ff-only --no-rebase`,
  which is the old behaviour. Manual §7 push step 6 says so, and warns that
  a bare `git pull` mid-edit refuses for the same reason.
- Both test harnesses had forced `pull.rebase=false` over every git run,
  which is the workaround this ticket removes; dropped, so tests see what a
  user sees.
- e2e case 18: a plain `git clone docsync::…` carries the setting with no
  docsync command run; a local edit commit plus a source change and a bare
  `git pull` end one commit ahead, linear.
