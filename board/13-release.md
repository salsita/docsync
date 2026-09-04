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

## Carried over from ticket 22

The flake in the two real-git test files was the helper dying on EPIPE and
is fixed. Still open: `src/cli.ts` (`out`/`err`) and the helper's
`--version` write to `process.stdout` unguarded, so `docsync status | head`
can crash the way the helper did. Route them through the guarded writer
from `src/helper/main.ts`.

## Done when

A fresh machine can go from zero to a working checkout following only the
README.
