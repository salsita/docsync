# 07 — Google Drive adapter: read

Phase 1. Manual §6 (layout, Google Docs table), §7 (fetch).

## Goal

Given a root, produce the tree of files: Docs as canonical Markdown, other
files as bytes, Sheets/Slides/Drawings as read-only exports.

## Scope

- Resolve a ref: file or folder, title, last editor, last edit time.
- Walk a folder tree, respecting ignore rules.
- Docs API document → Markdown for every row of the Google Docs table,
  frontmatter, placeholders for the rest, comments and suggestions excluded.
- Binary download. Exports for native non-Doc types, marked read-only.
- Change detection by `modifiedTime`.
- Rate limiting and retries.

## Done when

Fixture documents covering every element round-trip through 07 + 08 with no
diff, with recorded API responses checked in.
