# 13 — Release and ai-starter integration

Phase 1.

## Goal

`npm install -g @salsita/docsync` works, and ai-starter installs it.

## Scope

- Publish to the public npm registry with provenance from CI on tag.
- Changelog and versioning.
- README with the quick start; the manual stays the reference.
- ai-starter setup step that installs docsync and can drop a pre-filled
  `oauth-apps.yaml` from the team's secret store.

## Known flake to fix here

`src/cli/commands.test.ts` "init builds the checkout of the quick start"
failed once with git exit 128 during a full `pnpm check` under load and
passed alone and on rerun (2026-09-03). Two real-git test files each build the
helper with `tsc`; serialise them or share one build in CI.

## Done when

A fresh machine can go from zero to a working checkout following only the
README.
