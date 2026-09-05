---
name: docsync
description: How to work in a docsync checkout — Notion pages and Google Docs as Markdown under git. Use when the working tree has a .docsync.yaml, a .docsync/index.yaml, or files with docsync frontmatter.
---

# Working in a docsync checkout

This directory is a git repository whose documents live in Notion or Google
Drive. Each document is a Markdown file; `.docsync.yaml` lists the roots and
_is_ the remote; `.docsync/index.yaml` maps every path to its source object.
Nothing reaches a source until someone pushes. Do not edit files that are
outside a root — only the roots in `.docsync.yaml` are documents.

## Before you edit

Run `docsync pull` first, or check `docsync status`: "moved" means the source
changed since the last fetch and you would be editing stale text. Beyond
that, this skill only tells you how docsync behaves. How you branch, commit
and hand your work over is the project's process, not docsync's; follow the
instructions that apply where you work.

**Do not run `docsync push` or `git push` unless the person asked for it in
this conversation.** A push writes to real documents other people own; being
merely finished is not a reason to push. The same goes for `docsync add`,
`docsync remove` and deleting a tracked file: deleting a file and pushing
moves the document to the source's trash.

## Do not touch

- **Frontmatter.** `id` is the document's identity — never change or copy it.
  `url` is the link that opens the document at its source; docsync derives it
  from the id and rewrites it on every fetch, so quote it in reports and never
  edit it. Change `title` only when the person asked to rename the document.
  Adding keys of your own does nothing; they are dropped.
- **`.docsync/index.yaml`** — docsync writes it; a push that changes it is
  refused.
- **Placeholders**, `<!-- docsync:block … -->` and `<!-- docsync:object … -->`.
  They stand for content the Markdown cannot express. Deleting one deletes
  that content at the source; editing or moving one is refused.
- **`*.comments.md`** — read-only sidecars (below).
- **Files under a read-only root** — a root marked `readonly: true` in
  `.docsync.yaml`. It is pulled for context and never pushed to; a push that
  adds, changes, deletes or renames anything under it is refused.
- **The skill files** in `.agents/`, `.claude/` and `.cursor/` — docsync
  overwrites them on every command. `.docsync.yaml`, `.prettierrc`,
  `.editorconfig` and `.gitattributes` are the checkout's, not yours either.

## The dialect

Body text is GitHub-flavoured Markdown. Fetch and push are canonical, so
gratuitous reformatting shows up as a real change at the source. Keep edits
small and leave untouched paragraphs byte-identical.

- Italic is `_like this_`, bold `**like this**`, bold italic `**_like this_**`.
  Underline is `<u>…</u>`; colour is `<span data-color="red">…</span>`.
- A line break inside a paragraph is a **backslash at the end of the line**,
  not two trailing spaces.
- Block attributes are an HTML comment on its own line **above** the block,
  with a blank line between them, e.g. `<!-- docsync: color=green -->` or
  `<!-- docsync: header-row=false -->` above a table. Never put one on a list
  item; it breaks the list.
- Table cells hold **inline formatting only** — no lists, no code blocks, no
  line breaks inside a cell.
- An empty paragraph in the source shows as extra blank lines. Leave them
  where they are: you cannot create one by adding blank lines, and deleting
  them deletes a block.
- Other shapes: `> [!CALLOUT] 💡` with the body quoted below;
  `<details><summary>title</summary>`, blank line, children, blank line,
  `</details>`; `$$ … $$` for a block equation, `$ … $` inline; `---` for a
  divider.
- Link to another document in the checkout by its **relative path**:
  `[Auth](Product Specs/Auth.md)`. Files a document hosts live in
  `<name>.assets/` beside it; link into that directory relatively.
- A new `.md` file that begins with two `---` fences creates a document at the
  source on the next push. Without frontmatter it is a plain file, and under a
  Notion root it is refused.
- Prettier with default options is safe (the checkout pins `proseWrap:
  preserve`). Do not run markdownlint --fix or another Markdown formatter;
  the next fetch undoes it and the history fills with churn.

## Reading the output

- `docsync status` is `git status` plus one line per root: the source ref, the
  path, when it was last fetched, whether the source has moved since, and
  `comments on` when the root pulls comment sidecars. "Moved" means pull
  before you edit.
- `docsync pull` and `docsync fetch` print which documents changed and who
  changed them. A fetch commit is authored by the person who edited the
  document at the source, not by you. `--all` renders every document again
  with the installed docsync; use it only when told to.
- `docsync push` prints one line per document — created, updated or **trashed**
  — and then fast-forwards. "the source changed" means someone edited the
  document while you worked: `docsync pull`, resolve any conflict markers the
  ordinary way, and stop.

## Comment threads

A `<title>.comments.md` beside a document lists its open comment threads and
pending suggestions: one `##` heading per thread, the anchor quoted from the
body with the commented words marked `==like this==`, an `in:` line naming the
nearest heading, then the entries. Google Docs suggestions appear as a diff.

The sidecar is **read-only**. A push that changes it is refused. To act on a
thread, edit the body of the document it points at; replying, resolving,
accepting and rejecting happen in Notion's or Google's own UI. Never write a
comment into the body file. If a sidecar shows as modified, restore it with
`git checkout -- <path>`.

## Windows

Paths in `.docsync.yaml`, in frontmatter and in links always use `/`, never
`\`. Line endings are LF everywhere; do not "fix" them.
