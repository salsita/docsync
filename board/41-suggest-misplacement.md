# 41 — Suggestions land in the wrong place, and rewrite whole paragraphs

Unrefined. Phase 3. Manual §7 write-back.

## What happened (2026-09-16, a suggesting push to a real contract Doc)

Three faults in one push, all on a Doc that already carried pending
suggestions and had been pushed to as suggestions before:

1. **Whole-paragraph rewrite.** The owner changed `one (1) year` to
   `two (2) years` inside a long paragraph. The paragraph already carried
   three pending suggestions by the client, two of them on exactly those
   words (`one`→`three`, `(1)`→`(3)`) and one elsewhere. docsync's
   suggestion deleted the entire paragraph, the client's suggested
   insertions included, and inserted the whole new text (`suggest.k5m9301fxk5r`
   over `suggest.vv1glubeyq1b`, `suggest.frjnz76h4q08`, `suggest.y6inzl6rlffl`;
   the paragraph's runs carry all four ids). Expected: one small suggestion
   on the changed words, or a refusal saying the words are under someone
   else's suggestion.
2. **A block landed two paragraphs early.** The edit replaced a one-line
   placeholder paragraph (`<portal>`, written `\<portal>` in Markdown) with a
   sentence. The suggestion (`suggest.7zgaej5upr8d`) deleted the first eight
   characters (`If any o`, the placeholder's length) of a paragraph two blocks
   *earlier* and inserted the sentence there; the placeholder is untouched.
   The two paragraphs in between are ordinary text, not suggestions. The
   Doc's layout there: `… list of six items | If any of those … | ERP and
   CRM … | <portal> | [page break] | # Custom Outputs`.
3. **An inserted paragraph landed inside a list, three blocks early.** A new
   paragraph written after `The remainder follows …` (which follows a
   three-item numbered list) was inserted between items 2 and 3 of that
   list, as a whole-paragraph suggested insertion (`suggest.4y8a59bxlo24`).
   Layout there: `⏎ (empty paragraph) | item 1 (carries a pending suggestion
   from an earlier push) | item 2 | item 3 | ⏎ (empty paragraph) | The
   remainder … | ## Platforms`. In the same push item 3 gained the word
   `portal`, correctly placed.
4. **An extra empty line.** A new numbered item appended at the end of a
   list (`8. **Migration Assistance.**`) arrived with an empty paragraph
   before it.

Faults 2 and 3 are block-position errors, not character shifts: the
distance from the intended to the actual spot is exactly two, respectively
three, whole paragraphs, and the region holds empty paragraphs (`⏎`) and
paragraphs that are pending suggested insertions. The base check passed,
so the Markdown of the live body equalled the base: whatever is
misaligned is between the block list the diff works on and the live
ranges the planner addresses, in a document where some live paragraphs
(empty ones, suggested ones) have no block in the Markdown, or the other
way round.

## To find out

- How `readLive` / the planner map base block *n* to a live range when the
  live document holds paragraphs that the converter drops (empty
  paragraphs) or that are pending suggested insertions read in
  `SUGGESTIONS_INLINE` mode, and paragraphs whose runs are pending
  suggested deletions.
- Why an in-paragraph edit next to another author's pending suggestion
  becomes a whole-paragraph replacement (the islands rule of ticket 33, or
  the character diff failing on the inline suggested text).
- Where the empty paragraph before an appended list item comes from
  (§7: "at the end of a list, after the last one").
- Reproduce all four on the fake Docs model with these layouts, then the
  live smoke on a Doc the script creates.

## Rule to decide

An edit inside a paragraph that carries someone else's pending suggestion:
patch around it, or refuse by name ("… is under a pending suggestion by
<author>; accept or reject it in Docs first")? The owner's call. Until
fixed, a suggesting push to a Doc with pending suggestions is unsafe.
