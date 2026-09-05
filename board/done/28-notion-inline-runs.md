# 28 — Notion inline runs: edge spaces and adjacent styles

Phase 1. Manual §6 dialect (inline rules).

## Problem

Notion stores a paragraph as runs, and splits a bold sentence around a
link into several bold runs: `Send the ` / link `info / asset request` /
` ` / `early` / `.`. The converter wraps each run on its own, so the file
reads

    **Send the&#x20;**[**info / asset request**](…)**&#x20;****early****.**

with a bold space encoded as `&#x20;` and `****` where two bold runs meet.
The Docs converter got the edge-space rule on 2026-09-04 (commit
`0137c02`); the Notion one has neither rule.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Edge spaces | As on Docs: a styled run sheds its leading and trailing spaces unstyled, and wraps nothing when nothing is left. The link, if any, goes around the pieces | A bold space is invisible in Notion. |
| Adjacent runs | Runs whose annotations and link are identical are merged before conversion, so `**early**` and `**.**` become `**early.**`, and a bold run before a bold link stays separate (the link differs) | Notion itself renders them as one; the Markdown should read as one. |
| Push | The push-time comparison converts the live page with the same code, so base and live agree. `mergeRichText` (ticket 15) already writes a block whole when the diff's text and the live runs disagree; check that merged runs do not trip it, and add a test | Consistency. |
| Round trip | The Prettier-stable and round-trip suites stay green; the recorded fixture snapshot changes where it had such runs | Manual §6 promises Prettier stability. |

## Module

| File | Purpose |
|---|---|
| `src/notion/to-markdown.ts` | `inlineFrom` (or wherever runs become mdast): merge adjacent identical runs, then shed edge spaces per run. |
| `src/notion/to-markdown.test.ts`, `rich-text-merge.test.ts` | The cases above, including the exact sentence from the problem. |

## Done when

`pnpm check` green; the sentence above converts to
`**Send the** [**info / asset request**](…) **early.**`.

## Outcome

Landed as `f5225d1`. `inline()` merges adjacent runs that agree on every
annotation and on their link before conversion; mentions and equations stay
atomic. `annotate()` sheds a run's edge spaces when bold, italic or
strikethrough would open on one, wraps what is left, and the link goes
around all the pieces. Deviation from the ticket, deliberate and tested:
underline and colour do not trigger shedding, because `<u>` and `<span>`
hold a space and zeroing them would drop the colour of the shed space. Code
runs keep their spaces. The push-time `mergeRichText` compares plain text,
which neither rule changes; a test proves the live bold spaces survive an
edit next to them. No snapshot moved. Verified on the owner's checkout with
`docsync fetch --all`: the Pre-discovery sentence now reads
`**Send the** [**info / asset request**](…) **early.**`.

Follow-ups: a bold code run with edge spaces still prints padded and
escaped; a mention whose label has edge spaces still prints `&#x20;` under
emphasis (theoretical, Notion trims titles). The remaining `&#x20;` in the
owner's checkout are unstyled trailing or leading spaces of a block, and
`\*\*\&#xA;\*\*` is a Docs bold run holding only a newline: ticket 30.
