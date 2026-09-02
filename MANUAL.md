# docsync — user manual

`docsync` gives you a git workflow over documents that live in Notion and
Google Drive. You check documents out as Markdown files, edit them locally (by
hand or with an agent), review the diff, and push. If the source changed while
you were working, git's ordinary three-way merge resolves it.

Nothing touches a source document until you push.

> Status: this manual is the specification. It describes intended behaviour and
> is written before the code. Sections marked **later** are out of scope for the
> first version.

---

## 1. Concepts

| Term           | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Source**     | A document store: `notion` or `gdocs`.                                                                                      |
| **Source ref** | An address of one object in a source: `notion:<page-id>` or `gdocs:<file-or-folder-id>`. Canonical forms in §13. |
| **Root**       | One source ref checked out under one local path. A checkout is a set of roots.                                              |
| **Manifest**   | A YAML file listing the roots. It _is_ the remote: the repo's git remote URL points at it.                                  |
| **Helper**     | `git-remote-docsync`, the program git runs on fetch and push. You rarely call it directly.                                  |
| **Document** | One Notion page, one Google Doc, or one other Drive file. The smallest thing you can check out. Changes *within* a document are synced by diff. |

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

Both sources use OAuth with a temporary localhost callback server. docsync is
published on the public npm registry, so it ships no OAuth app of its own. You
bring one per source.

| Source | Sign in | What you need |
|---|---|---|
| Google | `docsync auth gdocs` (`google` is accepted too) | An OAuth client of type *Desktop app* in Google Cloud Console, with the Drive API and the Docs API enabled. |
| Notion | `docsync auth notion` | A *public* integration in Notion's integration settings, with `http://localhost:27183/callback` and `http://localhost:27184/callback` as redirect URIs. |

`docsync auth <source>` looks for the client in `~/.docsync/oauth-apps.yaml`.
When the entry is missing, it writes a template and opens it in `$EDITOR`
(`%EDITOR%` or Notepad on Windows):

```yaml
# OAuth apps used by docsync. This file is yours; docsync only reads it.
# Your team registers one app per source and shares the values; paste them here.
# Registering the apps yourself is documented in MANUAL.md §2.

google:
  client_id: ""
  client_secret: ""

notion:
  client_id: ""
  client_secret: ""
```

Most people never register anything: one person on the team creates the two
apps (table above) and shares the values through the team's secret store.

Save, close, and the browser flow starts. Before opening the browser the
terminal says what to grant. For Notion you pick pages in Notion's own
dialog: grant the teamspaces you work in, since everything under a granted
page is included, and you can change the selection later under Notion's
Settings → Connections. For Google, approve the Drive and Docs scopes.
Nothing needs to be shared with an integration by hand.
The resulting tokens are stored in the OS keychain (macOS Keychain, Windows
Credential Manager, Secret Service on Linux). The apps file is written with
owner-only permissions and holds the client secrets and nothing else.

A team can share one app per source. The ai-starter setup can drop a
pre-filled `oauth-apps.yaml` in place from the team's secret store.

`docsync auth <source>` also verifies an existing token and prints who you are
signed in as. `docsync auth <source> --logout` removes the token. Every command
that needs a credential fails immediately and clearly when one is missing,
with the command to run. Only `docsync auth` ever opens the editor; a token
renewal during another command fails with a pointer to the apps file instead.

### Home directory

`~/.docsync/` holds `oauth-apps.yaml` and caches. Tokens are in the keychain,
not here. On Windows this is `%USERPROFILE%\.docsync\`.

---

## 3. Quick start

```bash
# a checkout of one Notion page tree and one Drive folder
docsync init my-docs notion:2f3a9c… gdocs:1AbCdE…
cd my-docs
ls
```

```
.agents/  .claude/  .cursor/   # skill file for agents (§10)
Product Specs/          # the Notion page's sub-pages
Product Specs.md        # the Notion page
Contracts/              # the Drive folder, recursively
```

Edit, review, push:

```bash
$EDITOR "Product Specs/Auth.md"
git diff
git commit -am "Clarify session expiry"
git push
git pull
```

Get upstream changes:

```bash
git pull
```

That is the whole workflow. Everything below is detail.

The `git pull` after the push is there because a push produces one follow-up
commit at the remote (§7). `docsync push` does the push and that pull in one
step, and prints what happened to each document.

---

## 4. The manifest

The manifest defines what is checked out. Default location: `.docsync.yaml`
in the repo, untracked. It can live anywhere the remote URL can reach (§9).

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

| Field    | Required | Meaning                                                      |
| -------- | -------- | ------------------------------------------------------------ |
| `src`    | yes      | Source ref.                                                  |
| `path`   | yes      | Local path, relative to the repo root. See path rules below. |
| `ignore` | no       | List of patterns. Matching documents are not checked out.    |

### Path rules

- A path with a **trailing slash** (`Contracts/`) is a directory. The root's
  own document is placed inside it under its source title. For a folder or a
  page with children, the children go in there too.
- A path **without** a trailing slash (`notes/roadmap.md`) names the file
  itself. Only valid for a single document with no children, and it must carry
  an extension: `.md` for a Notion page or a Google Doc, its own for any other
  Drive file. Write `notes/roadmap/` if you meant a directory.
- Paths are relative to the repo root. No leading `/`, no `.` or `..` segment,
  no empty segment, no segment starting with a dot, no `\`. Unicode is
  normalised to NFC.
- Paths must not overlap. Two roots cannot claim the same file, and one root's
  path cannot be inside another's. A file root owns the sibling directory with
  the same stem as well, since that is where its children would land, so no
  other root may sit inside `specs/auth/` while `specs/auth.md` is a root. The
  pair `specs/auth.md` and `specs/auth/` is itself fine: that is exactly what
  one Notion page with children produces.
- Paths are case-sensitive, and the helper refuses two names that differ only in
  case, because macOS and Windows do not. It compares after NFC normalisation
  for the same reason.
- Always use `/` as the separator, on every platform.

### Ignore patterns

Two forms, mixable in one list:

- **gitignore syntax** matched against the title-derived path relative to the
  root's directory (so a child of the root page is `Blocks.md` and its child
  `Blocks/Nested.md`, whatever the root's own filename), e.g. `Archive/**`, `*.pdf`, `Meeting notes/2023-*`.
- **A source ref**, e.g. `notion:8c1d…`. Ignores that document (and its
  children) regardless of title. Use this when titles move.

Negation patterns (`!Archive/2024/**`) work, with git's own restriction: a file
cannot be re-included once a parent directory is excluded, so re-include the
directory too (`!Archive/2024/`). A source ref is an identity rather than a
path, so no negation undoes one. The root object itself is never ignored —
`docsync remove` is what unsubscribes from a root.

An ignore added after files were fetched removes them locally on the next fetch.
That is an unsubscribe. The source is not touched.

---

## 5. Commands

### `docsync init [<dir>] [<src>[=<path>]...]`

Creates a checkout.

1. Creates `<dir>` (default: current directory, which must be empty).
2. Writes an empty manifest to `.docsync.yaml`.
3. `git init -b main`, with `core.autocrlf=false` so line endings are LF
   everywhere.
4. Adds `.docsync.yaml` and the skill file paths to `.git/info/exclude`.
5. Writes the skill file (§10).
6. For each `<src>` given, resolves it at the source and appends a root
   (same code path as `docsync add`).
7. `git remote add origin docsync::.docsync.yaml`.
8. `git fetch origin` and `git checkout --track origin/main`.

Resolving a source ref is where a missing or invalid credential, or a page not
shared with the integration, fails. That happens before the repo is built.

With no sources, the result is a repo with one empty commit. Add roots later.

### `docsync add <src>[=<path>]...`

Resolves each source ref, appends roots to the manifest, then fetches and
fast-forwards if the working tree is clean.

The `=<path>` alias is optional. A trailing slash means "under this
directory, named by the source title". No trailing slash means "exactly this
name".

| Alias | Leaf document | Page with children, or folder |
|---|---|---|
| none | `<title>.md` | `<title>/` |
| `=specs/` | `specs/<title>.md` | `specs/<title>/` |
| `=specs/auth.md` | `specs/auth.md` | error: a container cannot be a file |
| `=specs/auth` | error: a document needs an extension | `specs/auth/` |

The manifest stores the resolved path, so a later title change at the source
does not move the root. A leaf document that later gains children keeps its
file path; the children go in a sibling directory with the same stem
(`specs/auth.md` and `specs/auth/`).

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

| Source object                             | On disk                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Google Doc                                | `<title>.md`                                                       |
| Other Drive file (PDF, image, `.docx`, …) | `<title>` with its own extension, byte-for-byte                    |
| Google Sheet / Slides / Drawing           | `<title>.xlsx` / `.pptx` / `.svg`, exported, read-only             |
| Drive folder                              | `<title>/` containing its files and sub-folders, recursively       |
| Notion page, no children                  | `<title>.md`                                                       |
| Notion page with child pages              | `<title>.md` **and** `<title>/` beside it, containing the children |

Filenames are derived from titles:

1. The title, normalised to NFC and trimmed.
2. `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` and control characters
   (U+0000–U+001F, U+007F) replaced by `-`.
3. Leading dots removed, so nothing turns into a hidden file; trailing dots and
   spaces trimmed.
4. A Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
   `LPT1`–`LPT9`) suffixed with `-`. The check is on the part before the first
   dot, because `CON.md` is as unusable on Windows as `CON` is.
5. An empty result becomes `untitled`.
6. The name truncated on a character boundary so that it is at most 200 bytes
   of UTF-8, extension included.

Collisions within one directory get a numeric suffix before the extension
(`Notes.md`, `Notes (2).md`), and the comparison is case-insensitive. The
suffixes are stable across fetches because the mapping is by id: a document
keeps the name it had for as long as its title still derives to it, so
`Notes (2).md` stays put even after `Notes.md` is gone.

### Identity

**Markdown documents** carry YAML frontmatter that docsync owns:

```yaml
---
id: notion:2f3a9c…
title: Auth
---
```

- `id` is the identity. Renaming the file does not change which document it is.
- `title` is what the source shows. Changing it and pushing renames the document
  at the source. The filename follows on the next fetch.
- A new `.md` file inside a root **without** frontmatter is a new document. On
  push it is created at the source, under the folder or parent page its path
  implies, titled from its filename without the extension. The id arrives with
  the post-push fetch (§7).
- Do not add your own keys to the frontmatter. They will be dropped.

**Binary files** have no frontmatter. Their ids live in `.docsync/index.yaml`,
a tracked file the helper writes on every fetch. It maps every checked-out path
to its source ref and type. Do not edit it. A new binary file inside a Drive
root is uploaded on push and appears in the index after the post-push fetch.

Renames of either kind are detected by git's rename detection and resolved to
the same id.

### Markdown dialect

Body content is GitHub-flavoured Markdown with a small set of extensions.
Conversion is **canonical**: fetching a document and pushing it unchanged
produces no change at the source and no diff on the next fetch. This property
is what makes the tool work, and it is tested for every row in the tables
below.

#### Notion blocks

| Notion                                                                                                   | Markdown                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| paragraph                                                                                                | paragraph                                                                                                              |
| heading 1 / 2 / 3                                                                                        | `#` / `##` / `###`                                                                                                     |
| bulleted list                                                                                            | `- item`, nested by two spaces                                                                                         |
| numbered list                                                                                            | `1. item`                                                                                                              |
| to-do                                                                                                    | `- [ ] item` / `- [x] item`                                                                                            |
| quote                                                                                                    | `> text`                                                                                                               |
| callout | `> [!CALLOUT] 💡` on the first line, body quoted below. Push also accepts the escaped spelling `> \[!CALLOUT]` that some editors produce. |
| toggle | `<details><summary>title</summary>`, a blank line, the children, a blank line, `</details>`. The blank line before the closing tag is required. |
| toggle heading | the same, with the heading inside the summary: `<summary>## Title</summary>` |
| code | fenced block with the language. Notion's `plain text` is a fence with no language. |
| divider                                                                                                  | `---`                                                                                                                  |
| table                                                                                                    | GFM table. Cells hold inline formatting only.                                                                          |
| equation                                                                                                 | `$$ … $$` block; `$ … $` inline                                                                                        |
| image, file, PDF, video with an **external** URL | `![caption](url)` for images, `[name](url)` for the rest. On push a bare link block becomes a `file` block. |
| image, file, PDF hosted by Notion                                                                        | downloaded next to the page into `<title>.assets/` and linked relatively (**later**; placeholder in the first version) |
| child page                                                                                               | its own file, not in the body                                                                                          |
| link to page, page mention | `[title](relative/path.md)` if the target is in the checkout, otherwise `[title](https://www.notion.so/<id>)`, with `Untitled` when the page is not accessible. Both convert back to a mention on push. |
| user mention | `[@Name](notion://user/<id>)` |
| date mention | `[2026-09-02](notion://date/2026-09-02)`; ranges and times appended to the path |
| other mentions | `[text](url)` |
| bookmark, embed, synced block, database, columns, table of contents, breadcrumb, button, everything else | placeholder                                                                                                            |

Inline: bold, italic, strikethrough, code, links as in GFM. Underline is
`<u>…</u>`. Text and background colours are `<span data-color="red">…</span>`.
These are preserved so that a round trip does not strip them. A line break
inside one block is two trailing spaces and a newline.

**Block attributes.** What Notion stores on a block that GFM cannot express
goes in an HTML comment on its own line directly above the block, only when
the value is not the default. Two attributes exist: block colour on any block,
and header flags on tables, whose Notion default is no header row while GFM
always renders one.

```markdown
<!-- docsync: color=green -->

A paragraph in green.

<!-- docsync: color=gray_background -->

> [!CALLOUT] 💡
> Callout body.

<!-- docsync: header-row=false -->

| Name | Value |
|---|---|
| a | b |
```

Colour values are Notion's own (`gray_background`, `red`). A blank line
separates the comment from its block, as between any two blocks. List items
carry no attribute comment, since one would break the list, so a colour on a
list item does not survive a round trip. Numbered lists that use letters or
roman numerals are not represented either.

#### Google Docs elements

| Google Docs                                   | Markdown                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Title / Subtitle | `# Title` / `## Subtitle`, each with `<!-- docsync: style=title -->` or `style=subtitle` on the line above, since a plain `#` is Heading 1 |
| Heading 1–6                                   | `#` … `######`                                                                                        |
| paragraph                                     | paragraph                                                                                             |
| bulleted / numbered list, nested              | `-` / `1.`, nested by indentation                                                                     |
| checklist                                     | `- [ ]` / `- [x]`                                                                                     |
| table                                         | GFM table. Merged cells are not supported and make the table a placeholder.                           |
| horizontal rule                               | `---`                                                                                                 |
| page break                                    | `<!-- docsync:pagebreak -->`                                                                          |
| footnote                                      | `[^n]` with the definition at the end                                                                 |
| image | `<!-- docsync:object gdocs:<objectId> type=image -->` in the first version; downloaded into `<title>.assets/` and linked relatively **later** |
| link                                          | `[text](url)`                                                                                         |
| bold, italic, strikethrough, code font        | as in GFM                                                                                             |
| underline                                     | `<u>…</u>`                                                                                            |
| text colour, highlight, font, size, alignment | not represented. See write-back limitations (§7).                                                     |
| comments, suggestions                         | not in the body. They stay at the source.                                                             |

#### Placeholders

Anything the dialect cannot represent becomes:

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

**Later:** replay the Drive revision list as individual commits, so `git log`
shows real per-edit history for Google Docs.

### Push

Git sends the commits between `origin/main` and your branch. The helper:

1. Rejects the push if `origin/main` is not an ancestor of what you push. This
   is git's normal non-fast-forward rule. Fetch, merge or rebase, push again.
2. Reads the manifest. Added or modified files under no root are refused.
   Deleted files under no root are ignored: that is what `docsync remove`
   produces, and it means unsubscribe, not trash. Changes to
   `.docsync/index.yaml` are refused.
3. Refuses changes to read-only exports (Sheets, Slides, Drawings).
4. Diffs the tree per root and applies:
   - **modified** → update the document (see Write-back below)
   - **added** → create the document, or upload the binary
   - **deleted** → trash the document (Notion archive, Drive trash). Never
     permanent. Printed prominently.
   - **renamed** → same document (by id), possibly a title change and, for
     Drive, a move between folders
5. **Post-push fetch.** Re-reads every document it touched. If the canonical
   form differs from what was pushed (new ids, source-side normalization), it
   writes one more commit on top of `origin/main`. Your branch is then one
   fast-forward behind. `docsync push` fast-forwards for you when the working
   tree is clean; after plain `git push`, run `git pull`.

### Force push

Not supported. The helper rejects a forced push. A force push would mean
writing your tree over a source state the helper has never seen, and once
write-back is diff-based (§12) there is no base to compute the diff from. Fetch,
merge, push.

### Write-back

The first version replaces the document body.

- **Notion:** every block except child pages is deleted and the body is
  regenerated. Block-level comments, per-block history, and any block the API
  cannot create (link previews, synced-block references) are lost on the
  edited page. Page-level comments, properties, sharing, child pages and the
  page id survive.
- **Google Docs:** the body text is replaced. Text colour, highlight, fonts,
  sizes and alignment **inside the body are lost on every push**, because the
  dialect cannot carry them. Document-level defaults, named styles, sharing,
  comments and the file id survive, but comment anchors may detach. In practice
  this makes the first version suitable for Docs that are plain prose, and
  unsuitable for heavily formatted ones.
- **Drive binaries:** a new revision of the same file is uploaded. Everything
  else about the file is untouched.

**Later, and the top item on the roadmap:** diff-based write-back. Block ids
and paragraph ranges are tracked, and only what changed is patched. That keeps
formatting outside the dialect on untouched paragraphs, and keeps comments
anchored.

### Conflicts

There is nothing docsync-specific. A push after someone edited the same
document is rejected as non-fast-forward. `git pull` performs a three-way merge
of your version, theirs, and the common base that `origin/main` already tracks.
Conflicts appear as ordinary conflict markers in the Markdown file. Resolve,
commit, push.

Because conversion is canonical and Markdown is line-oriented, most concurrent
edits to different paragraphs merge cleanly. Binary files conflict as a whole.

---

## 8. Deletion, precisely

| What you did                      | What happens at the source                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Removed a root from the manifest  | Nothing.                                                                          |
| Added an ignore pattern           | Nothing.                                                                          |
| Deleted a tracked file and pushed | The document is moved to trash. Recoverable from the source UI for about 30 days. |
| Deleted a file with no id         | Nothing. It was never at the source.                                              |

There is no flag to confirm deletions. The review before you push is the gate.
`docsync push` lists every trashed document in its output.

---

## 9. Remote URL

The remote URL is `docsync::<manifest>`, where `<manifest>` is one of:

| `<manifest>` | Meaning |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `.docsync.yaml`                      | Relative to the repo's working tree. The default from `init`.                        |
| `/abs/path/manifest.yaml`            | Any file. Use this to share a manifest, for example one committed to ai-starter.     |
| `../ai-starter/checkouts/sales.yaml` | Relative paths always resolve against the working tree, never the shell's directory. |
| `gdocs:<id>`, `notion:<id>` | **later**: the manifest is itself a document at the source.                          |

`git clone docsync::/abs/path/manifest.yaml my-docs` is a normal clone. The
helper writes the skill file during it.

Several checkouts can share one manifest. Manifest history, if you want it, is
the history of whatever git repo the manifest file lives in.

---

## 10. Working with agents

### The skill file

Every checkout contains a skill file that tells an agent how to work in a
docsync checkout: pull first, edit on a branch, never touch frontmatter or the
index, never edit inside placeholders, and never push unless asked.

The same file is written to the three locations the supported agents read:

| Agent       | Path                              |
| ----------- | --------------------------------- |
| Codex       | `.agents/skills/docsync/SKILL.md` |
| Claude Code | `.claude/skills/docsync/SKILL.md` |
| Cursor      | `.cursor/skills/docsync/SKILL.md` |

They are plain copies, excluded from git via `.git/info/exclude`. Every
`docsync` command and every helper run compares them with the bundled copy of
the installed version and overwrites them when they differ, so upgrading
docsync updates every checkout the next time it is touched. Do not edit them;
your edits will be overwritten.

### The loop

1. `docsync pull` so the agent starts from the current source state.
2. The agent edits files on a branch and commits.
3. You review with `git diff main..agent/foo`.
4. Merge, `docsync push`.

---

## 11. Windows

docsync is expected to work on Windows. Specifically:

- Paths in manifests and frontmatter always use `/`.
- Line endings are LF. `init` sets `core.autocrlf=false`.
- Filenames avoid reserved characters and names (§6).
- No symlinks anywhere. The skill file is a copy.
- `~/.docsync/` is `%USERPROFILE%\.docsync\`.
- First `docsync auth` may trigger the Windows firewall prompt for the
  loopback listener. Allow it; the listener only binds `127.0.0.1`.
- **To verify early:** Git for Windows must be able to execute the
  `git-remote-docsync` shim that npm installs. If it cannot run a `.cmd` shim,
  the package ships a small `.exe` launcher instead.

---

## 12. Roadmap

### Phase 1 — the core loop

Everything in this manual not marked **later**. Limitations of phase 1:

- Notion databases are not synced. Pages inside a database are not synced either.
- Sheets, Slides and Drawings are exported read-only.
- Write-back replaces the body (§7). Google Docs lose range-level formatting on
  push. Notion loses block-level comments on edited pages.
- Images and files hosted by the source are placeholders, not downloaded.
- Google Docs revisions are collapsed into one commit per fetch.
- One branch (`main`) per remote. Other local branches are fine; the helper only
  serves `main`.

### Phase 2 — attachments

Files hosted by the source are downloaded on fetch into `<title>.assets/` next
to the document and linked relatively from the Markdown. This is required for
Notion anyway, since its hosted-file URLs are signed and expire after an hour.

Push uploads new or changed files. Notion's File Upload API accepts the bytes
directly (single request up to 20 MB, multipart above) and the upload is
attached to the image, file, PDF or video block. For Google Docs the image is
uploaded to Drive and inserted by reference.

### Phase 3 — diff-based write-back

Block ids and paragraph ranges are tracked, and only what changed is patched.
Keeps formatting outside the dialect on untouched paragraphs, and keeps
comments anchored. Removes the biggest phase-1 limitation for Google Docs.

### Phase 4 — comment threads

Pull comment threads alongside the document, push replies and resolutions.
Comments can be client-facing, so docsync never writes a comment on its own;
only what you author and push. File format to be designed when we get there.

### Later

- Google Docs revision history replayed as individual commits.
- Manifest stored at the source: `docsync::gdocs:<id>`.
- Notion databases.
- Writable Sheets and Slides, if a lossless path exists.

---

## 13. Command reference

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

Source refs: `notion:<id>`, `gdocs:<id>`. A Notion id is 32 lowercase hex
characters without dashes; dashed and uppercase forms are accepted on input
and normalised. A Google id is stored verbatim. Wherever a command takes a
source ref, it also takes a Notion, Google Docs or Drive URL, `http` or
`https`, and normalises it. Manifests and ignore lists hold canonical refs
only, never URLs.
