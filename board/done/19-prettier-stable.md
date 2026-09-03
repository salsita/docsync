# 19 — A Prettier-stable dialect

Phase 1. Manual §6 (inline rules, "Formatters and editors").

## Goal

Formatting a fetched file with Prettier's defaults changes nothing, and a
test keeps it that way.

## Scope

- `src/markdown.ts`: `emphasis: '_'`; the hard-break handler writes a
  backslash and a newline instead of two spaces. Both parsers already accept
  the old spellings; add a test in each direction that they still do.
- Re-record nothing: the fixtures hold source JSON. Update the Notion and
  Drive snapshots and any unit test that spelled italic or a hard break.
- `src/markdown.prettier.test.ts`: for every fixture page and Doc, run
  Prettier (pinned dev dependency, default options, `proseWrap: preserve`
  explicit) over the canonical Markdown and assert byte equality. Also over
  a hand-written document that exercises every dialect construct in the
  manual's tables, so the test does not depend on what the fixtures happen
  to contain.
- Table padding with emoji and CJK: include a table with both in the
  hand-written document; if Prettier pads differently, set the stringifier's
  `stringLength` to the same width function Prettier uses.

## Not here

`docsync init` writing `.prettierrc` and `.editorconfig` belongs to ticket 10.

## Done when

`pnpm check` green, the Prettier test passes, and the manual's inline rules
match what the snapshots show.

## Outcome

Landed 2026-09-03 in one agent commit (`f6e484e`). `pnpm check` green,
1029 tests.

- Italic `_x_`, hard break as trailing backslash, both old spellings still
  parsed, with tests in each direction. Bold italic now nests as `**_x_**`,
  which Prettier leaves alone; a spelling change in the snapshots only.
- One change beyond the ticket's two: **table padding by display width**.
  Prettier counts screen columns, remark counted UTF-16 units, so a CJK or
  emoji cell was re-padded on save. Fixed with `string-width` (pinned) as
  remark-gfm's `stringLength`; a new runtime dependency, the first besides
  the Markdown stack. Manual §6 says so now.
- `src/markdown.prettier.test.ts` runs Prettier 3.9.6 (pinned, dev-only,
  imported nowhere else) over every recorded page and Doc and over the
  hand-written `src/dialect.mock.ts`, which the round-trip test shares so
  the two cannot drift. Runs of two or more spaces inside a sentence are
  collapsed on both sides before comparing, the one divergence the manual
  documents.
- Everything else already matched Prettier: escaping, markers, fences,
  headings, links, placeholders.
