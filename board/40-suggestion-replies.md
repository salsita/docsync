# 40 — Suggestion discussions, and comment anchors from the Docs API

Phase 4. Manual §6 comments and suggestions, §7 fetch.

## Problem

A suggestion in Google Docs carries a discussion of its own: replies under
the "Replace: one with three" card. The sidecar shows the suggestion's diff
and nothing of the discussion, so the owner's negotiation over the price
lock (three replies on `suggest.frjnz76h4q08` in the ramnex license Doc) is
invisible in the checkout.

The Drive comments API, which is where docsync reads threads today, does
not return suggestion discussions at all: `comments.list` on that Doc
answers seven ordinary threads, and the suggestion id is not a comment id
(`comments.get` says not found). The Docs API does return them, under the
Developer Preview the project is enrolled in: `documents.get` with
`commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED` (probed 2026-09-16; the
default is `COMMENTS_VIEW_MODE_OMITTED`) adds to the reply

- `comments[]`: `{ commentId, anchorId, headPost, replies[], status:
  "OPEN" | …, plainTextQuote }`, each post `{ postId, content, contentHtml,
  author: { displayName, user, me? }, createTime, updateTime,
  commentAction }`;
- `suggestions[]`: `{ suggestionId, headPost (no content), replies[],
  status, summaryText: "Replace: “one” with “three”", summaryHtml }`, the
  posts with `suggestionAction`;
- per tab, `documentTab.commentAnchors`: `{ [anchorId]: { anchorId,
  ranges: [{ startIndex, endIndex }] } }`, exact ranges in that tab.

A recorded reply of the license Doc in this shape is in the session
scratchpad (`license-with-comments.json`); it holds a client's contract and
must not become a fixture.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Read | The document read a fetch already makes for a Doc that owes a sidecar asks `commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED` too, and the sidecar is built from the reply's `comments`, `suggestions` and `commentAnchors`. The Drive `comments.list` stays as what it is today: the cheap probe that says whether an unchanged Doc has an open thread and so has to be read | No new request per fetch; the discussion and the anchors come with the body. |
| Fallback | A project not enrolled in the preview gets the parameter refused; the read is retried without it and the sidecar is built as today, from Drive threads placed by quote. One stderr line says the discussion and exact anchors need the preview, once per fetch | docsync is used with other OAuth apps. |
| Suggestion threads | Gain the discussion: after the diff, one entry per reply in the comment-thread entry format (author, time, text), the head post skipped since it has no content. `summaryText` is a line under the heading | What the owner is missing. |
| Comment threads | Built from `comments[]`: same sidecar as today, `status` deciding open, `plainTextQuote` the quote, `contentHtml` ignored, `content` used with the same entity decoding | One source for both. |
| Anchors | A thread with a `commentAnchors` entry is placed by its ranges through the converter's position map (the `mark` ranges to-markdown records), in the tab the anchor sits in; a thread without one (text deleted since) falls back to the quote search as today. This replaces ticket 37's "first tab whose body holds the quote" for anchored threads | Exact, and per tab. |
| Order | Threads in the sidecar keep today's order, by position in the body; a suggestion's discussion entries in `createTime` order | Unchanged. |
| Drive comment ids | Unchanged: `comments[].commentId` is the same id Drive answers, so headings and the index do not move | Existing sidecars stay put. |
| Cost | Unchanged on a Doc without open threads or suggestions; a Doc that owes a sidecar was read anyway | §7 promise kept. |
| Notion | Untouched | |

## Module

| File | Purpose |
|---|---|
| `src/gdrive/api.ts` | `commentsViewMode` on `getDocument` (an option), the `CommentThread`, `SuggestionThread`, `CommentPost`, `CommentAnchor` types spelled from the recorded shape, the refusal detection for the fallback. |
| `src/gdrive/comments.ts` | Threads from the Docs reply; suggestion discussions; anchor-based placement with the quote fallback. |
| `src/gdrive/to-markdown.ts` | Whatever the position map needs to answer "which block and offset holds Docs index n" for a tab, if it does not already. |
| `src/gdrive/index.ts` | Ask for comments on the read that builds a sidecar; the fallback line. |
| `src/comments/format.ts` | The summary line and discussion entries on a suggestion thread. |
| `scripts/record-gdrive-fixtures.ts`, `src/gdrive/__fixtures__/` | Recorded with comments included; fixture Docs with threads gain them. Every existing Markdown snapshot stays byte-identical; sidecar snapshots gain only what the discussion adds. |
| `src/gdrive/docs-model.mock.ts`, `fake-api.mock.ts` | The fake answers `comments`, `suggestions` and `commentAnchors` when asked; a seeded reply on a suggestion. |
| `scripts/gdocs-suggestion-replies-smoke.ts` (new) | Creates its own Doc in the fixture folder, pushes an edit as a suggestion, replies to it with the preview's `addCommentReply`, fetches, checks the sidecar carries the reply, trashes the Doc. |
| Tests | Types parsed from a redacted sample; a suggestion with replies renders its discussion and summary; a comment thread from the Docs reply equals the one Drive gave; an anchored thread placed by range lands on the right block and offset, in the right tab, where the quote alone is ambiguous; a thread with no anchor falls back to the quote; the fallback when the parameter is refused; no extra request on a Doc with nothing open. |

## Done when

`pnpm check` green; the smoke script passes on the real API; a scratch
checkout (never the owner's) of the fixture Doc the smoke script leaves
behind is not needed, the script checks the sidecar itself.
