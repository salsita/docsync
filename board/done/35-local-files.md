# 35 — Everything outside a root is local

Phase 1. Manual §4 path rules, §5 `status`, §7 fetch and push step 3, §8.

## Problem

A checkout is only allowed to hold what a source holds. A file added or
edited outside every root fails the push ("not under any root in the
manifest"), and the fetch commit is built from fetched files and the index
alone, so nothing else could survive on `main` even if it got there. Notes,
drafts, agent scratch and a document not ready to be synced have nowhere to
live, and the workaround is a second repository.

A root path can never be the repository itself, so a path under no root can
never mean "create this at a source". It means: this file is ours.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Rule | A path under no root, other than `.docsync/index.yaml`, is **local**: committed, pushed to `main`, never sent to a source | No manifest field; the manifest already says what is synced. |
| Root path | `.`, `./`, `` , an absolute path, a path with a `..` segment or a leading `./`, and anything under `.docsync/` are refused by the manifest with `"path" must be a relative path inside the repository, not the repository itself` | Makes "outside every root" well defined. |
| Fetch | The tree starts as every local file of the parent commit and the roots write over it | Local files survive every fetch and every post-push fetch. |
| Push | A change to a local file is accepted with no request; step 3's "not under any root" refusal goes away. Deleting a local file deletes it from `main` | The push unit stays the commit; local files ride along. |
| Into a root | A file moved or copied from outside into a root is a **creation** at the source, with no memory of where it came from | Owner's call. |
| Out of a root | A file moved from a root to outside is a **trash** at the source, printed prominently as a trash is, and a local file from then on | §8 stays: leaving a root means trash, never permanent. |
| `docsync remove` | Unchanged: the files stay and are local from then on. §8's "deleted under no root is unsubscribe" is gone: after `remove` a deletion is a plain deletion | One rule fewer. |
| `docsync add` over local files | Refused when anything exists under the new root's path: "`<path>` exists in the checkout; a root is added over an empty path. Commit it on a branch or move it aside, then add". Re-adding a removed root is: remove, edit on a branch, add, rebase, resolve, push | A root writes over local files on every fetch; without this a re-add replaces edits pushed to `main` as local files with the source text, in a commit git applies without a word. |
| Status | `To push:` lists local changes as `local <path>`; the root lines are unchanged | The preview says what a push does with every file. |
| Index | Local files have no entry | Only documents are indexed. |
| Ignore patterns | Unchanged: a file matching a root's `ignore` is under that root, not local | Out of scope. |
| The manifest, skill files, `.gitignore` | Unchanged: git-excluded by `init`, never in a commit | Out of scope; committing the manifest is its own question. |
| Skill file | The "Do not touch" list is unchanged; one sentence under "Before you edit": a file outside every root in `.docsync.yaml` is local, committed and pushed but never sent to a source; moving it into a root creates it there | Agents will use this for scratch. |

## Module

| File | Purpose |
|---|---|
| `src/manifest/parse.ts` | The path refusal. |
| `src/helper/fetch.ts` | Carry-over of local paths from the parent tree. |
| `src/helper/changes.ts` | Local changes planned as `local`; the trash on the way out; the creation on the way in. |
| `src/helper/push.ts` | No request for a local change; the served commit carries it. |
| `src/cli/commands/add.ts` | The refusal over existing files. |
| `src/cli/print.ts` | The `local` preview word. |
| `skill/SKILL.md` | The sentence. |
| Tests | Manifest path refusals; a fetch keeps a local file and a post-push fetch keeps it; push of a branch with a local add, edit and delete makes no request and lands on `main`; a local file renamed into a root is created at the source; a document renamed out is trashed and kept locally; `docsync remove` then delete; `add` refused over an existing file and allowed over an empty path; status preview word; the e2e CLI test commits a notes file and pushes. |

## Done when

`pnpm check` green; in a checkout, `mkdir notes && echo hi > notes/a.md`,
commit, `docsync push` lands it on `main` with no source request, a later
`docsync pull` keeps it, and `git mv notes/a.md drive_link/a.md` plus a push
creates the Doc.

## Outcome

Landed 2026-09-08 in two agent commits (`2c2484b`, `c495fdc`) plus the
landing commit. `pnpm check` green, 1513 tests (+17).

- A path under no root is local everywhere: `PushPlan.ignored` replaced by
  `local`; add, edit, delete and rename among local paths make no request.
- `isInsideRepository` and a shared `rootOf` in `src/manifest/validate.ts`;
  the path refusal with the ticket's message, plus a Windows drive letter
  added on review.
- Fetch seeds its tree with the parent's local paths; roots write over
  them. A root removed from the manifest no longer wipes its files on the
  next fetch; only the index drops them. `docsync remove` still deletes
  them itself.
- Rename into a root creates; rename out trashes and keeps the file local.
- `docsync add` refuses over an existing path (file, directory, and the
  Notion sibling directory); `init` does not, since it creates its own
  directory.
- Two tests that used `README.md` as the canonical refusal now edit the
  index instead, which is the remaining path-level refusal.
- Manual §4, §5, §7, §8 and the skill file updated.
