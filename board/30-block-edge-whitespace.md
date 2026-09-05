# 30 — Block-edge whitespace: trailing spaces and whitespace-only runs

Phase 1. Manual §6 dialect (inline rules).

## Problem

After tickets 26 and 28 the owner's checkout still shows two artifact shapes:

    Next step: [Contract](Contract.md)&#x20;
      - &#x20;SA: Creates the estimate …
    \*\*\&#xA;\*\***Integration & Finalization**:&#x20;

The first two are an unstyled space at the end or the start of a paragraph,
list item or heading; the stringifier has to encode it or it would be lost.
The third is a Docs bold run holding only a newline, which the edge-space
rule (bold, `0137c02`) leaves as `**\n**`, then escaped by the writer. All
are invisible at the source.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Block edges | Both converters trim spaces (not other characters) at the very start and very end of a block's inline content, after runs are merged and shed. Table cells the same | A trailing space is invisible at the source and the encoding is noise in every diff. |
| Whitespace-only runs | A styled run whose content is only spaces and newlines contributes its newlines as line breaks unstyled, as the shed rule does for spaces | A bold newline is not a thing. |
| Push | The push-time comparison converts the live block with the same code, so base and live agree; a trimmed base never counts as an edit. `mergeRichText` compares plain text, so a trailing space at the source survives an unrelated edit | No churn at the source. |
| Round trip | Prettier-stable and round-trip suites stay green | §6 promises Prettier stability. |

## Module

| File | Purpose |
|---|---|
| `src/notion/to-markdown.ts`, `src/gdrive/to-markdown.ts` | Trim at the block edge; whitespace-only styled runs. |
| Their tests | The three shapes above, verbatim, and a table cell with a trailing space. |

## Done when

`pnpm check` green; `docsync fetch --all` on the owner's checkout leaves no
`&#x20;` and no `\*\*` in any document that has none of those at the source.
