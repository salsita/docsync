# 07 — Google Drive adapter: read

Phase 1. Manual §6 (layout, identity, Google Docs table), §7 (fetch).

## Goal

Given a root, produce the tree of files: Google Docs as canonical Markdown,
other files as bytes, Sheets, Slides and Drawings as read-only exports. Same
shape as ticket 05: pure conversion in one module, API access in another,
converter tested on recorded fixtures.

## Fixtures

Drive folder **Docsync test** (`13bDdq9dYrAR1E23oS2cLV__S71xIagPt`) in the
owner's Drive root, created by `scripts/create-gdrive-fixtures.ts`. Do not
edit after recording.

| Item | Id | Covers |
|---|---|---|
| `Elements` (Doc) | `1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4` | Headings 1–6, nested bullet and numbered lists, table, rule, inline formatting, colours, fonts, sizes, alignment, soft line break, escaping cases, plus Title, Subtitle, page break, checklist, footnote, image and a comment added by hand |
| `Leaf` (Doc) | `1a-9FG_jwht91hmvglPsRpyi13yr9mlmTiUrXewEVyfI` | One paragraph |
| `Sub/Nested` (Doc in sub-folder) | folder `1RoSAIyz2ktweMqiOBnlnl6AsXClvD3Wo`, doc `12Q7xOSDxkV5zhacq39GLXAON3VhZkbN1rd2gt1hC9FQ` | Recursion |
| hostile titles, `Notes` ×2 | see script output | Filenames and collisions (ticket 02) |
| `Numbers` (Sheet) | `1ATMpIGObGedDD6f3yjkGq0jl0SPJ-BDbqpKC85MHg1w` | Read-only export |
| `plain.txt`, `dummy.pdf` | `1oiqaDywxRX2qqjSpAlu2gZjS-0BWcqfr`, `1jwUlUMVzDrXjzjcIjUnUACFQq094neaW` | Binaries |

`scripts/record-gdrive-fixtures.ts` walks the folder with a real token through
`CredentialProvider` and writes to `src/gdrive/__fixtures__/`: the listing per
folder, the Docs API document JSON per Doc, the small binaries, and the Sheet
export. Committed; re-run only deliberately.

## Why not Drive's own Markdown export and import

Tested on 2026-09-02 against the Elements fixture: `files.export` as
`text/markdown`, import the result as a new Doc, export again.

- Nested lists come out wrapped in `>` blockquote markers and lose their
  nesting on the second trip.
- A `|` inside a table cell is not escaped; the round trip **drops a cell**.
- Consecutive paragraphs are joined into one paragraph with hard breaks.
- Headings gain `**` markers, Heading 6 gained `***` on the round trip.
- Underline, code font, page breaks, alignment and Title/Subtitle styles
  are gone, with nothing to carry them.
- The first round trip is not identical; it converges on the second, after
  losing data.

It is a convenience export, not a document model. The Docs API is the only
path that is lossless for what the dialect carries and that can be made
canonical. Phase 3 needs the Docs API anyway.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| APIs | Drive v3 for listing, download and export; Docs v1 `documents.get` for Doc content. Plain `fetch`, no Google SDK. | The Google SDKs are large and pull in their own auth; two endpoints do not justify them. |
| Listing | `files.list` with `'<id>' in parents and trashed=false`, `fields` limited to id, name, mimeType, modifiedTime, lastModifyingUser, md5Checksum, size; `supportsAllDrives` and `includeItemsFromAllDrives` on | Shared drives must work from day one. |
| Change detection | `modifiedTime`, plus `md5Checksum` for binaries | Cheap and reliable. |
| Exports | Sheet → `.xlsx`, Slides → `.pptx`, Drawing → `.svg` via `files.export`; index marks them read-only | Manual §6. |
| Binaries | `files.get?alt=media`, bytes as-is | Manual §6. |
| Title and Subtitle | The block-attributes comment, not a frontmatter flag: `<!-- docsync: style=title -->` above `# …`, `style=subtitle` above `## …` | One mechanism for all block attributes, as with Notion. Manual updated. |
| Code font | A run in Courier New, Roboto Mono, Consolas, Source Code Pro or Menlo is inline code | The only signal Docs has. Listed in one constant. |
| Lists | Bullet vs ordered vs checklist from `doc.lists[listId].listProperties.nestingLevels[level]` glyph; nesting from `nestingLevel` | This ticket must record in the Outcome how a checklist item actually appears in the API (it is not documented well). |
| Soft line break | A vertical tab (U+000B) in a text run → two trailing spaces and a newline | Manual §6 (same rule as Notion). |
| Merged cells | A table with any `rowSpan` or `colSpan` above 1 becomes one placeholder | Manual §6. |
| Images | Placeholder `<!-- docsync:object gdocs:<objectId> type=image -->` in phase 1 | Attachments are phase 2. |
| Not represented | text colour, highlight, font, size, alignment, indentation | Manual §6 and §7. Dropped on fetch, lost on push in phase 1. |

## Module

`src/gdrive/`:

| File | Purpose |
|---|---|
| `api.ts` | `listFolder` (paginated), `getDocument`, `download`, `export`, `getFile`; retry on 429 and 5xx with backoff, max 3; injectable `fetch`. |
| `walk.ts` | Root ref → tree, recursing folders, applying `isIgnored` with ancestors, classifying each file as doc, export, binary or skipped (Google types with no export: forms, sites, maps), naming via `assignNames` with the extension per type. |
| `to-markdown.ts` | Docs API document → mdast → text via `src/markdown.ts`. One function per structural element and one for text runs. |
| `index.ts` | `fetchRoot(root, provider, previousIndex)` with the same return shape as the Notion adapter, so ticket 09 treats both alike. |

Shared with Notion and reused, not duplicated: `src/markdown.ts`,
`src/frontmatter.ts`, the index entry type.

## Tests

- `to-markdown` against every fixture Doc: snapshot reviewed by eye once,
  then locked; one unit test per element type on a minimal document.
- Text runs: each style alone and combined, a link with styles, code font,
  a run with colour that must produce plain text.
- Lists: nesting, ordered restart, checklist checked and unchecked.
- Table with merged cells → placeholder; table with a pipe in a cell escaped.
- `walk`: recursion into `Sub`, ignore by path and by ref, Sheet classified
  as export, `plain.txt` and `dummy.pdf` as binaries, a Google Form as
  skipped (construct the listing by hand).
- `api`: pagination across two pages, a 429 with retry, a 5xx retried then
  succeeding, all against a mocked `fetch`.
- The 07 + 08 round-trip test written as `it.skip`.

## Done when

`pnpm check` green, every fixture Doc converts, the manual's Google Docs table
matches the tests, and the Outcome records the checklist representation and
anything else the Docs API did that the manual did not anticipate.

## Outcome

Landed 2026-09-03. Five agent commits plus the landing commit.

- **Modules as planned** in `src/gdrive/`: `api.ts` (`createGDriveApi` with
  `listFolder`, `getFile`, `getDocument`, `download`, `export`; retries with
  `Retry-After`), `to-markdown.ts` (`documentToMarkdown`, `documentToMdast`,
  `CODE_FONTS`), `walk.ts` (`walkRoot`, `EXPORTS`), `index.ts` (`fetchRoot`
  with the Notion adapter's shape). `Editor` moved to `src/index-file.ts`;
  `IndexEntry` gained `readOnly` (exports) and `md5` (binaries). A fetched
  file carries `text` or `bytes` only when `changed` is true.
- **Fixtures recorded** in `src/gdrive/__fixtures__/` (listings, seven Doc
  JSONs, the Sheet export, the binaries). Drive was never written to.
- **How the hand-added elements arrive:** Title/Subtitle are
  `namedStyleType` TITLE/SUBTITLE; a page break, a rule, an image and a
  footnote marker are all *inline* paragraph elements (a page break splits
  its paragraph); a footnote is `footnoteReference` with the body under the
  document's `footnotes`; an image is an `inlineObjectElement` resolved via
  `inlineObjects`; a comment does not appear in `documents.get` at all.
- **Checklist representation:** a list whose nesting level has
  `glyphType: GLYPH_TYPE_UNSPECIFIED`, `glyphFormat: "%0"` (`%1`, `%2`
  deeper) and no `glyphSymbol`. The API does not say which box is ticked:
  the two fixture items are byte-identical in every view mode. Every item is
  fetched as `- [ ]`. Manual §6 updated.
- **Surprises:** HTML-imported lists carry no glyph data at all, so a
  numbered list from the creation script is indistinguishable from a bullet
  list (the Elements snapshot shows it as bullets); the imported `<br>`
  became two paragraphs, so no vertical tab exists in the recording (the rule
  is unit-tested only); code fonts arrive lower-cased; a structural element
  has no id, so placeholders address it as `gdocs:<documentId>#<startIndex>`.
- **Follow-up for the owner:** retype the numbered list and the soft line
  break in the Elements Doc by hand, then re-run
  `scripts/record-gdrive-fixtures.ts` and update the snapshot.
- **Manual changes at landing:** §6 checklist ticked state, page break
  inside a paragraph, Google placeholder spellings; §7 checksum comparison
  for binaries.
