# 26 — Re-fetch unchanged documents

Phase 1. Manual §5 `fetch`/`pull`, §7 Fetch.

## Problem

A fetch downloads only documents whose last-edit time moved (§7). A fix to
the converter, this week the empty bold runs, the styled edge spaces and
the "Untitled" mentions, therefore reaches a checked-out document only when
someone edits it at the source. There is no way to say "render everything
again with the docsync I have now".

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Command | `docsync fetch --all` and `docsync pull --all`: every document under every root is downloaded and converted again, and the fetch commit holds whatever came out differently. Documents whose Markdown is byte-identical produce no change; the commit message is the usual `Update <n> documents`, or nothing when nothing differs | One flag, the existing commit path. |
| Transport | Git has no option to carry it, so the CLI sets `DOCSYNC_FETCH_ALL=1` in the environment of that one git run and the helper reads it. Plain `git fetch` never sets it | Git hands its environment to the helper; no protocol change. |
| Authorship | A re-fetch commit is authored by docsync, dated now, since no source edit caused it | The editor attribution of §7 stays truthful. |
| Assets | Re-downloaded too, compared by checksum, so a changed image name scheme lands | The same "everything again" rule. |
| Report | The fetch report lists the documents whose Markdown changed, marked `(re-rendered)` | Distinguishes a converter change from a source edit. |

## Module

| File | Purpose |
|---|---|
| `src/cli/commands/fetch.ts`, `pull.ts`, `program.ts` | The flag and the environment variable. |
| `src/helper/fetch.ts`, `src/gdrive/index.ts`, `src/notion/index.ts` | `all` in the fetch options: every document counts as changed. |
| Tests | Fetch with `all` on both fixtures rewrites every document, produces no commit when nothing differs, and authors the commit as docsync; CLI relays the flag. |

## Done when

`pnpm check` green; `docsync pull --all` on the owner's kickoff checkout
rewrites the documents carrying this week's artifacts and nothing else.
