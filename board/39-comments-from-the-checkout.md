# 39 — Comments written from the checkout

Unrefined. Waits for 37 (tabs); pairs with sidecar write-back (replies,
resolves, accept/reject of suggestions), which the roadmap lists under
Later.

## Goal

A new comment is authored in the body of a Google Doc's Markdown, on the
passage it is about, and a push creates it anchored there. Replies,
resolves and accept/reject stay in the sidecar, where the thread ids are.

## What the API offers (checked 2026-09-14)

The Docs API Developer Preview, which the project is enrolled in for
suggesting, adds `batchUpdate` requests: `insertComment` (content, a
`range` of start/end index, optional assignee email), `addCommentReply`
(with a RESOLVE / REOPEN action), `updateCommentPost`, `deleteComment`,
`deleteCommentReply`, `acceptSuggestion`, `rejectSuggestion`,
`deleteSuggestion`. Partial failures show in `commentUpdateState`, which the
suggesting push already checks.
https://developers.google.com/workspace/docs/api/how-tos/suggestions

## Syntax from the brainstorm

One-liner:

    The renewal keeps the <comment text="Say why." assign="a@b.com">10% cap</comment> in place.

Longer, a named tag and a fence holding plain text verbatim:

    The renewal keeps the <comment ref="cap">10% cap</comment> in place.

    ```comment cap
    First paragraph.

    Second paragraph, "quotes" and <brackets> untouched.
    ```

- One of `text` or `ref` on the tag; `assign` optional on either.
- The fence sits anywhere in the same file, by convention under the
  paragraph; one fence per name; a tag without its fence or a fence without
  its tag is a push refusal by name.
- A whole-block comment is the tag around the whole paragraph text.
- First version: a range inside one block, or a whole block.

## How a push does it

Strip tags and fences before the diff, remembering each range inside its
block. Patch the body as today. Re-read the Doc (the post-push fetch reads
it anyway), map each range to Docs indexes with the converter's offset map,
send one `insertComment` per tag in a second batch. The tag was never in the
Doc, so the next fetch clears it and the thread arrives in the sidecar.

A failed second batch fails the push loudly and prints the comment text,
because the next fetch would otherwise drop the tag silently.

## Open

- Suggest roots: commenting on text that is itself a pending suggestion
  needs a live check (inline view indexes).
- Notion cannot join: its API comments on a page or in a discussion, never
  on a range. Docs-only, and the manual says so.
- Whether the same ticket carries the sidecar write-back or a separate one
  does.
