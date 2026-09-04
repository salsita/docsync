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
Product Specs.md        # the Notion page
Product Specs/          # its sub-pages, recursively (§6)
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
    path: Product Specs.md
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
| `comments` | no     | `true` to pull comment threads and suggestions into sidecars (§6). Default `false`. |

### Path rules

- A path with a **trailing slash** (`Contracts/`) is a directory. A Drive
  folder's contents go in there. A document is placed inside it under its
  source title, and a Notion page's children in the sibling directory of the
  same stem beside it (`specs/Auth.md` and `specs/Auth/`).
- A path **without** a trailing slash (`notes/roadmap.md`) names the file
  itself. Valid for any single document, Notion page with children included;
  the children go in the sibling directory (`notes/roadmap/`). It must carry
  an extension: `.md` for a Notion page or a Google Doc, its own for any other
  Drive file. A Drive folder cannot be a file root.
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

1. Resolves each `<src>` given at the source. This is where a missing or
   invalid credential, or a page not shared with the integration, fails,
   before anything is written.
2. Creates `<dir>` (default: current directory, which must be empty or an
   empty git repository).
3. Writes an empty manifest to `.docsync.yaml`.
4. `git init -b main`, with `core.autocrlf=false` so line endings are LF
   everywhere.
5. Adds `.docsync.yaml`, the skill file paths, `.prettierrc`,
   `.editorconfig` and `.gitattributes` to `.git/info/exclude`.
6. Writes the skill file (§10), `.prettierrc` and `.editorconfig` (§6
   "Formatters and editors"), and `.gitattributes` marking `*.assets/**`
   as binary so diffs stay readable.
7. Appends a root per resolved `<src>` (same code path as `docsync add`).
8. `git remote add origin docsync::.docsync.yaml`.
9. `git fetch origin` and `git checkout --track origin/main`.

With no sources, the result is a repo with one empty commit. Add roots later.

### `docsync add <src>[=<path>]...`

Resolves each source ref, appends roots to the manifest, then fetches and
fast-forwards if the working tree is clean.

The `=<path>` alias is optional. A trailing slash means "under this
directory, named by the source title". No trailing slash means "exactly this
name".

| Alias | Document (a Notion page, with or without children, or a Drive file) | Drive folder |
|---|---|---|
| none | `<title>.md` | `<title>/` |
| `=specs/` | `specs/<title>.md` | `specs/<title>/` |
| `=specs/auth.md` | `specs/auth.md` | error: a folder cannot be a file |
| `=specs/auth` | error: a document needs an extension | `specs/auth/` |

A Notion page's children always go in the sibling directory with the same
stem as its file (`specs/auth.md` and `specs/auth/`), so a page that gains
children later does not move. The manifest stores the resolved path, so a
later title change at the source does not move the root either.

### `docsync remove <path>...`

Removes the roots whose `path` matches, deletes the local files, commits the
deletion locally. The source is not touched, now or later: the helper reads a
root that is gone from the manifest as an unsubscribe. Run `docsync pull`
before the next push. The pull's pre-flight fetch (§7) records the unsubscribe
as a commit at the remote, which merges cleanly with your local deletion; a
push without that pull is refused as "the source changed".

### `docsync status`

Like `git status`, plus one line per root: source, path, last fetched time,
whether the source has moved since (a cheap metadata check, no download), and
`comments on` when the root pulls comment sidecars (§4).

### `docsync fetch` / `docsync pull` / `docsync push`

Thin wrappers over the git commands with docsync-specific output:

- `push` prints, per document, what it did (created, updated, trashed), then
  fetches and fast-forwards the current branch onto the follow-up commit (§7)
  when the working tree is clean. It is a fetch and a merge, not a merge
  alone: after `git push`, `origin/main` still points at what was pushed, and
  the follow-up commit only arrives with another fetch.
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
| Files hosted inside a page or Doc         | `<title>.assets/` beside `<title>.md`, one file each, linked from the body |

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
- A new `.md` file inside a root is a new document **when it starts with
  frontmatter**. The minimum is the two fences with nothing between them;
  `title` is optional and defaults to the filename without the extension:

  ```yaml
  ---
  title: Auth
  ---
  ```

  On push it is created at the source, under the folder or parent page its
  path implies. The id arrives with the post-push fetch (§7).
- A new `.md` file **without** frontmatter under a Drive root is a plain
  file and is uploaded as one. Under a Notion root it is refused, since Notion
  holds no files; add the frontmatter to create a page.
- Adding frontmatter to a plain file, or removing it from a document, changes
  what the path is. Push treats it as a delete and a create: the old object is
  trashed and a new one is made, with a new id.
- A new file whose frontmatter carries an `id` the checkout already has, which
  is what copying a fetched document produces, is refused. Remove the `id`
  line to create a copy.
- Do not add your own keys to the frontmatter. They will be dropped.
- The `.comments.md` suffix is docsync's own, for the comment sidecar. A
  source document whose title derives to it is refused on fetch: rename it
  at the source.

**Binary files**, a Markdown file stored in Drive included, have no
frontmatter and are checked out verbatim. The files in a `<title>.assets/`
directory are binaries of this kind too, owned by their document; the index
records which block or object each one is and its checksum. Their ids live in `.docsync/index.yaml`,
a tracked file the helper writes on every fetch. It maps every checked-out path
to its source ref and type, and marks a Google Doc that had a pending
suggestion at the last fetch (`suggested: true`). Do not edit it. A new binary file inside a Drive
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
| callout | `> [!CALLOUT] 💡` on the first line, body quoted below. Push also accepts the escaped spelling `> \[!CALLOUT]` that some editors produce. The marker line works with or without the line break after it. |
| toggle | `<details><summary>title</summary>`, a blank line, the children, a blank line, `</details>`. The blank line before the closing tag is required. |
| toggle heading | the same, with the heading inside the summary: `<summary>## Title</summary>` |
| code | fenced block with the language. Notion's `plain text` is a fence with no language. |
| divider                                                                                                  | `---`                                                                                                                  |
| table                                                                                                    | GFM table. Cells hold inline formatting only.                                                                          |
| equation                                                                                                 | `$$ … $$` block; `$ … $` inline                                                                                        |
| image, file, PDF, video with an **external** URL | `![caption](url)` for images, `[name](url)` for the rest. On push a bare link block becomes a `file` block. A PDF or video block therefore comes back as a `file` block after a push and fetch. |
| image, file, PDF, video hosted by Notion | downloaded next to the page into `<title>.assets/` and linked relatively: `![caption](<title>.assets/photo.png)` for an image, `[caption](<title>.assets/spec.pdf)` for the rest, with the file's own name as the link text when it has no caption. The name comes from Notion's, or from the URL's last segment, made unique by the filename rules above and kept stable by the index. On push a link into that directory is uploaded and the block points at the upload; the block type follows the link form and the extension: `![]()` → image, `.pdf` → pdf, a video extension → video, anything else → file. A hosted block whose file could not be downloaded keeps the placeholder |
| child page                                                                                               | its own file, not in the body                                                                                          |
| link to page, page mention | `[title](relative/path.md)` if the target is in the checkout, otherwise `[title](https://www.notion.so/<id>)`, with `Untitled` when the page is not accessible. Both convert back to a mention on push. |
| user mention | `[@Name](notion://user/<id>)` |
| date mention | `[2026-09-02](notion://date/2026-09-02)`; ranges and times appended to the path |
| other mentions | `[text](url)` |
| bookmark, embed, synced block, database, columns, table of contents, breadcrumb, button, everything else | placeholder                                                                                                            |

Inline: bold, italic, strikethrough, code, links as in GFM; italic is
written `_like this_`, bold `**like this**`. Bold italic nests as `**_like
this_**`. Table cells are padded by display width, so an emoji or a CJK
ideograph counts as two columns; that is how Prettier measures, and it is
what keeps a formatted table identical to a fetched one. Underline is `<u>…</u>`. Text and
background colours are `<span data-color="red">…</span>`. These are preserved
so that a round trip does not strip them. A line break inside one block is a
backslash at the end of the line. Push also accepts `*italic*` and the
two-trailing-spaces line break, since that is what many editors produce.

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
| checklist                                     | `- [ ]` / `- [x]`. The Docs API does not report which box is ticked, so every item is fetched as `- [ ]`, and a pushed `- [x]` does not survive the next fetch. A pushed checklist is created as one                                                                                     |
| table                                         | GFM table. Merged cells are not supported and make the table a placeholder.                           |
| horizontal rule                               | `---`. The Docs API cannot create one, so a rule is dropped on push and does not survive                                                                                                 |
| page break                                    | `<!-- docsync:pagebreak -->` on its own line. Docs keeps a page break inside a paragraph, so a paragraph containing one is fetched as two paragraphs around the comment                                                                          |
| footnote                                      | `[^n]` with the definition at the end                                                                 |
| image | downloaded into `<title>.assets/` and linked relatively where it sits, `![alt](<title>.assets/image-1.png)`, with the object's alt text as the alt and a name from its position and content type. An image the fetch did not download keeps `<!-- docsync:object gdocs:<objectId> type=image -->`, and a drawing is always that placeholder. On push an image is uploaded to Drive, shared for the one request that inserts it, then unshared and trashed; a file that is not an image is refused with "Google Docs cannot hold a file; link to it instead", and the alt text of a pushed image is lost, since the API cannot set it |
| link                                          | `[text](url)`                                                                                         |
| bold, italic, strikethrough, code font        | as in GFM                                                                                             |
| underline                                     | `<u>…</u>`                                                                                            |
| text colour, highlight, font, size, alignment | not represented. See write-back limitations (§7).                                                     |
| comments, suggestions                         | not in the body; open ones in the sidecar `<title>.comments.md` ("Comments and suggestions" below)       |

#### Placeholders

Anything the dialect cannot represent becomes:

```
<!-- docsync:block notion:8f2e… type=embed -->
<!-- docsync:block gdocs:<documentId>#<startIndex> type=table -->
<!-- docsync:object gdocs:<objectId> type=drawing -->
```

A Notion block has an id. A Google Docs structural element does not, so it
is addressed by its document and the index it starts at; an inline object
(image, drawing) has an id of its own and uses the `docsync:object` form.

#### Formatters and editors

The dialect is **stable under Prettier with default options**: formatting a
fetched file changes nothing, so a formatter that runs on save in Cursor or
VS Code produces no churn. `docsync init` writes a `.prettierrc` that pins
`proseWrap: preserve` and an `.editorconfig` that keeps line endings LF and
turns trailing-whitespace trimming off for Markdown, so an IDE's own defaults
cannot undo this. Caveats:

- **Double spaces collapse.** Prettier turns two spaces inside a sentence
  into one. Fetch keeps them; a formatted file loses them, and the next push
  writes the single space. The change is visible in your diff before you
  push, never silent.
- **Other formatters are not covered.** markdownlint with fixes, or an
  editor's own Markdown formatter, may rewrite bullets, numbering or table
  padding. Push accepts what they produce, but the next fetch normalises it
  back, which shows up as churn in the history. Turn them off for checkouts.
- **Whitespace trimming** deletes nothing the dialect relies on, since line
  breaks are backslashes, but it does change a fenced code block whose
  content has trailing spaces. That is the block's content, and it pushes.

Placeholders round-trip. Deleting one deletes the block; editing or moving
one is refused, since the block cannot be recreated.

An empty paragraph has no Markdown form. It shows as blank lines on fetch,
survives a push that does not touch it, and cannot be created by one.

### Comments and suggestions

With `comments: true` on a root (§4), open comment threads and pending
suggestions are pulled into a sidecar file beside each document,
`<title>.comments.md`, which exists only while the document has at least
one. Turning the option off removes the sidecars on the next fetch. It is **read-only**: a push that changes, adds or
removes one is refused before any source is touched, with the `git checkout`
command that restores it. Replying, resolving, accepting and rejecting stay
in the source's own UI (§12). The body file never carries a comment.

The sidecar is Markdown, one `##` heading per thread, in the order the
anchors appear in the body:

```markdown
---
document: gdocs:1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4
fetched: 2026-09-03T16:31:07Z
---

## AAACFLfYEtk — comment

> Paragraph before a ==page break==.

in: Heading six

**Jiří Staniševský** · 2026-09-03 07:55
Makes the page break.

**Jane Client** · 2026-09-03 09:12
Agreed, leave it.

## suggest.r73ve12ed25a — suggestion

in: Heading six

```diff
- Let's us collaborate on this text.
+ Let's us collaborate on the paragraph.
```
```

- **Anchor.** The paragraph, list item, heading or table cell that contains
  the commented text, quoted as it is written in the body, with the
  commented words marked `==like this==`; then `in:` and the nearest heading
  above it, `(top)` when there is none. On Notion a comment belongs to a
  whole block, so the block is quoted without marks; a comment on the page
  itself has no quote and comes first. When the quoted text is found nowhere
  in the body, the bare text is quoted and `in:` says `(not found)`. When it
  is found in two places, the first wins.
- **Suggestion** (Google Docs only): the paragraph as it stands and as it
  would read with the suggestion accepted, as a diff. Two suggestions in one
  paragraph are two threads. A pure formatting suggestion has the quote,
  the `in:` line, then `formatting only` in place of the diff.
- **Entries** are author, time (UTC, to the minute) and text, in creation
  order. Deleted entries are omitted. The thread id is the source's: the
  Drive comment id, or the Notion discussion id in the bare form the
  frontmatter uses.
- **Resolved threads are not in the file.** A thread disappears from the
  sidecar when it is resolved or deleted at the source, which the next pull
  shows as a diff.
- **Order** is the anchor's position in the body; threads whose anchor is
  not found come last; ties by creation time.

Notion's API reports a comment on a text selection as a comment on the
block, and gives no time finer than the minute. A Notion integration needs
the "read comments" capability, listed in the grant hint of `docsync auth
notion`; the API gives no way to check it before the first fetch.

---

## 7. Fetch and push semantics

### Fetch

For each root, the helper lists documents at the source and compares last-edit
metadata with what it recorded last time. Only changed documents are downloaded.
For a binary file on Drive the checksum is compared too, since its modified
time can move without the content moving.
If anything changed, it writes one commit to `origin/main`:

- author: the source's last editor, with their source email if available
- date: the source's last-edit time
- message: `Update <n> documents` and the list

A comment moves no last-edit time at either source, so on a root with
`comments: true` comments are re-read for every document on every fetch:
one comment listing per Google Doc, plus the document itself when it
changed or had a thread, and on Notion one request per block of every page.

> **Warning.** Notion's API lists comments per block, so a root with
> `comments: true` costs one request per block of every page on every
> fetch, under a rate limit of about three requests a second. A root of a
> hundred pages with fifty blocks each spends half an hour per fetch on
> comments alone. Turn it on for small Notion roots only; on Google Docs the
> cost is one request per document.

A fetch whose only changes are sidecars commits as `Update comments on <n>
documents`; the `fetched:` line alone never makes a commit.

Fetch never modifies your working tree. That is what `pull` and merge are for.

**Later:** replay the Drive revision list as individual commits, so `git log`
shows real per-edit history for Google Docs.

### Push

Git sends the commits between `origin/main` and your branch. The helper:

1. Fetches first. If the source changed since your last fetch, the push is
   rejected with "the source changed", exactly as if someone had pushed to a
   git remote before you. Pull, merge, push again.
2. Rejects the push if `origin/main` is not an ancestor of what you push. This
   is git's normal non-fast-forward rule. Fetch, merge or rebase, push again.
3. Reads the manifest. Added or modified files under no root are refused.
   Deleted files under no root are ignored: that is what `docsync remove`
   produces, and it means unsubscribe, not trash. Changes to
   `.docsync/index.yaml` are refused, and so is any change to a comment
   sidecar under a root: "`<path>` is read-only; comments are only pulled in
   this version. Restore it with `git checkout -- <path>`".
4. Refuses content changes to read-only exports (Sheets, Slides, Drawings).
   Renaming or deleting one renames or trashes the source file.
5. Diffs the tree per root and applies:
   - **modified** → update the document (see Write-back below)
   - **added** → create the document, or upload the binary. Folders the
     path implies are created on Drive and listed in the report
   - **deleted** → trash the document (Notion archive, Drive trash). Never
     permanent. Printed prominently.
   - **renamed** → same document (by id), possibly a title change and, for
     Drive, a move between folders
6. **Post-push fetch.** Re-reads every document it touched. If the canonical
   form differs from what was pushed (new ids, source-side normalization), it
   writes one more commit on top of `origin/main`. Your branch is then one
   fast-forward behind. `docsync push` fast-forwards for you when the working
   tree is clean; after plain `git push`, run `git pull`. When the source only
   re-stamped edit times, that follow-up commit is `Update the index`.

The helper reports progress and the list of trashed documents on stderr as
the push runs. `git push --quiet` silences it; prefer `docsync push`, which
prints the report properly.

### Force push

Not supported. The helper rejects a forced push. A force push would mean
writing your tree over a source state the helper has never seen, and once
write-back is diff-based (§12) there is no base to compute the diff from. Fetch,
merge, push.

### Write-back

A push patches what changed and leaves the rest alone. There is nothing in
the Markdown to make this possible: at push time the helper re-reads the live
document, converts it, and requires the result to equal the version your
commit started from. Push step 1 already guarantees that; the check makes it
local. Base block *n* is then live block *n*, and the diff between your
version and the base, computed the way `git diff` is but over blocks, says
what to do with each:

- An **untouched block** is not written at all. It keeps its id, its
  comments, its history, and every attribute the dialect cannot express.
- An **edited block** is patched in place. Inside it, only the characters
  that changed are rewritten: deleted spans are cut, inserted text takes the
  formatting of the text before it, and a formatting change you made in the
  dialect (bold, italic, strikethrough, underline, code, link) touches only
  that attribute on that span. Everything else in the block survives.
- An **inserted block** is created at its position; a **deleted block** is
  deleted. Notion can only append *after* a block, so a block inserted at the
  very start of a page or of a list is written together with a copy of the
  block that used to be first, and that original is deleted: one block loses
  its id and comments per prepend.
- A **moved block** is a deletion and an insertion, because neither source
  can move a block. It arrives at its new place as a new block: a new id on
  Notion, and detached comments on both. The same happens to a block you
  rewrote so far that less than half its text survives, unless it is the
  only block replaced at that spot; a paragraph rewritten in place keeps its
  id.
- A block whose **type changed** (a paragraph made a heading) is a style
  change on Google Docs and a delete-and-create on Notion, which cannot
  change a block's type.

What is lost, per source:

- **Notion:** formatting on the characters you rewrote; the id and comments
  of a moved block or a block whose type changed. Notion splits a block's
  rich text where a comment starts and ends; an edit to that block rejoins
  the runs, which is invisible in the text. An edit writes the block's
  merged runs together with the attributes the dialect owns (colour, checked
  state, code language, callout icon, table header flags). A block the API
  cannot create (bookmark, embed, synced block, column list, …) survives
  untouched; editing or moving its placeholder is refused, deleting it
  deletes the block. A page pushed from a checkout that has no base version
  of it is refused: fetch, merge, push again. A block
  with more than a hundred rich-text runs keeps its text but loses the
  formatting past the ninety-ninth run. Page-level comments, properties,
  sharing, child pages, child databases and the page id always survive.
- **Google Docs:** formatting on the characters you rewrote; the anchor of
  a comment that overlaps an edit; a pending suggestion in a paragraph you
  edited, which is overwritten as plain text and named in the push report. A
  paragraph you moved, and one rewritten so far that the diff cannot pair it,
  are written afresh where they land. A horizontal rule cannot be created
  by the dialect, so a new one in your Markdown is dropped; an existing one
  in text you did not touch survives. An image is created from its file in
  `<title>.assets/`, inline where its link sits; an image whose file is not
  there is dropped and named in the push report. The alt text of an image
  cannot be written, so an edit that changes only an alt sends nothing and
  is reverted by the fetch after the push. A table that gained or
  lost a column is rewritten whole; a row added or removed leaves the other
  rows alone. A list item you nested deeper is written afresh at the level
  it lands in. A fenced code block is written as Courier New paragraphs and
  a blockquote as plain paragraphs, since Docs has neither. Everything else
  on text you did not touch, colour, highlight, fonts, sizes, alignment,
  inline images, footnotes, page breaks and comment anchors, survives,
  because nothing the push sends addresses it.
- **Drive binaries:** a new revision of the same file is uploaded.
  Everything else about the file is untouched.
- **Hosted files** (`<title>.assets/`): a new link into the directory
  uploads the file and creates the block; changed bytes behind an existing
  link re-upload and patch the same Notion block, or delete and re-insert
  the Docs image. A link to a file that is not on disk, and a file deleted
  while its link stays, are refused naming the path. A file the source will
  not take (its size, or a non-image in a Doc) is reported and skipped,
  never half uploaded, and the rest of the document still goes. The report
  says `uploaded <n> files`.

The push report says how much was touched: `updated  Specs/Auth.md  (3
blocks changed, 41 kept)`, where changed counts updated, inserted and
deleted blocks. A document whose live version does not match the base is refused
with "the source changed": fetch, merge, push again.

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
helper writes the skill file during it. A clone needs an absolute manifest
path: a relative one would resolve against the empty directory git has just
made, where no manifest exists yet.

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
- Google Docs revisions are collapsed into one commit per fetch.
- One branch (`main`) per remote. Other local branches are fine; the helper only
  serves `main`.

### Phase 2 — attachments

Done. Files hosted by the source are downloaded on fetch into
`<title>.assets/` next to the document and linked relatively (§6); push
uploads new or changed files (§7). A Docs checkout made before this keeps
its image placeholders until the document next changes.

### Phase 3 — diff-based write-back

Done. Only what changed is patched, block by block and character by
character (§7 "Write-back"); nothing is stored in the Markdown for it.

### Phase 4 — comment threads

On a root with `comments: true`, open comment threads and pending
suggestions are pulled into a read-only sidecar beside the document (§6
"Comments and suggestions"), so a person or an agent can read them in
context and answer them by editing the body. Nothing is pushed back in this
phase.

**Later:** replies and resolving from the checkout. Google Docs allows both
through the API; Notion allows replies but has no resolve call and does not
return resolved threads. Accepting and rejecting Docs suggestions, and
**push as suggestions**, writing a push in suggesting mode so the client
reviews it in Docs, both need the Google Workspace Developer Preview
Program. Comments can be client-facing, so docsync will never write a
comment on its own; only what you author.

### Later

- Google Docs revision history replayed as individual commits.
- Manifest stored at the source: `docsync::gdocs:<id>`.
- Notion databases.
- Writable Sheets and Slides, if a lossless path exists.
- A per-root `format: html` option as an alternative to Markdown. It would
  carry colours, fonts, alignment and merged cells, at the cost of noisier
  diffs and harder agent edits. Diff-based write-back (phase 3) removes most
  of the reason for it, so it waits until then.

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
docsync auth    <source> [--logout]
docsync --version
```

Source refs: `notion:<id>`, `gdocs:<id>`. A Notion id is 32 lowercase hex
characters without dashes; dashed and uppercase forms are accepted on input
and normalised. A Google id is stored verbatim. Wherever a command takes a
source ref, it also takes a Notion, Google Docs or Drive URL, `http` or
`https`, and normalises it. Manifests and ignore lists hold canonical refs
only, never URLs.
