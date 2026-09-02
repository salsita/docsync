# 05 — Notion adapter: read

Phase 1. Manual §6 (layout, frontmatter, Notion block table), §7 (fetch).

## Goal

Given a root, produce the tree of files with canonical Markdown bodies. Pure
conversion in one module, API access in another, so the converter is tested
entirely on recorded fixtures.

## Fixtures

The private Notion page **Docsync test** (`3cf715cbeb088035b511f0b4f06efbd5`)
is the fixture tree. Do not edit it. It contains:

| Page | Covers |
|---|---|
| `Blocks` (🧪, child `Nested`) | Every supported block, inline formatting, mentions of a page inside and outside the checkout, a user and a date mention, placeholders (table of contents, columns, synced block), a coloured paragraph, escaping edge cases, a language-less code block |
| `Leaf` | Page with no children |
| `Title/With: Illegal*Chars? "Quoted" <Tag> \|Pipe\|`, `.Hidden leading dot...`, `Notes` ×2, `CON` | Filename derivation and collisions (ticket 02) |

`scripts/record-notion-fixtures.ts` walks that tree with a real token through
`CredentialProvider` (ticket 04) and writes the raw API responses to
`src/notion/__fixtures__/`: one file per page with the page object, the full
block tree, and the users it references. Re-run only deliberately; the
recorded files are committed.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| API client | `@notionhq/client` (official, pure JS) | Typed, handles pagination helpers and `Notion-Version`. Pin the API version explicitly. |
| Tree walk | `blocks.children.list` recursively; `child_page` blocks are the children, `child_database` blocks are skipped | The API has no "list child pages" call. |
| Last editor | `last_edited_by` id resolved via `users.retrieve`, cached per run | Needs the "user information with email" capability on the integration. |
| Change detection | `last_edited_time` of each page, compared with the index (ticket 09) | Editing a child page does not touch the parent's time, which is what we want. |
| Language-less code | Notion stores `plain text`; Markdown fence with no language ↔ `plain text` | Canonical both ways. The MCP connector defaulted to `javascript`; the REST API does not. |
| Headings 4–6 | Never produced. `####` in a pushed file is a push error (ticket 06). | Notion has three levels. |

## Dialect additions

These are gaps the fixture exposed. They go into the manual's Notion table as
part of this ticket.

**Block attributes.** Anything Notion stores on a block that GFM cannot
express, and that must survive a round trip, is an HTML comment at the end
of the block's first line:

```
Final paragraph. <!-- docsync: color=green -->
```

Used for: block colour (any block), callout icon and colour, table
`header-row`/`header-column` flags, column ratios inside placeholders. Only
non-default values are written, so most blocks carry no comment.

**Toggle heading.** A `<details>` whose summary is the heading:

```
<details>
<summary>## Toggle heading</summary>

Paragraph inside the toggle heading
</details>
```

**Mentions.**

| Mention | Markdown |
|---|---|
| page in checkout | `[Title](relative/path.md)` |
| page outside checkout | `[Title](https://www.notion.so/<id>)` |
| user | `[@Name](notion://user/<id>)` |
| date | `[2026-09-02](notion://date/2026-09-02)`, with `/2026-09-03` appended for a range, and `T10:00` style times |
| database, link preview, anything else | `[text](url)` as a plain link |

**Multi-line paragraphs and quotes.** Notion line breaks inside one block are
two trailing spaces plus newline in Markdown, so a paragraph stays one block.

## Module

`src/notion/`:

| File | Purpose |
|---|---|
| `api.ts` | Thin wrapper over the client: retrieve page, list all children (recursive, paginated), retrieve user (cached). Rate limit: respect `Retry-After`, 3 retries with backoff. |
| `walk.ts` | Root ref → page tree with titles, ids, `last_edited_*`, has-children, applying ignore rules from ticket 02. |
| `to-markdown.ts` | Block tree → Markdown body. One function per block type, one for rich text. Placeholders for the rest, carrying block id and type. |
| `frontmatter.ts` | `id`, `title` (also used by ticket 07 for Docs; put the shared part in `src/frontmatter.ts`). |
| `index.ts` | `fetchRoot(root, provider, previousIndex) → { files, index entries }` used by ticket 09. |

## Placeholders and block ids

Every placeholder carries the block id:

```
<!-- docsync:block notion:858f37cd… type=synced_block -->
```

`child_page` blocks are not in the body at all. Their position is lost, which
is fine: they are files.

## Tests

- `to-markdown` against every fixture page: snapshot of the produced
  Markdown, reviewed by hand once, then locked.
- One unit test per block type asserting the exact output for a minimal
  block, so a regression names the type.
- Rich text: each annotation alone, combined annotations, a link with
  annotations, each mention kind, an equation.
- Escaping: the fixture's escaping paragraph round-trips to the same text.
- `walk`: ignore by path and by ref, database skipped, `Nested` found under
  `Blocks`.
- `api`: pagination across two pages of results and a 429 with
  `Retry-After`, both against a mocked client.
- The 05 + 06 round-trip test is written here as a skipped test and enabled
  by ticket 06.

## Done when

`pnpm check` green, every fixture page converts, and the manual's Notion table
matches the tests.
