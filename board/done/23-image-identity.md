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

## Outcome

Landed as `3d31bb3`. `src/diff/text.ts` exports `OBJECT_REPLACEMENT`
(U+FFFC); an image is that one character in both `plain` and the inline
runs, with the URL carried on the run's new `image` field and no link. The
block identity already was the block's Markdown, which holds URL and alt,
so nothing changed there. `src/gdrive/to-markdown.ts` gives an inline
object a text width of 1 instead of the alt's length, so the pieces agree
with the diff. `src/gdrive/patch.ts` cuts an inserted span at its images:
`insertText` around them, `insertInlineImage` at the index reached, styles
after the text; a deleted span already took the atomic piece with it.

Deviations, both accepted: an image whose file nobody staged, and an image
inside a whole-block rewrite or a fresh table cell, is dropped and named in
the report rather than written as its alt or the character. And
`src/notion/rich-text-merge.ts` gained a guard: Notion stores an inline
image as its link text where the diff now counts one character, so a block
holding one is written whole instead of cut at the diff's offsets, and
U+FFFC never reaches Notion.

Fourteen tests added, all through the fake Docs model or the pure diff.
Manual §7 reworded: an image is created from its staged file, an unstaged
one is dropped, an alt-only edit sends nothing. No smoke run; `replaceImage`
for changed bytes stays the ticket 14 follow-up.
