# 42 — A line break beside a run boundary breaks the round trip

Phase 3. Manual §6 (canonical Markdown), §7 write-back (the base check).

## Problem

Reported from ticket 41's probing as "a soft line break followed by a
Markdown marker re-parses". Reproduced while refining, and the marker is not
the cause: `stringifyMarkdown` escapes `#`, `1.`, `-`, `>`, fences, rules,
table pipes and HTML after a hard break correctly. There are two real faults,
both in what the adapters hand the stringifier.

**Fault 1: an empty text node.** `textNodes` in `src/gdrive/to-markdown.ts`
splits a run at the vertical tab, so a run that *ends* in one (`"text\v"`,
with the next run holding the rest, which is what Docs stores whenever the
style changes or an edit began after the break) yields
`text, break, text("")`. `mdast-util-to-markdown` takes `before` from the last
output, the empty node makes it `''`, and everything that depends on knowing
a line just began is off:

| Tree (paragraph children) | Printed | Re-parses as |
|---|---|---|
| `text` `break` `""` `"# x"` | `text\⏎# x` | paragraph `text\` and a heading |
| the same with `1. x`, `- x`, `> x`, `+ x` | unescaped | paragraph and a list or quote |
| … with `---` or `===` | unescaped | a setext heading `text\` |
| … with four leading spaces | `    indented` | the spaces are lost |
| `text` `break` `""` `strong("# x")` | `text\⏎&#xNAN;**# x**` | a literal `&#xNAN;` in the file |
| `""` `"# x"` at the start of a paragraph | `# x` | a heading, and idempotent, so nothing catches it |

The Notion converter builds the same shape (`src/notion/to-markdown.ts`,
`[{ type: 'break' }, { type: 'text', value: line }]` per line of a rich text
item), so a Notion item ending in `\n` followed by another item has the same
fault.

**Fault 2: a line break at the very end of a block.** Markdown has no
spelling for it: `text\` and the end of the paragraph is a literal backslash.
So `text, break` prints `text\⏎`, re-parses as `text\\`, and the base check
refuses every push of the Doc. In a heading the break becomes a trailing
space and the heading prints as setext (`a ⏎--`); in a table cell it pads the
cell. A paragraph that is nothing but a break prints `\`.

## Decisions

1. **No empty text node reaches the stringifier.** The adapters do not emit
   one, and `stringifyMarkdown` drops any it is handed, as the net for both
   adapters and for whatever comes next. Text nodes are not merged: on Google
   Docs each carries its own `Origin`.
2. **A line break at the very end of a block's inline content is dropped,**
   the way a space there already is (MANUAL §6: "invisible at the source and
   could only be written as `&#x20;`"). Paragraph, heading, list item, table
   cell, on both adapters. A line break at the very *start* round-trips
   (`\⏎text`) and stays. Several trailing breaks all go; spaces and breaks
   mixed at the end go together.
3. **On push the dropped break is the source's, not ours,** the same as the
   dropped edge space: an unrelated edit leaves it where it is, and an edit
   to the block's text does not delete it unless the edge-space precedent
   already does. Find what that precedent is in `src/gdrive/patch.ts` and
   `src/notion/patch.ts`, follow it, and report what it is so the manual can
   say it.

## Scope

- Tests first, in this order:
  - `src/markdown.test.ts`: the table above as cases, each asserting
    `stringify(parse(printed)) === printed` **and** that the re-parse is one
    paragraph with the same text. Idempotence alone is what hid the last row.
  - `src/gdrive/to-markdown.test.ts`: a paragraph of runs `"text\v"` +
    `"# not a heading\n"`; the same with the second run bold, with the
    vertical tab in a run of its own, and with four leading spaces; a
    paragraph, a heading, a list item and a table cell ending in `\v`; a
    paragraph that is only `\v`.
  - `src/notion/to-markdown.test.ts`: the same shapes as rich text items.
  - `src/gdrive/push.test.ts` (or `patch.test.ts`): a fake Doc holding
    `text\v# not a heading`, `text\v1. not a list` and a paragraph ending in
    `\v` accepts a push that edits another paragraph, and the requests touch
    nothing in those three.
- The fix in `src/markdown.ts`, `src/gdrive/to-markdown.ts`,
  `src/notion/to-markdown.ts`, and wherever the edge-space rule lives.
- `Origin` accounting: a dropped trailing break is one character of the
  block's text that no node carries. Check `ranges.ts` and `patch.ts` cope
  the way they do for a dropped edge space, with a test.
- No recorded fixture holds the case (check; say so if one does). Do not
  re-record anything.
- The changelog line, the manual and the skill file are Claude's. Report the
  wording the manual needs.

## Out of scope

The three follow-ups from ticket 41 (append at the end of the body, naming
the author on push, `restyle()` over a foreign insertion).

## Done when

- `corepack pnpm check` passes.
- The cases in the table round-trip byte-identical and re-parse as the one
  paragraph they are.
- A fake Doc with `text⏎# not a heading`, `text⏎1. not a list` and a
  paragraph ending in a line break pushes an unrelated edit.
- A live check, by Claude after landing: a Doc a smoke script creates in the
  "Docsync test" folder with those paragraphs, fetched, an unrelated
  paragraph edited, pushed, fetched again with no diff, then trashed.

## Outcome

Landed 2026-09-17 as the ticket decided, with one correction to it.

- `stringifyMarkdown` prunes empty text nodes from a **copy** of the tree:
  `readLive` stringifies a tree and then reads the ranges off the same
  nodes, so pruning in place would edit the map a patch addresses the Doc
  through. Both converters stopped emitting the empty node, and both
  `trimEdges` end in a new `trimTail` that takes trailing breaks and spaces
  off together, reaching into the bold or linked run a block ends with
  (inside a wrapper only the break goes; a space in a link is the link's).
- The trailing break is dropped in the converters, not in the stringifier:
  on Google Docs its `Origin` has to go with it, or the base text and the
  pieces disagree by one character.
- **Decision 3 assumed one edge-space precedent; there are two.** On Google
  Docs a dropped edge character is outside every origin, no request can
  name it, and an edit to the block leaves it where it is. On Notion a
  dropped edge character makes `mergeRichText` take the whole-block branch,
  so an edit to that block deletes it, as it always has for a trailing
  space. The break follows each source's precedent; the manual (§6, §7)
  says both.
- No snapshot and no recorded fixture changed; no fixture holds the case.
  Two outputs change for documents whose old output was broken: a bold or
  linked run ending in a break (`**a\&#xA;**` → `**a**`), and trailing
  spaces spread over more than one node (`a&#x20;` → `a`).
- Live check: `scripts/gdocs-soft-break-smoke.ts` (Claude's), all checks
  passed against a Doc it made and trashed in "Docsync test". Docs does
  store the run boundary right behind the vertical tab.

Follow-ups, not done: Notion could keep a dropped edge character on an edit
(`mergeRichText` tolerating a base trimmed by the dialect's own rule); a
vertical tab inside a code-font run is written into the file as a raw
U+000B; a break at a block's end inside `<u>` or `<span data-color>` is not
dropped, as an edge space there is not.
