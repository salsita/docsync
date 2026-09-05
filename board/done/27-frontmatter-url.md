# 27 — A link to the source in the frontmatter

Phase 1. Manual §6 "Identity" (frontmatter), §7 push step 3.

## Problem

The frontmatter names a document by its raw id. To open the page in Notion
or the Doc in Drive from a file, a person has to search the source or build
the URL from the id by hand. Agents have the same problem when they report.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Field | `url:` after `title:`, written on every fetch, derived from the id: Notion `https://www.notion.so/<id>`; Google Doc `https://docs.google.com/document/d/<id>/edit`; Sheet / Slides / Drawing their own `docs.google.com/<kind>/d/<id>/edit`; other Drive file `https://drive.google.com/file/d/<id>/view` | Derivable, so no extra request and no new index field; the Notion URL without a workspace slug redirects correctly. |
| Ownership | docsync owns it like `id`: a changed or missing `url` in a pushed file is ignored and rewritten on the next fetch, never an error and never a rename | It is a convenience, not identity; editing it must not mean anything. |
| New documents | A new file's frontmatter needs no `url`; the fetch after the push adds it | Nothing to know before the document exists. |
| Diff base | The push-time comparison and the block diff work on the body, not the frontmatter, so the field changes nothing there. `serializeDocument` writes it; `parseDocument` reads and ignores it | Confirm in `src/frontmatter.ts` and `src/helper/changes.ts`. |
| Exports and binaries | No frontmatter, so no field; unchanged | Only Markdown documents carry frontmatter. |
| Skill file | The "Frontmatter" bullet mentions `url` as the link to open, read-only | Agents will want it in reports. |

## Module

| File | Purpose |
|---|---|
| `src/frontmatter.ts` | Write `url`; ignore it on read. |
| `src/notion/index.ts`, `src/gdrive/index.ts` | Supply the URL per document kind. |
| `src/helper/changes.ts` or the push manifest check | A frontmatter whose only difference is `url` is not a change. |
| `skill/SKILL.md` | The bullet. |
| Tests | Frontmatter round-trip with and without `url`; every kind's URL; a push with an edited `url` and an unchanged body is "nothing to push"; the recorded fixtures' snapshots. |

## Done when

`pnpm check` green; every Markdown document in the owner's kickoff checkout
carries a working `url:` after the next `docsync pull --all` (ticket 26).

## Outcome

Landed as `6b3ccd2`. `sourceUrl(ref, mimeType?)` in `src/source-ref.ts`
derives the URL per kind as the table says, plus a folder URL the ticket
did not list (nothing writes it yet). `serializeDocument` writes `url`
after `title`; `parseDocument` drops it like any unknown key, and both
adapters' push compare bodies, so an edited or deleted `url` is nothing to
push (tested on both sides). The fake source writes it too, so the helper
e2e covers it. Manual §6 "Identity" and the skill's Frontmatter bullet
updated in `b10b6f5`. Verified on the owner's checkout after
`docsync fetch --all`: every document carries a working `url:`.
