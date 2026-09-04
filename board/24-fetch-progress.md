# 24 — Progress while a fetch or push runs

Phase 1. Manual §5 (`fetch`, `pull`, `push`), §7, §9.

## Problem

A pull of a decent-size Drive folder shows nothing until it is done, then
the whole report at once. The helper's stderr already reaches the terminal
live (git relays it, `docsync` relays git), but the helper logs one line per
root, after `fetchRoot` has returned, and a source has no way to say what it
is doing inside `fetchRoot` or `pushRoot`.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Channel | The helper's existing `log` to stderr, honouring git's `option verbosity` (`--quiet` silences it). No TTY tricks, no carriage returns, no spinners: one plain line per event, so it reads the same in a terminal, in a log and in an agent's transcript | It is what already works end to end; git's own progress is the precedent. |
| Interface | `fetchRoot` and `pushRoot` get an optional `progress?: (line: string) => void` in their options (or a `ProgressReporter` in `FetchDeps`/`PushDeps` threaded through). The helper passes its `log`; tests pass a collector or nothing | One hook, both directions. |
| Events, fetch | `listing <root path>` when the walk starts; then per document that is fetched, `<n>/<total> <path>` once the total is known (Drive: after the walk; Notion: the page count grows as the tree is walked, so `<n> <path>` with no total); unchanged documents are not listed (they cost nothing and would drown the changed ones); comments add `comments <path>` per document when `comments: true` on Notion, since that is the slow part | Shows movement at the granularity the user waits at: one document. |
| Events, push | `<n>/<total> <path>` per document written, before its requests go out; assets `upload <path>` | Same shape. |
| Report | Unchanged: the final report is still printed by `docsync` from `last-fetch.json` / `last-push.json` after git returns. Progress lines are not stored | Progress is transient; the report is the record. |
| Manual | §7 fetch and push each get one sentence: progress on stderr, one line per document, silenced by `--quiet`. §9 protocol table notes `verbosity` | Only Claude edits it; the agent reports the wording. |

## Module

| File | Purpose |
|---|---|
| `src/source.ts` | The `progress` option on `fetchRoot` / `pushRoot`. |
| `src/gdrive/index.ts`, `src/notion/index.ts` | Emit the events above. |
| `src/helper/fetch.ts`, `src/helper/push.ts` | Pass `log` through. |
| Tests | A fetch of the recorded fixture through a collector yields the expected lines in order; the fake source in the CLI harness yields them too, and `docsync pull` relays them before the report; `--quiet` yields none. |

## Done when

`pnpm check` green; `docsync pull` on the Drive fixture prints one line per
changed document while it runs, and the report after.
