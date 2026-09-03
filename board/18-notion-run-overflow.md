# 18 — Notion: split a block that exceeds the rich-text limit

Phase 1 polish. Manual §7 (write-back limits). Follows ticket 06.

## Goal

A block whose text needs more than a hundred rich-text runs is written as
several blocks of the same type instead of losing formatting or text.

## Today

`runs()` in `src/notion/write.ts` keeps the first 99 runs, flattens the rest
into one plain run and caps that run at 2000 characters. Formatting on the
tail is lost, and text past 2000 characters of tail is dropped.

## Rule

- Runs are split at 2000 characters as today.
- If a block then has more than 100 runs, the block is cut into a run of
  blocks of the **same type** with the **same body fields** (colour, checked,
  language, icon), each carrying at most 100 runs, in order. Children stay on
  the last block.
- No exception per type. A heading, a list item, a quote or a code block
  splits the same way a paragraph does; the rarity of the case does not
  justify a second rule.
- A table cell cannot split; it keeps today's behaviour (flatten, then cap)
  and is the one documented loss.

## Where

`layout()` in `write.ts` returns one `Prepared` per block; it must be able to
return several. `appendAll` and `createPage` count the resulting payloads,
not the input blocks, against the chunk of 100.

## Tests

- A paragraph with 150 runs becomes two paragraphs of 100 and 50 runs, the
  second with the same colour.
- A toggle with 150 runs and children: the children hang off the second
  block.
- A code block with 150 runs keeps its language on both halves.
- A table cell with 150 runs is flattened as today.
- Chunking: 60 blocks that each split in two produce two append requests.

## Done when

`pnpm check` green, and manual §7 no longer lists the hundred-run
formatting loss for anything but table cells.
