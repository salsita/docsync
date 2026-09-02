# 09 — Git remote helper

Phase 1. Manual §7, §9.

## Goal

`git fetch`, `git pull`, `git push` and `git clone` work against
`docsync::<manifest>` with no docsync command involved.

## Scope

- Helper protocol: `capabilities`, `list`, `import`/`export` with fast-import
  streams. Serve only `main`.
- Manifest path resolution against the working tree.
- Fetch: per-root change detection, one synthesized commit per fetch with
  source author and date, `.docsync/index.yaml` written by the helper.
- Push: reject non-fast-forward and forced pushes, refuse adds or edits
  outside roots and edits to the index, ignore deletes outside roots, route
  the diff to adapters, then the post-push fetch that adds the follow-up
  commit.
- Skill file refresh on every run (ticket 11).
- Adapters are behind an interface so the helper is tested with an in-memory
  fake source.

## Done when

An end-to-end test with the fake source covers: clone, edit and push, concurrent
remote edit and merge, new file gets an id, delete trashes, remove root
unsubscribes, force push rejected.
