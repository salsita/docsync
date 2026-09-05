# docsync

`docsync` gives you a git workflow over documents that live in Notion and
Google Drive: you check documents out as Markdown files, edit them locally by
hand or with an agent, review the diff, and push. Nothing touches a source
document until you push, and when the source changed while you were working,
git's ordinary three-way merge resolves it.

## Requirements

- Node.js 22 or newer, and `git`.
- The team's OAuth apps, one per source. Ask the team for `oauth-apps.yaml`
  and save it as `~/.docsync/oauth-apps.yaml`
  (`%USERPROFILE%\.docsync\oauth-apps.yaml` on Windows). docsync ships no
  OAuth app of its own; it only reads that file. Registering the apps
  yourself is in [MANUAL.md](MANUAL.md) §2.

## Install

```bash
npm install -g @salsita/docsync
```

That puts two executables on your `PATH`: `docsync`, the front end you use,
and `git-remote-docsync`, which git discovers by name for a `docsync::` remote.

## Quick start

Sign in once per source. The browser opens; for Notion you pick the pages and
teamspaces to grant, for Google you approve Drive and Docs.

```bash
docsync auth notion
docsync auth gdocs
```

Make a checkout. Each argument is a Notion page or a Drive folder, as a ref or
as a pasted URL.

```bash
docsync init my-docs notion:2f3a9c… gdocs:1AbCdE…
cd my-docs
ls
```

```
.agents/  .claude/  .cursor/   # skill file for agents
Product Specs.md               # the Notion page
Product Specs/                 # its sub-pages, recursively
Contracts/                     # the Drive folder, recursively
```

It is a git repository with a git remote. Edit the files, review the diff, and
commit as usual.

```bash
$EDITOR "Product Specs/Auth.md"
git diff
git commit -am "Clarify session expiry"
```

See what a push would do to the real documents before it does it:

```bash
docsync status
```

Push, and take other people's changes:

```bash
docsync push
docsync pull
```

`docsync push` pushes and takes the follow-up commit back in one step, and
prints what happened to each document. That is the whole loop.

## For agents

Every checkout carries a skill file that tells an agent how docsync behaves —
pull first, leave the frontmatter and the placeholders alone, never push
unless asked. docsync writes it to `.claude/skills/docsync/SKILL.md`,
`.agents/skills/docsync/SKILL.md` and `.cursor/skills/docsync/SKILL.md`, keeps
it out of git, and refreshes it on every run, so an upgrade reaches every
checkout you touch. Do not edit those copies: they are overwritten. Whether
the agent works on a branch and when it commits is your project's business,
not docsync's.

## More

- [MANUAL.md](MANUAL.md) is the specification: the manifest, the Markdown
  dialect, fetch and push semantics, deletion, comments, Windows, and the full
  command reference.
- [CHANGELOG.md](CHANGELOG.md) is what changed in each release.

MIT licensed. © Salsita Software.
