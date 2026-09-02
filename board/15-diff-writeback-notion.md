# 15 — Diff-based write-back: Notion

Phase 3. Manual §12 phase 3.

## Goal

Push patches only the blocks that changed, preserving block ids, block-level
comments and history elsewhere on the page.

## Scope

- Carry block ids in the Markdown in a way that survives editing and merging
  (trailing comment per block, or a sidecar map; decide with tests).
- Diff old and new block sequences; emit update, insert, delete and move
  operations.
- Fall back to whole-body replace for a page when the ids are unusable.

## Done when

Editing one paragraph on a page with comments on another leaves those comments
intact, verified against a real workspace.
