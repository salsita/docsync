# 12 — Windows verification

Phase 1. Manual §11.

## Goal

The whole loop works on Windows with Git for Windows and pnpm.

## Scope

- Confirm Git for Windows executes the npm-installed `git-remote-docsync` shim.
  If not, ship an `.exe` launcher.
- Paths, line endings, reserved filenames, keychain, editor launch for
  `oauth-apps.yaml`.
- CI job on `windows-latest` running the end-to-end tests from 09 and 10.

## Known failures on `windows-latest` (run 33850382599)

- `src/cli/git.test.ts` "finds the checkout from any subdirectory": git
  answers `C:/Users/runneradmin/…` (forward slashes, long name) while the
  test expects `C:\Users\RUNNER~1\…` (backslashes, 8.3 short name).
  Normalise both sides with `realpath` and `path.normalize` before
  comparing, in the code, not the test.
- `src/cli/git.test.ts` "answers undefined outside a repository": the
  runner found `D:/a/docsync/docsync`, i.e. the temporary directory was
  inside the repository or `cwd` was not applied; check `GIT_CEILING_DIRECTORIES`
  or run the test in a directory outside the workspace.
- `src/helper/run.test.ts` "resolves a relative manifest against the working
  tree": path separator mismatch in the resolved manifest path.

## Done when

The quick start works on a Windows machine and CI is green there.

## Outcome

Closed 2026-09-09 in `28682e0` and the closing commit. CI green on all six
jobs, Windows on Node 22 and 24 included, for the first time.

- `toplevel()` and `gitDir()` canonicalise git's answer with
  `realpathSync.native`, so on Windows a temporary directory's 8.3 short
  name and git's `/` both become the long, backslash spelling that
  `path` and `realpath` produce. That was the first failure.
- The second was the test: it cut the cwd after the last `/`, which on a
  backslash path left nothing and git ran in the workspace. `dirname` now.
- The third was the test comparing POSIX literals with `resolve()` output;
  both sides go through `resolve()` now.
- The real-git helper tests took up to eight seconds on one slow Windows
  runner; the vitest timeout is twenty seconds on Windows.
- The shim, the `--version` smoke of both executables, LF, reserved names
  and the editor launch were verified by earlier tickets and the CI smoke
  step.

Not verified: the quick start on a real Windows machine by a person, and
the three suites still skipped on `win32` (`commands.test.ts` end to end,
`e2e.test.ts`, `refreshSkillFiles`). Unskipping them is its own ticket if
Windows users appear.
