# 16 — Diff-based write-back: Google Docs

Phase 3. Manual §7 "Write-back", §12 phase 3. Builds on ticket 15's
`src/diff/`.

## Goal

A push changes only the characters that changed. Colours, fonts, sizes,
alignment, inline images, footnotes, page breaks and comment anchors on
untouched text survive. An edited paragraph keeps everything outside the
edited characters.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Identity | Same as 15: `documents.get` with `suggestionsViewMode=SUGGESTIONS_INLINE` (ticket 17 needs the same response), body derived by dropping suggested insertions and keeping suggested deletions, converted with `to-markdown`, and required to equal the base body. Each base block maps to the live structural elements it came from, with their index ranges. Mismatch refused with "the source changed" | Push step 1 guarantees it; the check is local. |
| Requests | One `batchUpdate`, requests ordered by descending index so earlier ranges stay valid: for an updated paragraph, `deleteContentRange` per deleted span and `insertText` per inserted span (inserted text inherits the style of the character before it), then `updateTextStyle` for dialect-owned attributes (bold, italic, strikethrough, underline, link, code font) over the spans whose style changed, with `fields` naming only those attributes; for an inserted block, the same requests `from-markdown` makes today, at the aligned index, including `createParagraphBullets` and named styles; for a deleted block, one `deleteContentRange` over its elements | Colours, fonts, sizes and alignment are never in `fields`, so they survive. |
| Block structure changes | A paragraph turned into a heading is `updateParagraphStyle` with `namedStyleType`, not a rewrite. A list item that stops being one is `deleteParagraphBullets`. A type change the API cannot express is delete and insert | Keeps the text, and the comments on it, wherever the API allows. |
| Tables | Rows and cells diffed recursively; a cell's paragraphs patched in place; added or removed rows via `insertTableRow` / `deleteTableRow`; column count change is a table rewrite, said in the report | Cell-level patching is what keeps a formatted contract table intact. |
| Suggestions | An edit inside a paragraph that carries a pending suggestion rewrites the suggested range as plain text, which resolves the suggestion by overwriting. The report names the suggestion ids it touched | The API cannot accept or reject (ticket 17). The manual says so. |
| Untouched inline objects | An image, footnote reference, page break or horizontal rule inside a kept span is untouched. Inside a deleted span it goes with the span. `from-markdown` cannot create a rule or an image, as today | The biggest phase-1 loss on Docs, gone for untouched text. |
| Footnotes | A kept footnote reference keeps its segment. An edited footnote body is patched inside its segment with the same text diff. A new footnote is created as today | Segments are documents of their own. |
| Whole-body replace | Retired for modified documents; `createDoc` keeps writing a fresh body | As in 15. |
| Report | `blocks` counts as in 15, plus `formatting kept` phrasing in the CLI | Same proof. |

## Module

| File | Purpose |
|---|---|
| `src/gdrive/ranges.ts` | Base block → live elements and index ranges, UTF-16 aware. |
| `src/gdrive/patch.ts` | Block ops + ranges → `batchUpdate` requests, descending. |
| `src/gdrive/write.ts` | `patchBody(documentId, ops, live)`. |
| `src/gdrive/push.ts` | Reads live, derives base, checks, diffs, patches. |

## Tests

- `ranges.ts`: every fixture Doc maps block by block; a paragraph split by
  a page break maps to two blocks with one element; surrogate pairs and
  emoji count as two.
- `patch.ts`: each op kind produces the expected requests in descending
  order; an edit in a red paragraph never names `foregroundColor` in
  `fields`; a paragraph with a footnote reference edited before the
  reference leaves it in place; heading promotion is one style request;
  table cell edit; row insert.
- `push.ts` against the fake Docs model (`docs-model.mock.ts`, extended to
  apply the new requests): base mismatch refused; each op; suggestion
  overwrite reported; counts.
- Round trip on every fixture Doc with one edit, through the fake model.
- Smoke script `scripts/gdocs-patch-smoke.ts`: creates its own Doc with a
  coloured paragraph, an image and a comment, patches another paragraph,
  verifies colour, image and comment anchor survive, trashes the Doc.

## Done when

`pnpm check` green; the smoke script passes; manual §7's Docs paragraph
lists only the remaining losses: formatting on rewritten characters, moved
paragraphs, rules and images the dialect cannot create.

## Outcome

Landed 2026-09-03 in five agent commits (`6da7f3f` … `b182813`) plus the
landing commit. `pnpm check` green, 1163 tests. The smoke script ran once
against a Doc it created and trashed: a red paragraph, an inline image and
a comment on untouched text all survived a push that updated two other
blocks.

Deviations and findings:

- **Provenance instead of a separate mapper.** `to-markdown` stamps every
  node with the live index range it came from and derives the base body
  (suggested insertions dropped, deletions kept) in the same pass, so the
  shared `flattenBlocks` gives base block *n* = live block *n* with ranges.
- **Restyle pairing.** The shared diff never pairs across types; `patch.ts`
  pairs a lone deleted paragraph-like block with the lone inserted one that
  follows and writes the difference as a paragraph-style or bullet request
  plus a text diff, with no similarity gate. Consistent with the one-for-one
  fallback added in ticket 15. A heading demoted to a paragraph keeps its
  text and anchors.
- **Suggestions at paragraph granularity:** an edit in a paragraph carrying
  a pending suggestion rewrites that paragraph's text; the ids are reported
  and, since landing, printed by the CLI under the document's line.
- Nesting changes on list items are delete-and-insert; a nested inserted
  item lands at its container's top level. A trailing append leaves one
  empty paragraph at the end of the body. Deleting the block after a page
  break leaves the break. All said in manual §7.
- Manual: §7 Docs paragraph rewritten, phase 3 marked done in §12.
