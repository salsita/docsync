# 41 — Suggestions land in the wrong place, and rewrite whole paragraphs

Phase 3. Manual §7 write-back (suggesting mode), §12 phase 3.

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

## Decisions

| Concern | Choice | Why |
|---|---|---|
| The source | Unchanged: the body is the Doc with every pending suggestion rejected; suggestions live in the sidecar. An edit is a diff against that text | The alternative makes every pending suggestion part of the base and turns a disagreement into an edit war in the body. |
| Another author's suggestion in the way | A **competing suggestion**: the planner maps the edit onto the live Doc with other authors' suggested insertions skipped over, since they are not in the base, and suggests only against original text. Deleting the same original word someone else already suggested deleting is allowed, the API stacks deletion ids on a run; inserting beside their insertion is allowed. The reviewer sees both proposals and picks one | Honest, and never rewrites a client's suggestion. |
| Never | Deleting or otherwise touching another author's suggested text; falling back to a whole-block replacement because suggestions are in the way | The two faults of 2026-09-16. |
| Cannot be expressed | Refused by name before any request goes out: "`<path>`: the edit at `<quote>` cannot be suggested beside the pending suggestion `<id>` by `<author>`; accept or reject it in Docs first" | Say what to do. |
| Block alignment | Base block *n* is live block *n* has to hold on a Doc with empty paragraphs, paragraphs that are pending suggested insertions, runs that are pending suggested deletions, and placeholders; find the case that breaks it and pin it with a test that asserts every planned range lands inside the block it was meant for | Faults 2 and 3. |
| Appended list item | No empty paragraph before or after a new last item | Fault 4. |
| Plain (non-suggest) push | The same alignment fix applies; a plain write over a paragraph holding someone else's pending suggestion is refused with the same message, since a plain write would silently discard their proposal | Consistency; today it is undefined. |
| Own pending suggestions | An edit over text the same account already suggested is the same case: a second competing suggestion, not a rewrite of the first | Keep one rule. |

## Module

| File | Purpose |
|---|---|
| `src/gdrive/ranges.ts` | The live block list and its ranges: the alignment fix; pieces that know which characters are another author's suggested insertion or deletion. |
| `src/gdrive/patch.ts` | The character diff and the requests planned around foreign suggested runs; the refusal; the appended-item fix; no whole-block fallback in suggesting mode. |
| `src/gdrive/to-markdown.ts` | Whatever provenance the pieces need (`provenance: true` already carries ranges). |
| `src/gdrive/push.ts` | The refusal surfaces as a `PushError` naming path, quote, suggestion id and author. |
| `src/gdrive/docs-model.mock.ts`, `fake-api.mock.ts` | The fake carries other authors' pending insertions and deletions in a paragraph, empty paragraphs, suggested paragraphs, and stacks deletion ids. |
| `scripts/gdocs-competing-suggestion-smoke.ts` (new) | Creates its own Doc in the fixture folder, suggests `one`→`three` as one identity, then pushes `one`→`two` as an edit in suggesting mode, verifies the run carries both deletion ids and both insertions, verifies a paragraph placed after an empty paragraph, a suggested paragraph and a list lands where the Markdown put it, and trashes the Doc. |
| Tests | The four layouts of the report reproduced on the fake, each failing before the fix: a) an in-paragraph edit beside a foreign suggestion becomes a competing suggestion of the changed words only, both deletion ids on the run, the foreign insertion untouched; b) a placeholder paragraph replaced after two ordinary paragraphs lands on the placeholder in a Doc with empty and suggested paragraphs earlier; c) a paragraph inserted after a list that carries a suggested item lands after the list; d) an appended list item adds no empty paragraph; plus the refusal case (an edit that would have to delete a foreign insertion), the plain-push refusal, an own-suggestion competing case, and an invariant test over a generated Doc: every range in a plan lies within the live block its base block maps to. |

## Done when

`pnpm check` green; the smoke script passes on the real API; the four
layouts of the report, rebuilt in the fake, produce the expected
suggestions and nothing else.
