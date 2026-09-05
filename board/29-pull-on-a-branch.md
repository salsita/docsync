# 29 — `docsync pull` on a branch other than main

Phase 1. Manual §5 `pull`, §10 the loop.

## Problem

The loop of §10 is: pull, branch, edit. A person or an agent on the branch
who runs `docsync pull` gets git's "There is no tracking information for
the current branch" and exit 1, after a fetch that did succeed. `main` is
left behind `origin/main`, and nothing says what to do.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Fetch | Unchanged: `git fetch origin` always runs and the report is printed | The fetch is the expensive, useful part. |
| main | When `main` is not the current branch, the fetch also fast-forwards the local `main` ref (`git fetch origin main:main` semantics, refused if not a fast-forward) | Keeps `main` what the manual says it is: the source's state. |
| The branch | Not merged. The command ends with one line: "main is now at <short sha>; rebase or merge it into <branch> when you are ready: git rebase main" | Merging into someone's work branch is their decision. |
| push | Unchanged; push already requires the branch to be what is pushed | Out of scope. |

## Module

| File | Purpose |
|---|---|
| `src/cli/commands/fetch.ts`, `pull.ts` | Detect the current branch; update `main`; the closing line. |
| `src/cli/commands.test.ts` | Pull on a branch fast-forwards `main`, leaves the branch, prints the line, exits 0; pull on `main` unchanged. |

## Done when

`pnpm check` green; `docsync pull` on a work branch exits 0 and leaves
`main` equal to `origin/main`.
