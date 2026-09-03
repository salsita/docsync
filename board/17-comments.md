# 17 — Comment threads and suggestions, read-only

Phase 4. Manual §6 "Comments and suggestions" (to be written), §12 phase 4.

## Goal

Every pull brings the open comment threads and pending suggestions of a
document into a sidecar file beside it, so that a person or an agent can read
them in context and answer them by editing the body. Nothing is pushed back:
the sidecar is read-only and a modified one is refused on push.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Where | `<title>.comments.md` beside `<title>.md`, only when the document has at least one thread or suggestion. Removed when the last one goes away | The owner wants the body clean. A sidecar diffs on pull like any file, so `git pull` shows new comments as a diff. |
| Format | Markdown: a frontmatter with `document: <ref>` and `fetched:`; then one `## ` heading per open thread in source order: `## <id> — comment`; `## <id> — suggestion` (Docs only). Under the heading the anchor, then one `**Author** · <ISO time>` line and the body per entry. Deleted entries omitted | Readable without a tool, greppable, stable order, small diffs when one thread changes. |
| Anchor, comments | The quoted text as a blockquote, then `in: <nearest heading path in the body>` when the quoted text is found in the fetched Markdown, `in: (not found)` otherwise. Docs: `quotedFileContent`. Notion: the first line of the anchored block, and `in:` from the block position | The anchor bytes are opaque (Docs) or a block id (Notion). Quoted text plus heading path is what a reader needs. |
| Anchor, suggestions | The paragraph as it stands and as it would read with the suggestion accepted, in a ```diff fence (`-` line, `+` line). Pure formatting suggestions render as `> quoted` with `formatting only` | A suggestion is an edit; a diff is the honest rendering. |
| Which body | Docs: `documents.get` with `suggestionsViewMode=SUGGESTIONS_INLINE`, once. The body is derived by dropping runs with `suggestedInsertionIds` and keeping runs with `suggestedDeletionIds`, i.e. the document as it stands with no suggestion applied. The sidecar is derived from the same response | One request; ticket 16 needs the same response for its index math. |
| Resolved threads | Not in the file. A thread disappears from the sidecar when resolved (Docs: `resolved` flag; Notion: no longer returned) | The owner: resolved threads are not interesting. |
| Push | A changed, added or removed `*.comments.md` is refused: "`<path>` is read-only; comments are only pulled in this version. Restore it with `git checkout -- <path>`". The refusal is the first step of the push, before any source is touched | Silent ignoring hides an agent's mistake. |
| Identity | The sidecar is not in the index and has no frontmatter `id`. A plain file named `*.comments.md` at the source is refused on fetch with a clear message | Keeps the suffix unambiguous. |
| Notion capabilities | The integration needs "read comments"; `auth` checks it and prints the grant hint | Manual §2. |
| Fixtures | The Elements doc gains an open thread with a reply and two suggestions (a replacement and a pure deletion); the Notion Blocks page gains a block comment with a reply. Recorded with the existing scripts | Same recording flow as tickets 05 and 07. |

## Module

| File | Purpose |
|---|---|
| `src/comments/format.ts` | Thread model → sidecar Markdown, pure. |
| `src/comments/locate.ts` | Quoted text → heading path in the fetched Markdown. |
| `src/gdrive/comments.ts` | Drive `comments.list` (with replies, `includeDeleted=false`) + suggestion extraction from the Docs response. |
| `src/notion/comments.ts` | Comments per page and per block, grouped by `discussion_id`. |
| `src/helper/changes.ts` | The read-only refusal. |

## Tests

- `format.ts` snapshot for a fixture with all thread kinds.
- `locate.ts`: found under a nested heading, found before any heading, not
  found, found twice (first match, noted).
- Body derivation from a `SUGGESTIONS_INLINE` response: insertion dropped,
  deletion kept, mixed run.
- Fetch produces the sidecar for both fixtures; a document without threads
  has none; resolving the last thread removes the file.
- Push refuses a modified, an added and a deleted sidecar with the message.

## Done when

The Elements doc and the Blocks page pull with their sidecars, `pnpm check` is
green, and the manual section matches what is produced.

## Out of scope, recorded in the manual's roadmap

- Replies and resolving (Docs: possible; Notion: no resolve endpoint).
- Accepting and rejecting suggestions, and **push as suggestions** (writing
  a push in suggesting mode so the client reviews it in Docs). Both need
  the Google Workspace Developer Preview Program.
