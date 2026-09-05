# 31 — `docsync status` previews the push

Phase 1. Manual §5 `status`, §7 push steps 2–4.

## Problem

Before a push a person wants to know what it will do to real documents,
especially while trusting the tool for the first time. Today the only way
is `git diff --name-status origin/main...HEAD` and knowing the refusal
rules by heart. The refusals (index, sidecar, export, and read-only roots
from ticket 25) are computed by `planChanges` without any network, so status
can show them.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Where | `docsync status`, after the root lines, a `To push:` section listing what `docsync push` would do on the current branch. Nothing when the branch equals `origin/main`; `Nothing to push.` is not printed | Status is where a person looks before acting. |
| What | The same diff push uses (`origin/main...HEAD`, committed only), run through `planChanges` with the tree's blobs; one line per file with the push report's verbs: `create <path>`, `update <path>`, `rename <old> -> <new>`, `trash <path>`, and for a rename that is also an edit `update` after the rename line. Files outside every root are listed as `ignored <path>` | Same code, same words as the push report (§7), so the preview cannot lie. |
| Refusals | `planChanges` throws on the first refused path; status must show all of them. Refactor so refusals are collected: `planChanges` returns them, `push` still fails on the first, status prints each as `refused <path>: <reason>` | A preview that stops at the first problem is not a preview. |
| Uncommitted edits | Not in the list; one closing line `(<n> uncommitted changes are not pushed)` when `git status --porcelain` is non-empty, because the confusion is real | The owner's question of 2026-09-05. |
| Network | None; status stays cheap | `changedSince` is the only remote call status makes. |
| Read-only roots | The refusal line for ticket 25 reads `refused <path>: under read-only root <root path>` | Same message family. |

## Module

| File | Purpose |
|---|---|
| `src/helper/changes.ts` | Collect refusals instead of throwing on the first (push keeps failing on the first). |
| `src/cli/commands/status.ts`, `src/cli/print.ts` | The section. |
| `src/cli/commands.test.ts` | Status on a branch with a create, an update, a rename, a delete, an edited sidecar and a file under a read-only root prints every line; on `main` equal to `origin/main` prints no section; uncommitted edits print the closing line. |

## Done when

`pnpm check` green; on the owner's checkout `docsync status` names exactly
the files `docsync push` would then report, and the sidecar and read-only
refusals appear without a push being attempted.
