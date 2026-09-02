# docsync — user manual

`docsync` gives you a git workflow over documents that live in Notion and
Google Docs. You check documents out as Markdown files, edit them locally (by
hand or with an agent), review the diff, and push. If the source changed while
you were working, git's ordinary three-way merge resolves it.

Nothing touches a source document until you push.

> Status: this manual is the specification. It describes intended behaviour and
> is written before the code. Sections marked **later** are out of scope for the
> first version.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Source** | A document store: `notion` or `gdocs`. |
| **Source ref** | An address of one object in a source: `notion:<page-id>` or `gdocs:<file-or-folder-id>`. |
| **Root** | One source ref checked out under one local path. A checkout is a set of roots. |
| **Manifest** | A YAML file listing the roots. It *is* the remote: the repo's git remote URL points at it. |
| **Helper** | `git-remote-docsync`, the program git runs on fetch and push. You rarely call it directly. |
| **Document** | One Notion page or one Google Doc. This is the unit of sync. There is no partial sync of a document. |

The remote-tracking branch `origin/main` is a synthesized git history. Every
fetch that finds changes at the source adds a commit to it, authored by the
person who edited the document, dated with the source's last-edit time.

---

## 2. Installation

```bash
npm install -g @salsita/docsync
```

This installs two executables on your `PATH`:

- `docsync` — the front end you use.
- `git-remote-docsync` — the helper git discovers by name when a remote URL starts with `docsync::`.

The ai-starter setup installs docsync for you.

### Credentials

| Source | Env var | How to get it |
|---|---|---|
| Notion | `DOCSYNC_NOTION_TOKEN` | An internal integration token. Share each page you want to sync with the integration. |
| Google Docs | `DOCSYNC_GOOGLE_CREDENTIALS` | Path to an OAuth client JSON. First use opens a browser for consent and caches the refresh token under `~/.config/docsync/`. |

`docsync auth <source>` verifies a credential and, for Google, runs the consent
flow. Every command that needs a credential fails immediately and clearly when
one is missing.

---

## 3. Quick start

```bash
# a checkout of one Notion page tree and one Drive folder
docsync init my-docs notion:2f3a9c… gdocs:1AbCdE…
cd my-docs
ls
```

```
Product Specs/          # the Notion page and its sub-pages
Product Specs.md
Contracts/              # the Drive folder, recursively
```

Edit, review, push:

```bash
$EDITOR "Product Specs/Auth.md"
git diff
git commit -am "Clarify session expiry"
git push
```

Get upstream changes:

```bash
git pull
```

That is the whole workflow. Everything below is detail.

---

## 4. The manifest

The manifest defines what is checked out. Default location: `.docsync.yaml`
in the repo, untracked. It can live anywhere the remote URL can reach (see §9).

```yaml
version: 1
roots:
  - src: notion:2f3a9c…
    path: Product Specs/
  - src: gdocs:1AbCdE…
    path: Contracts/
    ignore:
      - "Archive/**"
      - "gdocs:9XyZ…"
  - src: gdocs:7QrS…
    path: notes/roadmap.md
```

Fields per root:

| Field | Required | Meaning |
|---|---|---|
| `src` | yes | Source ref. |
| `path` | yes | Local path, relative to the repo root. See path rules below. |
| `ignore` | no | List of patterns. Matching documents are not checked out. |

### Path rules

- A path with a **trailing slash** (`Contracts/`) is a directory. The root's
  own document is placed inside it under its source title. For a folder or a
  page with children, the children go in there too.
- A path **without** a trailing slash (`notes/roadmap.md`) names the file
  itself. Only valid for a single document with no children.
- Paths must not overlap. Two roots cannot claim the same file, and one root's
  path cannot be inside another's.
- Paths are case-sensitive, and the helper refuses two names that differ only in
  case, because macOS does not.

### Ignore patterns

Two forms, mixable in one list:

- **gitignore syntax** matched against the title-derived path relative to the
  root, e.g. `Archive/**`, `*.draft`, `Meeting notes/2023-*`.
- **A source ref**, e.g. `notion:8c1d…`. Ignores that document (and its
  children) regardless of title. Use this when titles move.

An ignore added after files were fetched removes them locally on the next fetch.
That is an unsubscribe. The source is not touched.

---

## 5. Commands

### `docsync init [<dir>] [<src>[=<path>]...]`

Creates a checkout.

1. Creates `<dir>` (default: current directory, which must be empty).
2. Writes an empty manifest to `.docsync.yaml`.
3. `git init -b main`.
4. Adds `.docsync.yaml` to `.git/info/exclude`.
5. For each `<src>` given, resolves it at the source and appends a root
   (same code path as `docsync add`).
6. `git remote add origin docsync::.docsync.yaml`.
7. `git fetch origin` and `git checkout --track origin/main`.

Resolving a source ref is where a missing or invalid credential, or a page not
shared with the integration, fails. That happens before the repo is built.

With no sources, the result is a repo with one empty commit. Add roots later.

### `docsync add <src>[=<path>]...`

Resolves each source ref, appends roots to the manifest, then fetches and
fast-forwards if the working tree is clean.

The `=<path>` alias is optional:

| Form | Resulting `path` |
|---|---|
| `notion:2f3a…` | `<title>/` for a page with children or a folder, `<title>.md` for a leaf document, at the repo root |
| `notion:2f3a…=specs/` | Inside `specs/`, under the source title: `specs/<title>/` or `specs/<title>.md` |
| `notion:2f3a…=specs/auth.md` | Exactly `specs/auth.md`. Leaf documents only. |
| `notion:2f3a…=specs/auth/` | A directory named `auth`, containing the document and its children, ignoring the source title |

So the trailing slash means "use the source title, but put it here".

### `docsync remove <path>...`

Removes the roots whose `path` matches, deletes the local files, commits the
deletion locally. The source is not touched. The next push carries the deletion
commit, and the helper recognises it as an unsubscribe because the root is gone
from the manifest.

### `docsync status`

Like `git status`, plus one line per root: source, path, last fetched time, and
whether the source has moved since (a cheap metadata check, no download).

### `docsync fetch` / `docsync pull` / `docsync push`

Thin wrappers over the git commands with docsync-specific output:

- `push` prints, per document, what it did (created, updated, trashed), then
  runs the post-push fetch (§7) and fast-forwards the current branch when the
  working tree is clean.
- `pull` and `fetch` print which documents changed and who changed them.

You can always use plain `git pull` and `git push` instead.

### `docsync auth <source>`

See Credentials.

### `docsync resolve <src>`

Prints what a source ref is: type, title, child count, last editor, last edit
time. Useful before `add`.

---

## 6. Files on disk

### Layout

| Source object | On disk |
|---|---|
| Google Doc | `<title>.md` |
| Drive folder | `<title>/` containing its documents and sub-folders, recursively |
| Notion page, no children | `<title>.md` |
| Notion page with child pages | `<title>.md` **and** `<title>/` beside it, containing the children |

Filenames are derived from titles: the title as-is, with `/` and characters
illegal on macOS or Windows replaced by `-`. Collisions within one directory get
a numeric suffix (`Notes.md`, `Notes (2).md`), stable across fetches because the
mapping is by id.

Non-document files in a Drive folder (PDFs, images, spreadsheets) are not
checked out in this version. They are listed in `docsync status` as skipped.

### Frontmatter

Every document file starts with YAML frontmatter that docsync owns:

```yaml
---
id: notion:2f3a9c…
title: Auth
---
```

- `id` is the identity. Renaming the file does not change which document it is.
- `title` is what the source shows. Changing it and pushing renames the document
  at the source. The filename follows on the next fetch.
- A new file inside a root **without** frontmatter is a new document. On push it
  is created at the source, under the folder or parent page its path implies,
  titled from its first `#` heading or its filename. The id arrives with the
  post-push fetch (§7).

Do not add your own keys to the frontmatter. They will be dropped.

### Markdown dialect

Body content is GitHub-flavoured Markdown plus a small set of extensions for
blocks that GFM cannot express (Notion callouts, toggles; Google Docs page
breaks). The dialect is documented in `MARKDOWN.md`.

Conversion is **canonical**: fetching a document and pushing it unchanged
produces no change at the source and no diff on the next fetch. This is the
property that makes the whole tool work, and it is tested for every supported
block type.

Anything the dialect cannot represent is preserved as an opaque placeholder:

```
<!-- docsync:block notion:8f2e… type=embed -->
```

Placeholders round-trip. Moving or deleting one moves or deletes the block.
Editing inside one is not possible.

---

## 7. Fetch and push semantics

### Fetch

For each root, the helper lists documents at the source and compares last-edit
metadata with what it recorded last time. Only changed documents are downloaded.
If anything changed, it writes one commit to `origin/main`:

- author: the source's last editor, with their source email if available
- date: the source's last-edit time
- message: `Update <n> documents` and the list

Fetch never modifies your working tree. That is what `pull` and merge are for.

**Google Docs, later:** replay the Drive revision list as individual commits, so
`git log` shows real per-edit history.

### Push

Git sends the commits between `origin/main` and your branch. The helper:

1. Rejects the push if `origin/main` is not an ancestor of what you push. This
   is git's normal non-fast-forward rule. Fetch, merge or rebase, push again.
2. Refuses paths that are not under any root in the manifest.
3. Diffs the tree per root and applies:
   - **modified** → update the document (see Write-back below)
   - **added** → create the document
   - **deleted** → trash the document (Notion archive, Drive trash). Never
     permanent. Printed prominently.
   - **renamed** → same document (frontmatter id), possibly a title change
     and, for Drive, a move between folders
   - **manifest root removed** in the same push → deletions under it are
     unsubscribes, nothing is trashed
4. **Post-push fetch.** Re-reads every document it touched. If the canonical
   form differs from what was pushed (new ids, source-side normalization), it
   writes one more commit on top of `origin/main`. Your branch is then one
   fast-forward behind. `docsync push` fast-forwards for you when the working
   tree is clean; after plain `git push`, run `git pull`.

Commit messages are posted as a page comment at the source (Notion comment,
Google Docs comment on the document) so the source has an audit trail. Off by
default in this version; enable with `comments: true` in the manifest root.

### Write-back

The first version replaces the document body. This is correct but coarse: on
Notion it regenerates blocks and loses block-level comments; on Google Docs it
can detach comment anchors.

**Later:** diff-based write-back. Block ids are carried in the Markdown and only
changed blocks or text ranges are patched, preserving comments and per-block
history.

### Conflicts

There is nothing docsync-specific. A push after someone edited the same
document is rejected as non-fast-forward. `git pull` performs a three-way merge
of your version, theirs, and the common base that `origin/main` already tracks.
Conflicts appear as ordinary conflict markers in the Markdown file. Resolve,
commit, push.

Because conversion is canonical and Markdown is line-oriented, most concurrent
edits to different paragraphs merge cleanly.

---

## 8. Deletion, precisely

| What you did | What happens at the source |
|---|---|
| Removed a root from the manifest | Nothing. |
| Added an ignore pattern | Nothing. |
| Deleted a tracked file and pushed | The document is moved to trash. Recoverable from the source UI for about 30 days. |
| Deleted a file with no frontmatter | Nothing. It was never at the source. |

There is no flag to confirm deletions. The review before you push is the gate.
`docsync push` lists every trashed document in its output.

---

## 9. Remote URL

The remote URL is `docsync::<manifest>`, where `<manifest>` is one of:

| Form | Meaning |
|---|---|
| `docsync::.docsync.yaml` | Relative to the repo's working tree. The default from `init`. |
| `docsync::/abs/path/manifest.yaml` | Any file. Use this to share a manifest, for example one committed to ai-starter. |
| `docsync::../ai-starter/checkouts/sales.yaml` | Relative paths always resolve against the working tree, never the shell's directory. |
| `docsync::gdocs:<id>`, `docsync::notion:<id>` | **later**: the manifest is itself a document at the source. |

`git clone docsync::/abs/path/manifest.yaml my-docs` is a normal clone.

Several checkouts can share one manifest. Manifest history, if you want it, is
the history of whatever git repo the manifest file lives in.

---

## 10. Working with agents

The intended loop:

1. `docsync pull` so the agent starts from the current source state.
2. The agent edits files on a branch and commits.
3. You review with `git diff main..agent/foo`, or as a pull request if the
   checkout is mirrored to a git host.
4. Merge, `docsync push`.

Give the agent the repo, not the credentials. It never needs to call a source
API, and `git push` is the only side-effecting step.

---

## 11. Limitations of the first version

- Notion databases are not synced. Pages inside a database are not synced either.
- Non-document Drive files are skipped.
- Write-back replaces the body (see §7). Block-level comments on Notion and
  comment anchors on Google Docs may not survive an edit to that block.
- Google Docs revisions are collapsed into one commit per fetch.
- Formatting outside the Markdown dialect is preserved only as placeholders.
- One branch (`main`) per remote. Other local branches are fine; the helper only
  serves `main`.

---

## 12. Command reference

```
docsync init    [<dir>] [<src>[=<path>]...]
docsync add     <src>[=<path>]... [--no-fetch]
docsync remove  <path>...
docsync status
docsync fetch
docsync pull
docsync push
docsync resolve <src>
docsync auth    <source>
docsync --version
```

Source refs: `notion:<id>`, `gdocs:<id>`. Notion and Drive URLs are accepted
everywhere a source ref is, and normalised to a ref.
