# 17 — Comment threads

Phase 4. Manual §12 phase 4.

## Goal

Pull comment threads with the document; push replies and resolutions.

## Scope

- Design the on-disk format for threads and their anchors, for both sources,
  and add it to the manual before implementing.
- Fetch: threads, authors, timestamps, resolved state, anchor to a block or
  range.
- Push: replies and resolutions authored locally. Nothing is ever posted that
  the user did not write.
- Agent guidance in the skill file for reading and answering comments.

## Done when

A thread opened by a client in Google Docs can be answered from a checkout and
the reply appears correctly attributed at the source.
