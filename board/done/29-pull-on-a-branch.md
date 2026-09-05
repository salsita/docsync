# 29 — `docsync pull` on a branch other than main

Phase 1. Manual §5 `pull`, §10.

## Problem

Most projects have people and agents work on a branch. Whoever runs
`docsync pull` there gets git's "There is no tracking information for
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

## Outcome

Landed as `d29c649`. `GitRunner.branch()` reads the current branch; off
`main`, `pull` and `fetch` run `git fetch origin`, print the report,
fast-forward `main` with `git fetch . refs/remotes/origin/main:refs/heads/main`
(no second network round trip, git's own fast-forward refusal, said on
refusal, exit 0 either way) and end with the ticket's line. On a detached
HEAD the branch slot reads `HEAD`. On `main` nothing changed. Manual §5
extended in the landing commit. Follow-up: `docsync push` from a branch
whose `main` was just moved is untouched.
