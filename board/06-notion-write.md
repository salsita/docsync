# 06 — Notion adapter: write

Phase 1. Manual §7 (push, write-back, deletion).

## Goal

Apply a per-root diff to Notion: whole-body replace in this phase.

## Scope

- Markdown → blocks, the inverse of 05, for every supported construct.
- Update: delete existing body blocks, append new ones, in batches of 100.
- Create: new page under the parent page implied by the path, title from
  filename.
- Rename: title change from frontmatter.
- Delete: archive.
- Report per document: created, updated, trashed.
- Never write a comment.

## Done when

Round-trip tests from 05 pass, and a manual test against a real workspace
shows create, update, rename and archive behaving as the manual says.
