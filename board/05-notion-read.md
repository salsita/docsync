# 05 — Notion adapter: read

Phase 1. Manual §6 (layout, frontmatter, Notion block table), §7 (fetch).

## Goal

Given a root, produce the tree of files with canonical Markdown bodies.

## Scope

- Resolve a ref: type, title, has-children, last editor, last edit time.
- Walk a page tree, respecting ignore rules. Databases and their pages skipped.
- Blocks → Markdown for every row of the Notion table in the manual, including
  placeholders for the rest, inline colour and underline spans, links to pages
  inside and outside the checkout.
- Frontmatter generation.
- Change detection by `last_edited_time` so unchanged pages are not downloaded.
- Rate limiting and retries.

## Done when

Fixture pages covering every block type round-trip through 05 + 06 with no
diff, and the fixtures are checked in as recorded API responses.
