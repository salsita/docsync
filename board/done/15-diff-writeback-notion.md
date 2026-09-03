# 15 — Diff-based write-back: Notion

Phase 3. Manual §7 "Write-back" (rewritten with this ticket), §12 phase 3.

## Goal

A push patches only what changed. An untouched block keeps its id, its
comments, its history and every attribute the dialect cannot express. An
edited block keeps its id and everything outside the edited characters.
Nothing is written into the Markdown to make this possible.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Identity | None in the file. At push time the adapter re-reads the live page, converts it with `to-markdown`, and requires the result to equal the base body (the served commit's version, which the helper now passes as `FileChange.previousText`). Base block *n* is live block *n*. A mismatch is refused with "the source changed" | Push step 1 already guarantees live equals base; this check makes the guarantee local and cheap. The owner: no garbage in the file. |
| Block diff | `src/diff/blocks.ts`, shared with ticket 16: longest common subsequence over the top-level mdast blocks of base and new, a block's canonical Markdown as its identity. Inside each hunk, a removed and an inserted block of the same type whose plain text is at least 50% similar (git's rename measure) pair as **update**; an exact match elsewhere is **move**, everything else **delete** or **insert**. Recursion into list items, toggles and callouts on their children, and into tables on rows | It is `git diff` on blocks. Same trust, same failure modes. |
| Text diff | `src/diff/text.ts`: character-level diff of the plain text of an updated pair, tokenised on word boundaries, answering kept, deleted and inserted spans; plus the inline style difference (bold, italic, strikethrough, code, underline, link, colour span, mention, equation) per kept span | Selective replacement inside a paragraph, per the owner. |
| Update | The live block's rich-text runs are the base. Deleted spans are cut, inserted spans take the annotations of the run before them (the run after, at the start), style differences set only the annotation keys the dialect owns on the affected runs, and the merged array goes in one `PATCH /blocks/{id}` with the type-specific fields the dialect controls (`language`, `checked`, `color` when the attribute comment changed, `icon` for callouts). A mention or equation run is atomic: an edit touching it replaces it | Notion has no partial update; merging locally gives the same effect. Comments are per block, so they survive any update. |
| Type change | Delete and insert at the same position. New id | The API cannot change a block's type. |
| Insert | `PATCH /blocks/{parent}/children` with `after` set to the live id of the preceding kept block (absent for the first position), chunked and laid out as `write.ts` already does for deep children | Position without rewriting the neighbours. |
| Delete, move | `DELETE /blocks/{id}`; a move is a delete and an insert. New id, comments lost, said in the manual | No move call. |
| Untouched placeholders | A placeholder block (bookmark, embed, synced block, column list…) that is unchanged is kept as is. Changing its text is refused with the block type named; deleting it deletes the block | Today every push destroys them. |
| Overflow | An inserted or updated block past 100 runs follows ticket 18 when landed, and today's flattening until then | Unchanged. |
| Whole-page replace | Retired as the default. Kept in `write.ts` for `createPage` only | Nothing calls it for a modified page any more. |
| Helper | `FileChange.previousText` for `modified` and content-changing `renamed`, read from the served tree in `src/helper/changes.ts` | Both adapters need the base. |
| Report | `PushedDocument` gains `blocks: { kept, updated, inserted, deleted }` and the CLI prints `updated (3 blocks changed, 41 kept)` | The number is the proof the diff worked. |

## Module

| File | Purpose |
|---|---|
| `src/diff/blocks.ts`, `text.ts`, `similarity.ts` | Pure, over mdast; no source knowledge. |
| `src/notion/patch.ts` | Live blocks + block ops → API calls, in order: updates, then inserts bottom up, then deletes. |
| `src/notion/rich-text-merge.ts` | Text edits and style differences applied to live runs. |
| `src/notion/write.ts` | `patchBody(pageId, ops)`; `replaceBody` no longer used by push. |
| `src/notion/push.ts` | Reads live, checks base, diffs, patches. |

## Tests

- `blocks.ts`: unchanged; one paragraph edited; paragraph inserted at start,
  middle, end; deleted; moved; two adjacent edited; heading turned into a
  paragraph (type change); nested list item edited without touching its
  siblings; table cell edited; a hunk where similarity pairing must choose
  between two candidates.
- `text.ts`: a word replaced; text inserted at start and end; a whole
  sentence rewritten; only formatting changed (bold added); a link target
  changed; a mention deleted; CJK and emoji.
- `rich-text-merge.ts`: coloured run survives an edit elsewhere in the block;
  inserted word inherits red; bold added to part of a red run splits it;
  an edit across a mention replaces it; 2000-character run splitting still
  holds.
- `push.ts` against the fake API: each op kind becomes the expected calls and
  nothing else; base mismatch refused; placeholder kept, edited placeholder
  refused; report counts.
- Round trip on every fixture page: fetch, change one block, push through
  the fake API, fetch, compare.
- A real-workspace smoke script (`scripts/notion-patch-smoke.ts`) that
  creates its own page, adds a comment on one block through the API,
  patches another block, verifies the comment survived, and archives the
  page. Board rule: it cleans up.

## Done when

`pnpm check` green; the smoke script proves a comment on an untouched block
survives; manual §7 says what survives and what does not, per the table
written at dispatch.

## Outcome

Landed 2026-09-03 in seven agent commits (`d7cab56` … `ba520bc`, `a44c0c8`)
plus the landing commit. `pnpm check` green, 1110 tests. The smoke script
ran once against a page it created and archived: a comment on one block
survived a push that updated, inserted and deleted other blocks; 5 of 6
block ids kept.

Deviations and findings:

- **Notion cannot insert before a block.** The children endpoint takes only
  `after`, so a prepend is written as the new block plus a rewritten copy of
  the old first block, and the original is deleted. One id lost per prepend.
  Manual §7 says so.
- **Pairing fallback.** Git's 50% similarity threshold made a short block
  (`Two.` → `Two, edited.`) a delete and insert. Added at review: when
  exactly one removed and one inserted block of the same type remain in a
  hunk, they pair as an update. Losses remain only inside hunks with several
  candidates of the same type.
- `flattenBlocks` turns mdast into the blocks a source holds (one per list
  item, table rows as children, attribute comments folded in) so ops line up
  positionally with live blocks. Text diff tokenises with `Intl.Segmenter`
  (CJK, emoji) and coalesces a rewritten stretch into one delete + insert.
- The live-equals-base check compares both sides after a parse and
  stringify, because the callout marker is written unescaped and re-parses
  escaped.
- A modified page with no `previousText` is refused, no fallback to
  `replaceBody`; `replaceBody` remains for page creation and the second
  pass that fills links on newly created pages.
- Untouched empty paragraphs and placeholder blocks now survive a push;
  editing or moving a placeholder is refused. Manual §6 and §7 updated.
- The agent piped one smoke run through `tail`, against the board rule; it
  ran once and cleaned up. Repeated in the dispatch brief next time.
