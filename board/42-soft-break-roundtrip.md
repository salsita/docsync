# 42 — A soft line break followed by Markdown syntax breaks the round trip

Unrefined. Phase 3. Manual §7 write-back (the base check).

## Problem

Found while probing for ticket 41: a Docs paragraph whose text after a soft
line break (a vertical tab, written as a hard break in Markdown) begins with
`#`, `1. `, `- ` or another block-level Markdown marker re-parses as a
different structure from what the converter printed. Then
`stringifyMarkdown(parseMarkdown(live.markdown)) !== live.markdown`, and every
push of such a Doc is refused with "the source changed", however the
checkout looks.

## To find out

- Which markers after a hard break re-parse (heading, list, quote, fence,
  thematic break, table row), and whether the converter should escape the
  first character after every hard break, as it escapes a line's first
  character elsewhere.
- Whether any recorded fixture holds the case; if not, a fake with one.

## Done when

A Doc with `text⏎# not a heading` and `text⏎1. not a list` in one paragraph
round-trips byte-identical and pushes an unrelated edit.
