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

## Done when

The quick start works on a Windows machine and CI is green there.
