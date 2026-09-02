# 08 — Google Drive adapter: write

Phase 1. Manual §7 (push, write-back, deletion).

## Goal

Apply a per-root diff to Drive: Google Docs by whole-body replace, binaries
by uploading a new revision, exports refused. The exact inverse of ticket 07.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Parsing | `parseMarkdown` from `src/markdown.ts` | One parser, as in ticket 06. |
| Replace | One `documents.batchUpdate`: `deleteContentRange` over `[1, endIndex-1)`, then the new body | Atomic per document; a failure leaves the document untouched. |
| Insertion order | Blocks are inserted **in reverse, each at index 1**, with that block's styling requests immediately after its `insertText` in the same batch | Every request then addresses indices that are known at generation time, and inserting a table or a page break never shifts anything already emitted. |
| Indices | UTF-16 code units, computed with `string.length` on each inserted segment | The Docs API counts UTF-16, so an emoji is two. |
| Headings, Title, Subtitle | `updateParagraphStyle` with `namedStyleType` | Title/Subtitle come from the `style=` attribute comment (manual §6). |
| Lists | Nesting expressed as leading tabs in the inserted text, then `createParagraphBullets` with `BULLET_DISC_CIRCLE_SQUARE` or `NUMBERED_DECIMAL_ALPHA_ROMAN`; checklists via the checkbox preset **if the API offers one**, otherwise a bullet list and a note in the Outcome | Ticket 07's Outcome says how checklists look on read; this ticket finds out whether they can be written. |
| Inline styles | `updateTextStyle` per run: bold, italic, underline, strikethrough, link; inline code → `weightedFontFamily` Courier New | The read side treats a monospace family as code (ticket 07). |
| Tables | `insertTable` at index 1, then cell text inserted from the last cell backwards using the deterministic cell index layout, then cell styling | Same reverse-order principle inside the table. |
| Horizontal rule | Cannot be created through the Docs API. Dropped on push, listed in the manual as a phase-1 loss. | API limitation. |
| Page break | `insertPageBreak` | |
| Footnotes | `createFootnote`, then the footnote body inserted into the returned footnote segment in a second batch | Footnote segment ids are only known after creation. |
| Images and other placeholders | Dropped on push (full replace) | Manual §7. |
| Binaries | `files.update` with `uploadType=media` on the same file id | New revision, same id, sharing and comments preserved. |
| Exports | Push refuses `.xlsx`, `.pptx`, `.svg` files that the index marks read-only, naming the file | Manual §7. |
| Create | `files.create` with the Doc mime type under the parent folder the path implies, then the same batch as replace; binaries via multipart upload with `parents` | Manual §6. |
| Rename and move | `files.update` with `name`, `addParents` and `removeParents` | Renames of Markdown files come from frontmatter `title`; a path change within the root is a move. |
| Delete | `files.update` with `trashed: true` | Reversible (manual §8). |

## Module

`src/gdrive/`:

| File | Purpose |
|---|---|
| `from-markdown.ts` | mdast → an ordered list of "segments", each with its text and the batchUpdate requests that style it, plus a function that turns the segment list into the final request array in reverse order. Pure, no I/O. |
| `write.ts` | `replaceBody(docId, tree)`, `createDoc(parentId, name, tree)`, `uploadRevision(fileId, bytes)`, `createFile(parentId, name, bytes, mime)`, `rename`, `move`, `trash`. Each returns what happened for the push report. |
| `push.ts` | `pushRoot(root, changes, provider, index) → report`, the same shape as the Notion one so ticket 09 treats both alike. |
| `api.ts` | Extended from ticket 07 with `batchUpdate`, `createFile`, `updateFile`, media and multipart upload. Same retry policy. |

## Tests

- `from-markdown`: one unit test per element asserting the exact request
  JSON for a minimal document, with indices checked by hand; an emoji
  paragraph to prove UTF-16 counting; a nested list; a table with three
  rows; a document whose blocks would collide if inserted in forward order.
- Round trip: enable the skipped test from ticket 07. For every fixture Doc,
  document → Markdown → requests → (applied to an in-memory model of a Docs
  document) → Markdown must be identical. The in-memory model applies
  `insertText`, `deleteContentRange`, `updateParagraphStyle`,
  `updateTextStyle`, `createParagraphBullets`, `insertTable`,
  `insertPageBreak`; keep it small and test it separately.
- `write.ts` against a mocked `fetch`: replace deletes the body range first,
  create then style, refusal of a read-only export, binary upload sends the
  bytes with the right content type, trash sets the flag.
- `push.ts`: creates before moves, a rename with no body change makes one
  call, a moved file produces `addParents`/`removeParents`.

## Manual test

Against a **copy**: duplicate the "Docsync test" Drive folder from the UI
(or create "Docsync write test" beside it with a script, never inside the
original). Run each operation once: replace the body of the Elements copy,
create a Doc, rename it, move it into `Sub`, upload a new revision of
`plain.txt`, trash a file. Record in the Outcome what the Docs UI shows,
especially what the replaced Elements lost (rule, colours, fonts, image,
comment anchors).

## Done when

`pnpm check` green, the round-trip test passes for every fixture Doc, and
the manual test matches the manual's description of phase-1 write-back.
