# 08 — Google Drive adapter: write

Phase 1. Manual §7 (push, write-back, deletion).

## Goal

Apply a per-root diff to Drive: Docs by whole-body replace, binaries by new
revision.

## Scope

- Markdown → Docs API batchUpdate requests, the inverse of 07.
- Update a Doc: delete body, insert new content with structure and inline
  formatting the dialect carries.
- Upload a new revision of a binary. Refuse read-only exports.
- Create: Doc or file in the folder implied by the path.
- Rename and move between folders.
- Delete: trash.
- Report per document.

## Done when

Round-trip tests from 07 pass, and a manual test against a real Drive shows
each operation behaving as the manual says.
