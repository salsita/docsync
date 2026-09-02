# 06 — Notion adapter: write

Phase 1. Manual §7 (push, write-back, deletion).

## Goal

Apply a per-root diff to Notion. Phase 1 write-back is full replace: every
block except child pages is deleted and the body is regenerated from the
Markdown. Blocks the Markdown only holds as placeholders are not recreated.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Parsing | The same mdast pipeline as ticket 05 (`src/markdown.ts`) | One AST both ways; the round-trip test proves canonicality. |
| Replace | List top-level blocks, delete every one whose type is not `child_page`, then append the new blocks | Deleting a `child_page` block archives the page. Nothing else is worth keeping in phase 1. |
| Placeholders | Dropped on push | Full replace; the manual says so. A placeholder in the Markdown produces nothing. |
| Nesting | Append in chunks of 100 top-level blocks with up to two levels of children inline; deeper levels appended afterwards by parent block id | API limits. |
| Rich text | Split runs longer than 2000 characters; at most 100 rich-text items per block | API limits. |
| Headings 4–6 | Push error naming the file and line | Notion has three levels; silently clamping would not round-trip. |
| Create | `pages.create` under the parent page the path implies, title from filename, body appended in the same call when it fits | Manual §6. |
| Rename | Frontmatter `title` differs from the page's → `pages.update` title | Manual §6. |
| Delete | `pages.update` with `archived: true` | Reversible from the Notion UI (manual §8). |

## Module

`src/notion/`:

| File | Purpose |
|---|---|
| `from-markdown.ts` | mdast → Notion block tree. The exact inverse of `to-markdown.ts`: one function per block type, one for inline content. Resolves links: `relative/path.md` → page mention via the path-to-id map, `https://www.notion.so/<id>` → page mention, `notion://user/<id>` → user mention, `notion://date/…` → date mention, block-attribute comments → block `color` and table header flags, `> [!CALLOUT] 💡` → callout with icon. |
| `write.ts` | The operations: `replaceBody(pageId, blocks)`, `createPage(parentId, title, blocks)`, `renamePage(pageId, title)`, `archivePage(pageId)`, each returning what happened for the push report. |
| `push.ts` | `pushRoot(root, changes, provider, index) → report` used by ticket 09: takes added, modified, deleted and renamed files, orders operations (creates before links that target them can resolve; a second pass rewrites links to newly created pages), and calls `write.ts`. |
| `api.ts` | Extended from ticket 05 with delete, append, create page, update page. Same retry policy. |

## Report

Per document: `created`, `updated`, `renamed`, `trashed`, with the page title
and the local path. Trashed entries are printed last and prominently by the
CLI (ticket 10); this ticket only produces the data.

## Tests

- `from-markdown`: one unit test per block type and inline construct
  asserting the exact block JSON for a minimal input; each mention kind;
  each attribute comment; `####` produces the error with a line number.
- Round trip: enable the skipped test from ticket 05. For every fixture page:
  fixture blocks → Markdown → blocks → Markdown must be identical, and
  blocks → Markdown → blocks must equal the fixture blocks modulo ids,
  timestamps and Notion-side fields we do not control.
- `write.ts` against a mocked client: delete skips `child_page`, chunking at
  100, deep nesting split into follow-up appends, a 2500-character paragraph
  split into two rich-text items, archive sets `archived: true`.
- `push.ts`: ordering when a new file links to another new file; a rename
  with no body change makes exactly one call.

## Manual test

Against a **copy** of the fixture tree, never the original. Duplicate
`Docsync test` in the Notion UI, note the new id, and run each operation
once: replace the body of the Blocks copy, create a page, rename it, archive
it. Record what the Notion UI shows in the Outcome, especially for the
placeholder blocks that are dropped.

## Done when

`pnpm check` green, the round-trip test passes for every fixture page, and
the manual test shows create, update, rename and archive behaving as the
manual says.
