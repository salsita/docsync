# 34 — A thread spans blocks

Phase 4. Manual §6 "Comments and suggestions".

## Problem

The sidecar is built one block at a time, and both kinds of thread can
cross a block boundary:

- A **suggestion** is one id in the Docs API, tagged on every run it
  inserted or deleted, and one card in Docs. When it spans paragraphs the
  sidecar prints one thread per paragraph under the same heading. The ticket
  33 smoke made 13 suggestions and got 106 threads.
- A **comment** on a selection that runs over a paragraph break quotes text
  the anchor search cannot find inside any single block, so the thread says
  `(not found)` and sorts to the end.

Grouping by block was a guess about what a thread looks like; the API says
what a thread is.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Unit | One thread per suggestion id, and one per comment, whatever it spans | That is what the source calls a thread. |
| Suggestion diff | The blocks the id touches, first to last, as they stand on the `-` side and as they read with that one suggestion accepted on the `+` side, one line per block. Blocks in between that the id does not touch are printed unchanged, without a sign. The whole diff, never summarised or capped | The reader is deciding whether to accept; a cut diff cannot support that. |
| Suggestion anchor | `in:` names the heading above the first touched block; order by the first block | Same rule as today, applied to the span. |
| Two ids in one block | Still two threads, each rendered with only its own changes applied | Unchanged. |
| Formatting-only suggestion across blocks | The quote is the touched blocks joined by a blank line, then `formatting only` | Unchanged rule, wider quote. |
| Comment anchor | `locate` also tries a run of consecutive blocks: the quote, whitespace collapsed, matched against the plain text of blocks *n..m* joined by a space. The thread quotes those blocks joined by a blank line, with the marks at the start of the first and the end of the last | The selection was one, so the quote is one. |
| Tables and lists | A block is what `locate` calls a block today: paragraph, heading, list item, table cell, code. A span may run from a list item into a paragraph | No new block notion. |
| Notion | Untouched: a Notion comment belongs to one block | Notion's model. |
| Fake Docs model | A `SUGGEST` batch already assigns one id per request; a request that inserts text with newlines or deletes across a paragraph break tags every run it touches with that id | Needed so the fake reproduces the 33 smoke. |

## Module

| File | Purpose |
|---|---|
| `src/gdrive/comments.ts` | `suggestionThreads` groups by id over the paragraph list; renders the span. |
| `src/comments/locate.ts` | Multi-block matching; `Anchor` gains the block count or the end offset. |
| `src/comments/format.ts` | A multi-line quote and a multi-line diff, if anything changes in how they print. |
| `src/gdrive/docs-model.mock.ts` | Ids across runs for a multi-paragraph suggesting request. |
| `scripts/smoke-gdrive-patch.ts` | The `--suggest` run reports distinct ids and thread count; done when they are equal. |
| Tests | A suggestion inserting two paragraphs is one thread with a two-line `+` side; one deleting across a break is one thread; two ids in one paragraph stay two threads; a comment quoting the end of one paragraph and the start of the next is found, quoted as both, marked across; the existing single-block cases unchanged; the sidecar snapshot for the 33 fixture on the fake has 13 threads. |

## Done when

`pnpm check` green; `node --experimental-strip-types scripts/smoke-gdrive-patch.ts --suggest`
reports as many threads as distinct suggestion ids, run by the owner or by
me; manual §6 says a thread spans the blocks its source says it does.

## Outcome

Landed 2026-09-08 in two agent commits (`619e92a`, `8063cda`) plus the
landing commit. `pnpm check` green, 1531 tests (+18).

- One thread per suggestion id over the span it touches; `before`/`after`
  are one line per block, untouched blocks in between printed unsigned; the
  anchor and order come from the first block. Two ids in one block stay two
  threads.
- `locate` also matches a quote over a run of consecutive blocks, shortest
  run wins; Notion passes `spans: false` and is unchanged.
- The fake Docs model needed no change; two tests pin that a multi-paragraph
  request tags every run with its one id. The fake gives one id per request
  (89 for the 33 rewrite) where the real API grouped 335 requests into 13, so
  the fake test asserts threads equal distinct ids rather than 13.
- Real-API smoke run after landing: 13 distinct ids, 13 threads, body moved
  0 lines, hunks up to 20 lines in one thread. Before this ticket the same
  run gave 106 threads.
- Manual §6 updated.
