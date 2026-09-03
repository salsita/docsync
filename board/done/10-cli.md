# 10 — docsync CLI

Phase 1. Manual §2 (auth), §3 (quick start), §5, §6 (init files), §13.

## Goal

Every command in the reference, with the output the manual describes. Git is
driven by spawning `git`; the helper from ticket 09 does the source work. The
CLI adds nothing to what plain git can do, it only prints better.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Argument parsing | Commander (`commander`, pinned), one `Command` per file under `src/cli/commands/` registered on the program in `src/cli.ts`. Unknown commands and options are errors; `--help` is generated from the command descriptions and matches manual §13 | Owner's choice: standard `--help`, strict syntax, a small dependency-free library. |
| Git | Spawned with `cwd` at the checkout; `git rev-parse --show-toplevel` finds it from any subdirectory. Output relayed as is | Ticket 09 rule. |
| Reports | The helper writes `$GIT_DIR/docsync/last-fetch.json` and `last-push.json` (the changed files with editors, the `PushReport`, the skipped objects). `fetch`, `pull` and `push` run git, then read the file and print it | Git relays helper stderr line by line, which is fine for progress and useless for a structured report. Adding these two files to the helper is part of this ticket. |
| `Source` | Gains `describe(ref, provider)` → `{ title, kind, childCount, editor?, lastEditedTime }` and `changedSince(root, provider, previous)` → the paths whose metadata moved, without downloading anything. Both implemented in the adapters from the walk they already have | `resolve`, `add` and `status` need the source without a fetch. |
| `init` | The steps in manual §5, in that order, plus `.prettierrc` (`{ "proseWrap": "preserve" }`) and `.editorconfig` (`root = true`; `[*] end_of_line = lf, insert_final_newline = true`; `[*.md] trim_trailing_whitespace = false`) written and excluded like the skill files. A non-empty directory is an error unless it is an empty git repo | Manual §5, §6 "Formatters and editors". |
| `add` | Resolves each ref with `describe`, computes the path with `resolveAlias`, validates the roots together, rewrites the manifest with comments preserved, then `git fetch` and, when the working tree is clean, `git merge --ff-only origin/main`. `--no-fetch` stops after the manifest | Manual §5. |
| `remove` | Drops the roots whose `path` matches exactly, `git rm -r` the paths, commits `Remove <path>` locally. Nothing at the source | Manual §5, §8. |
| `status` | `git status --short --branch`, then one line per root: `notion:2f3a…  Product Specs/  fetched 2026-09-03 10:12  3 changed at source` from `changedSince` | Manual §5. |
| `push` | `git push`, then reads `last-push.json`, prints created/updated/renamed lines, then trashed lines last under a `Trashed:` heading, then `git merge --ff-only origin/main` when clean, else says how to pull | Manual §5, §7, §8. |
| `pull` / `fetch` | `git pull` / `git fetch`, then reads `last-fetch.json` and prints `<path>  by <editor>  <time>` per changed document and one line per skipped object | Manual §5. |
| `auth <source> [--logout]` | `signIn` / `signOut` from `src/auth/`, printing the grant hint and the identity | Manual §2. |
| `resolve <src>` | `describe`, printed as a short table | Manual §5. |
| `--version`, `--help` | Version from `src/version.ts`; help is the command reference from §13 | Manual §13. |
| Errors | One line on stderr, exit 1; `PushError`, manifest errors and auth errors keep their own wording | Same voice as the helper. |

## Module

| File | Purpose |
|---|---|
| `src/cli.ts` | The binary: parse, dispatch, exit code. |
| `src/cli/commands/*.ts` | One file per command, each a function over an injected `Context` (cwd, git runner, sources, provider, stdout/stderr). |
| `src/cli/git.ts` | Spawning git with captured or relayed output; reuses `src/helper/git.ts` where the plumbing overlaps. |
| `src/cli/print.ts` | The report formats, tested as pure functions. |
| `src/helper/report.ts` | Writing the two JSON files from the helper. |

## Tests

- `print.ts`: every report shape, including an empty push and a push with
  only trashed documents.
- Each command against the fake source and harness from ticket 09, in a
  temporary directory with real git: `init` with two roots produces the
  layout in the quick start; `init` in a non-empty directory fails; `add`
  with each alias form; `add --no-fetch`; `remove` commits the deletion and
  the next push does not touch the source; `status` shows a root that moved;
  `push` output with a trashed document last; `push` on a dirty tree says
  how to pull; `pull` and `fetch` output; `resolve`; `--version`; unknown
  command and missing argument messages.
- The quick start in manual §3, run verbatim as one test against the fake
  source.

## Done when

`pnpm check` green, and the quick start test passes on macOS and Linux in
CI.

## Outcome

Landed 2026-09-03 in four agent commits (`6ffa27d`, `1f071a0`, `95cec05`,
`c8c27a5`) plus the landing commit. `pnpm check` green, 1002 tests.

Deviations from the ticket:

- Two more modules than planned: `src/cli/context.ts` (the injected
  `Context` and `openRepo`) and `src/cli/program.ts` (the Commander program,
  importable by tests; `src/cli.ts` is the four-line binary). Test helpers
  `src/cli/harness.mock.ts` and `src/helper/fake-bin.mock.ts`, the latter
  shared with the helper's e2e test.
- `src/cli/git.ts` shares nothing with `src/helper/git.ts`: the helper's
  runner pins `GIT_DIR` and drops `GIT_WORK_TREE`, the CLI needs porcelain in
  the working tree.
- Top-level `--help` is manual §13 verbatim through a `formatHelp` override;
  per-command help is Commander's, with §5's wording.
- `init` resolves every ref before creating the directory (the manual's prose
  promised that; its step list did not). Manual step list rewritten.
- `push` ends with `git pull --ff-only`, not a bare merge: after `git push`,
  `origin/main` points at what was pushed and the §7 follow-up commit needs
  another fetch. Manual §5 says so now.
- `remove` then `push` is refused with "the source changed" until a
  `docsync pull`, because the helper's pre-flight fetch turns the manifest
  change into a commit. Documented in §5 as it is.
- Time is printed in local time; the tests pin `TZ=UTC`.

Manual changes made at landing: §3 listing corrected (a directory root holds
the page as `Product Specs/Product Specs.md` and its children beside it, per
§4 and §6); §5 `init` steps reordered and the two formatter files added; §5
`remove` and `push` as above; §13 `auth` shows `[--logout]`.

Follow-ups:

- `docsync remove` could run the pull itself, as `add` runs the fetch, so
  that the next push is not refused. Worth doing with ticket 11 or 13.
- The fake `Source` lays a Notion root's children out flat
  (`Specs/Auth.md`) while the real adapter nests them
  (`Specs/Specs/Auth.md`); the CLI layout assertions are weaker than they
  look. Align the fake in ticket 11, which touches the same harness.
- Two heavy real-git test files each build the helper with `tsc`; under load
  they hit the timeout once. Watch in CI (ticket 13).
- `src/cli.ts` is uncovered, like `src/remote-helper.ts`.
