# 33 — Push as suggestions

Phase 4, "Later". Manual §4 (root fields), §5 `status`, §6 "Comments and
suggestions", §7 push steps 3, 5 and 6, §12. Needs the Google Workspace
Developer Preview Program on the Cloud project that owns the OAuth client;
until then only the fake API sees it.

## Problem

A client-facing Google Doc should not be rewritten by an agent outright. The
client wants to see each change as a suggestion in Docs, review it, and
accept or reject it there. The Docs API now takes a whole `batchUpdate` in
suggesting mode (`writeControl.writeMode: SUGGEST`), as a Developer Preview
feature.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Manifest | `suggest: true` per root, default false, after `readonly`. Only on a Drive root, and only with `comments: true`; parse reports `"suggest" is only for Google Drive roots` and `"suggest" needs "comments: true"` otherwise | Suggestions must land somewhere visible in the checkout, and the sidecar is that place. |
| Push, body edits | A modified Google Doc under a suggest root is patched with the same requests as today, sent with `writeControl.writeMode: SUGGEST`. The report line says `suggested` instead of `updated`, with the count of suggestions the response reports | One switch on the request; the patcher does not change. |
| Push, everything else | Adding, deleting or renaming any file under a suggest root, and modifying a binary, is refused in step 3, after the read-only check: "`<path>` is under a suggest root (`<root path>`); only edits to existing documents can be suggested. Restore it with `git checkout -- <path>`" | Creating, trashing and moving are not suggestions. |
| After the push | Nothing new. The post-push fetch reads the Doc as it always does, suggested insertions dropped, so the body returns to the source text and the sidecar gains one thread per suggestion. The follow-up commit is called `Suggested: <titles>`. The report says the edit is back to the source text until the client accepts | Honest: the source did not change. No pending state to track, and a second push has nothing to resend. |
| Fetch | Under a suggest root every Google Doc is read on every fetch, `modifiedTime` or not, and its sidecar rebuilt; the body is written only when it differs. The post-push fetch does the same for the documents it touched | Drive's `modifiedTime` is not trusted to move for a suggestion made, accepted or rejected in Docs. A suggestion or its resolution must show up on the next pull even when nothing else changed. |
| Partial failure | `BatchUpdateDocumentResponse.commentUpdateState` is checked; anything but success fails the push with the API's message and the document name | The preview docs say to. |
| Editing a paragraph that already carries a suggestion | Unchanged from §7: the edit is written over the suggested range, now as a further suggestion | Out of scope; the manual says so. |
| `docsync add` | `--suggest` flag sets `suggest: true` and `comments: true` | Add is where the intent is known. |
| Status | The root line gains `suggest`, like `read-only` and `comments on`. `To push:` lines under a suggest root read `suggest` instead of `update` | Visible where roots and the plan are listed. |
| Skill file | One bullet under "Before you edit": under a root with `suggest: true` a push lands as suggestions the client reviews; the body reverts on the next pull until they accept | Agents read the manifest anyway. |
| Not enrolled | The API refuses the request; the push fails with the API's message plus one line: "suggesting needs the Google Workspace Developer Preview Program on the project that owns the OAuth client" | Say what to do. |
| Notion | Not supported; the manifest refuses it | Notion has no suggestions. |

## Module

| File | Purpose |
|---|---|
| `src/manifest/{types,parse,serialize}.ts` | The field, validated as above. Key order `src`, `path`, `ignore`, `comments`, `readonly`, `suggest`. |
| `src/gdrive/api.ts` | `batchUpdate(documentId, requests, { suggest })` adds `writeControl.writeMode`; the response type gains `commentUpdateState`. |
| `src/gdrive/index.ts` | Passes the flag for documents under a suggest root; reads every Doc under one on every fetch; the report wording; the enrolment hint on the API refusal. |
| `src/helper/changes.ts` | The step 3 refusal. |
| `src/gdrive/docs-model.mock.ts`, `fake-api.mock.ts` | A `SUGGEST` batch leaves the body as it is and records the requests as suggestions that `get` in inline mode returns as suggested insertions and deletions, one suggestion id per request, so the post-push fetch and the sidecar behave as on the real API. |
| `src/cli/commands/{add,status}.ts`, `src/cli/program.ts`, `src/cli/print.ts` | `--suggest`, the status words. |
| `scripts/smoke-gdrive-patch.ts` | A `--suggest` mode: create a Doc in the Docsync test folder, push an edit as suggestions, read back inline, check the body is unchanged and the suggestions equal the diff, trash the Doc. Runs only once the project is enrolled; the ticket lands on the fake first. |
| `skill/SKILL.md` | The bullet. |
| Tests | Manifest round-trip and the three refusals; `batchUpdate` carries `writeControl` for a suggest root and not for its sibling; the refusal for an added, deleted, renamed and binary file under the root; the full push on the fake: body reverted in the follow-up commit, sidecar thread per suggestion, a second push of the same branch sends no request; a Doc under a suggest root whose `modifiedTime` did not move is still read, and a suggestion added or resolved at the source shows up on the next fetch; the request count for a suggest root with nothing changed is pinned; status and `To push:` words; `add --suggest`. |

## Done when

`pnpm check` green; on the fake, a checkout with a suggest root pushes a
paragraph edit as suggestions, comes back with the source text and a sidecar
thread, and pushes nothing on the next `docsync push`. The real-API smoke is
run by the owner after enrolment and its result noted here.

## Outcome

Landed 2026-09-08 in two agent commits (`9e3598d`, `99e394e`) plus the
landing commit. `pnpm check` green, 1496 tests (+14). The first agent
stalled with the work uncommitted; a second one finished it from the tree.

- `Root.suggest`, Drive only, needs `comments: true`, both messages as
  specified; `add --suggest` sets both fields.
- `batchUpdate` takes `{ suggest }` and returns `{ replies, suggestionIds,
  commentUpdateState }`; a failed state fails the push; a 4xx on a suggesting
  batch carries the enrolment hint.
- Step 3 refusal for anything but an edit to an existing Doc, both sides of
  a rename and a frontmatter flip included.
- Every Doc under a suggest root is read on every fetch; assets are not
  re-downloaded for it. Request count pinned. The reverted body after a
  suggest push is reported as re-rendered, under the `Suggested: <titles>`
  commit.
- Fake Docs model records a `SUGGEST` batch as suggestions the inline view
  returns, so the full loop is tested on the fake: body reverts, one sidecar
  thread per suggestion, second push sends nothing.
- `scripts/smoke-gdrive-patch.ts --suggest` run 2026-09-08 against the real
  API after the project's enrolment: the batch goes out in suggesting mode,
  the body moves 0 lines, and with every suggestion accepted the Doc says
  what the rewrite says. Two findings: the API returns no suggestion ids in
  the replies (13 ids show up on the next read), so the report no longer
  counts suggestions and the fake stopped inventing ids; and a suggestion
  spanning many paragraphs is one sidecar thread per paragraph (106 threads
  for 13 ids), a pre-existing rendering of multi-paragraph suggestions worth
  its own ticket. A suggestion resolved at the source is not tested on the
  fake (no accept/reject there); it takes the same read path.
- Manual §4, §5, §7, §12, §13 and the skill file updated.
