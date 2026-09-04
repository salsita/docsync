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
