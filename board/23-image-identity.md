# 23 — An image is always visible to the diff

Phase 3. Manual §7 "Write-back". Follow-up to ticket 14's Outcome.

## Problem

The block diff and the text diff work on a block's plain text, and an
image contributes its alt text to it. An image with an empty alt inside a
paragraph that also holds text (`See the chart. ![](X.assets/chart.png)`)
therefore leaves the text unchanged when added or removed: the block is
kept, no request is sent, and the post-push fetch reverts the local edit.

## Scope

- `src/diff/blocks.ts` `plain` and `src/diff/text.ts` `walk`: an image is
  one object replacement character (U+FFFC) in the plain text, and the block
  identity includes its URL and alt. This matches how Google Docs counts an
  inline object, one code unit, and how the ranges already treat it as
  atomic.
- Docs adapter: an inserted span that is the replacement character becomes
  `insertInlineImage` at that index; a deleted span covering it deletes the
  object. Notion adapter: an image inside a paragraph is not a Notion form,
  so nothing changes there beyond the identity.
- Tests, written first: adding and removing an empty-alt image inside a text
  paragraph produces exactly one insert or delete request on Docs; a changed
  alt on an existing image is a kept image (the API cannot set alt); an
  image on its own line still behaves as before; the Prettier stability and
  round-trip suites unchanged.

## Done when

`pnpm check` green; the cases above pass through the fake Docs model.
