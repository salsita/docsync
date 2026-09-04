# 25 — Read-only roots

Phase 1. Manual §4 (root fields), §5 `status`, §7 push step 4, §10 skill.

## Problem

A checkout often carries supporting material next to the documents being
worked on: a client's folder of inputs, a recording, a signed contract. It
is pulled for context, never to be edited, and a push that touches it by
accident writes to a document the team does not own. Today only exports
(Sheets, Slides, Drawings) and comment sidecars are refused.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Manifest | `readonly: true` per root in `.docsync.yaml`, default false, next to `ignore` and `comments` | The root is the unit a person reasons about when adding a folder. |
| Push | Step 3's manifest check refuses any added, modified, deleted or renamed file under a read-only root: "`<path>` is under a read-only root (`<root path>`); nothing under it is pushed. Restore it with `git checkout -- <path>`". Every file, not just documents: assets and sidecars too | One rule, before any request goes out. |
| `docsync add` | `--readonly` flag sets it; `docsync remove` unaffected | Add is where the intent is known. |
| Status | The root line gains `read-only`, like `comments on` | Visible where roots are listed. |
| Fetch | Unchanged; a read-only root fetches like any other, comments included | Read-only is about push only. |
| Skill file | One bullet under "Do not touch": files under a root marked `readonly: true` in `.docsync.yaml`; a push that changes them is refused | Agents read the manifest anyway. |
| Index | No change; the flag lives in the manifest only | The manifest is the source of truth for roots. |

## Module

| File | Purpose |
|---|---|
| `src/manifest/parse.ts`, `serialize` | The field, validated as a boolean. |
| `src/helper/push.ts` (or `changes.ts`) | The refusal, alongside the sidecar refusal. |
| `src/cli/commands/add.ts`, `src/cli/program.ts`, `src/cli/print.ts` | `--readonly`, the status word. |
| `skill/SKILL.md` | The bullet. |
| Tests | Manifest round-trip; push refused for a document, an asset and a rename under the root, and allowed for a sibling root; status line; `add --readonly` writes the field. |

## Done when

`pnpm check` green; a checkout with a read-only Drive folder refuses a push
that edits a file in it, with the message above, and pushes an edit in the
other root.
