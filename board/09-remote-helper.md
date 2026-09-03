# 09 — Git remote helper

Phase 1. Manual §7, §8, §9, and the skill-file refresh in §10.

## Goal

`git clone`, `git fetch`, `git pull` and `git push` work against
`docsync::<manifest>` with no docsync command involved. The helper turns
source state into commits and pushed commits into adapter calls; it never
talks to Notion or Drive itself.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Protocol | The `fetch` and `push` capabilities with `list` (plus `option verbosity`), **not** `import`/`export` | With `fetch` the helper writes objects itself through git plumbing and the stream formats never appear. With `push` git hands over ref names and the helper reads the pushed commits with `git diff-tree` and `git cat-file`. No fast-import stream to write, no fast-export stream to parse. |
| Git | Spawned as a child process (`git hash-object -w`, `mktree`, `commit-tree`, `update-ref`, `rev-parse`, `merge-base`, `diff-tree`, `cat-file`) with `GIT_DIR` as git passes it | Never reimplement git (ticket 10 rule). |
| Served ref | One branch, `refs/heads/main`. The helper keeps the commit it last served under its own ref `refs/docsync/<remote>/main` | Private state that survives a deleted remote-tracking ref; the remote name is argv[1]. |
| State | The previous index is read from that commit's tree (`.docsync/index.yaml`), never from the working tree | The working tree may be on any branch or dirty; the served commit is the truth about the last fetch. |
| Manifest | argv[2] minus `docsync::`; a relative path resolves against the working tree (`GIT_WORK_TREE` or the parent of `GIT_DIR`), an absolute path as is. Parsed with `src/manifest/` on every run. Missing or invalid → helper error naming the file and the line | Manual §9. |
| `list` | Runs the fetch: for every root, `fetchRoot` with the previous index; if anything changed (or there is no served commit yet), synthesizes a commit and advances the private ref; prints `<sha> refs/heads/main` and `@refs/heads/main HEAD` | Git calls `list` before `fetch`, and `list` must already know the sha. |
| `fetch` | A no-op acknowledging the ref: the objects exist since `list` | Above. |
| Synthesized commit | Tree = every file every root produced + `.docsync/index.yaml` (all entries, sorted by path, stable YAML). Parent = the previously served commit, none for the first. Author = the editor of the most recently edited changed document (name and email when the source gave them, else `<name> <id@source>`), author date = that document's last-edit time. Committer = `docsync <docsync@salsita.com>`, now. Message: `Update <n> documents` (or `Add …` on the first commit) and one line per changed path | Manual §7 fetch. |
| Unchanged files | Kept from the previous tree by blob sha, so an unchanged document is never re-downloaded | Manual §7: only changed documents are downloaded; both adapters return no content for them. |
| Removed root | Its files are simply absent from the next tree; the source is untouched | Manual §8: unsubscribe. |
| `push` | 1. Forced push (`+` in the refspec) → `error … force push is not supported`. 2. Pre-flight fetch as in `list`; if it produced a new commit → `error … the source changed, fetch and merge first`. 3. `git merge-base --is-ancestor <served> <pushed>` else → `error … non-fast-forward`. 4. `git diff-tree -r -M --name-status <served> <pushed>`: any A or M outside every root or touching `.docsync/index.yaml` or a read-only entry → `error` naming the path; D outside roots ignored. 5. Per root, build `FileChange[]` (text via `cat-file`, `previousPath` for R) and call the adapter's `pushRoot`. 6. Post-push fetch: `fetchRoot` on every root, parent = the pushed commit, private ref advanced, `ok refs/heads/main` printed | Manual §7 push, §8. A pushed commit whose net diff is empty is accepted and answered with a plain `ok`. |
| Adapter interface | `src/source.ts`: `interface Source { fetchRoot(root, provider, previous): Promise<FetchResult>; pushRoot(root, changes, provider, index): Promise<PushReport> }`, one object per source name, the Notion and Drive modules registered by name; the shared `FetchResult`, `FetchedFile`, `FileChange`, `PushReport` types move here from the adapters | The helper is tested against an in-memory fake `Source`; ticket 10 reuses the same table. |
| Credentials | `createCredentialProvider()`; a missing credential ends the run with `error` and the line `run: docsync auth <source>` | Manual §2. |
| Skill file | `refreshSkillFiles(worktree)` from `src/skill.ts` is called at the start of every run. In this ticket it is a stub that ticket 11 fills | Manual §10. |
| Progress | Stderr lines while fetching (`notion: 3 changed`, `gdocs: unchanged`), silent when `option verbosity 0` | Git shows helper stderr to the user. |
| Errors | Any thrown error → `error refs/heads/main <one line>` on push, non-zero exit with the message on stderr on fetch | Git's protocol has no richer channel. |

## Module

| File | Purpose |
|---|---|
| `src/source.ts` | The `Source` interface, shared types, the registry `{ notion, gdocs }`. |
| `src/helper/protocol.ts` | Reads commands from stdin line by line, dispatches, writes replies. Pure over an injected `Commands` object, so it is tested with strings. |
| `src/helper/git.ts` | The plumbing calls, each one function, over `GIT_DIR`. Tested against a real temporary repo. |
| `src/helper/tree.ts` | Builds a tree object from `{ path → blob sha }`, nested directories included, and reads one back. |
| `src/helper/fetch.ts` | The synthesized commit: previous index in, `Source`s called, commit sha out. |
| `src/helper/push.ts` | The push steps above: refspec in, `ok`/`error` out. |
| `src/helper/index-file.ts` | Read and write `.docsync/index.yaml` (moves the type from `src/index-file.ts` or re-exports it). |
| `src/remote-helper.ts` | The binary: argv, environment, stdin/stdout wiring, nothing else. |

## Tests

- Protocol: `capabilities`, `list`, `fetch`, `push`, `option`, unknown
  command, empty line ends a batch, EOF ends the run; with a fake `Commands`.
- Tree and git plumbing against a real temporary repository: nested
  directories, a binary blob, a unicode filename, the round trip of a tree.
- End to end, each in a fresh temporary directory with a real `git` and the
  fake in-memory `Source` holding a few documents, the helper installed on
  `PATH` for the test (a shim that runs the built file):
  1. `git clone docsync::<manifest>` produces the files, the index, one commit
     with the source's author and date.
  2. A second fetch with no change adds no commit.
  3. Edit at the fake source → fetch adds one commit touching that file only.
  4. Local edit, commit, push → the fake source holds the new body; a second
     commit appears on `origin/main`; `git pull` fast-forwards.
  5. New file without frontmatter → created at the source; after the
     post-push fetch the file carries `id` and the index lists it.
  6. Delete a file, push → trashed at the fake source; the file is gone from
     `origin/main`.
  7. Concurrent edit at the source, then push → rejected with the "source
     changed" message; `git pull` merges; push succeeds.
  8. Non-fast-forward (local branch behind) → rejected by the helper.
  9. `git push --force` → rejected.
  10. Remove a root from the manifest, fetch, pull → its files are gone; the
      fake source is untouched.
  11. A file added outside every root → rejected naming the path; an edit to
      `.docsync/index.yaml` → rejected; an edit to a read-only export →
      rejected.
  12. A rename with an unchanged body → one `renamed` change reaches the
      adapter, with `previousPath`.

## Done when

`pnpm check` green with the twelve end-to-end cases passing on macOS and
Linux in CI (Windows is ticket 12), and manual §7 says what the push
pre-flight does.
