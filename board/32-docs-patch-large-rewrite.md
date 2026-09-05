# 32 — Docs patch: page breaks, list structure and escapes in a large rewrite

Phase 3. Manual §6 (page break row), §7 push steps 5–6 (diff-based write-back).

## Problem

On 2026-09-05 the owner pushed a rewrite of the Discovery Inputs Doc (base
`c0cf034`, pushed `db67b3d` in the kickoff checkout; the fetch after the
push is `b543db6`). The Doc came back different from what was pushed:

1. **Page breaks.** The base had one, after the "Any questions…" paragraph.
   The push inserted a whole section before it and a second page break
   further down. At the source the existing break stayed glued to the
   paragraph before it, so it now precedes the inserted section instead of
   following it, and the new break was never created.
2. **Deleted nested items survived.** The push deleted the `3D assets`,
   `Branding` and `Integration` items with their nested children. The
   parents went; the children (`3D models`, `Textures`, `Visual references…`,
   `A source from which…`, `Very project-dependant…`) stayed and now hang,
   nested, under the last bullet of the document.
3. **Escape churn.** `ALUMINUM_FENCE-25-26-WEB-150dpi.pdf` was pushed
   unescaped and came back as `ALUMINUM\_FENCE-…`, a change nobody made.

The two versions are in `src/gdrive/__fixtures__/push-discovery-base.md`
and `push-discovery-next.md`. Seeding the base into the in-memory Docs
model (`docs-model.mock.ts`, as `push.test.ts` `seed` does) and pushing
`next` over it reproduces 1 and 3 exactly (no `insertPageBreak` request is
issued at all) and shows a fourth defect the real Doc did not: a top-level
bullet loses its bullet and its nested items are flattened to top level. The
base does not round-trip through `seed` byte for byte (two blank lines after
the `\` + `&#x20;` items are lost), so the reproduction uses the seeded text
as its base.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Reproduction first | `push.test.ts` gains the case: seed `push-discovery-base.md`, push `push-discovery-next.md` over the seeded text, expect the read-back to equal `next`. Red before any fix | The whole ticket is this test going green. |
| Page break as a block | The diff must treat `<!-- docsync:pagebreak -->` as its own block with its own range: insert before it lands before it, a new one issues `insertPageBreak`, deleting one deletes the break and not the paragraph it splits | Manual §6: a page break is a block in the dialect. |
| List deletions | Deleting a list item deletes its nested items with it when the diff says so; a nested item that survives must keep its level and bullet. Check the descending-index grouping in `patch.ts` against paragraphs whose bullet is set by `createParagraphBullets` on a range: a delete that removes the parent's range may leave the children's bullet preset behind, and `deleteParagraphBullets`/nesting must be re-applied to what remains | Cause of 2 and of the fake's fourth defect. |
| Escapes | The stringifier escapes `_` inside a word only when an adjacent run boundary makes it ambiguous; find why the read-back differs from what was pushed and make the push-time comparison and the fetch agree, so a pushed word is fetched back byte-identical | Cause of 3. |
| The fake model | Where the fake and the real Doc disagree (defect 4), fix the fake to match Docs, proven with the smoke script below | Tests are only as good as the model. |
| Smoke | A script under `scripts/` that copies a Doc built from `push-discovery-base.md` into the Docsync test folder, pushes `next` with the real API, fetches, diffs against `next`, and trashes the copy. Run by the agent before and after the fix; output in the report | The real API is the judge. Fixture folder is otherwise read-only. |

## Module

| File | Purpose |
|---|---|
| `src/gdrive/patch.ts`, `ranges.ts` | Page break as a ranged block; list deletion and nesting. |
| `src/gdrive/from-markdown.ts` | `insertPageBreak` in a patch, not only in a full write. |
| `src/gdrive/to-markdown.ts` or `src/markdown.ts` | The `_` escape. |
| `src/gdrive/docs-model.mock.ts` | Whatever the smoke script proves wrong. |
| `src/gdrive/push.test.ts`, `patch.test.ts` | The reproduction, plus minimal cases for each of the three defects. |
| `scripts/smoke-gdrive-patch.ts` | The real-API check. |

## Done when

`pnpm check` green with the reproduction test; the smoke script's diff is
empty; the owner re-pushes the Discovery Inputs rewrite and the fetch after
it changes nothing.
