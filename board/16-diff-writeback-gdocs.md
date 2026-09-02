# 16 — Diff-based write-back: Google Docs

Phase 3. Manual §12 phase 3.

## Goal

Push patches only the paragraph ranges that changed, so range-level formatting
and comment anchors on untouched text survive.

## Scope

- Map Markdown paragraphs to document index ranges from the fetched structure.
- Diff and emit targeted insert and delete requests.
- Preserve formatting inside untouched ranges. Define what happens to
  formatting inside an edited paragraph and document it.
- Fall back to whole-body replace when the mapping is unusable.

## Done when

Editing one paragraph in a heavily formatted Doc changes nothing else, verified
against a real document. Manual §7 limitation text updated.
