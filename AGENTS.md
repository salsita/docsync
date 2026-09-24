# docsync, for agents

docsync is a git workflow over Notion and Google Docs: documents are checked
out as Markdown, edited, diffed and pushed back. [MANUAL.md](MANUAL.md) is
the spec and the vocabulary; code comments cite its sections (§6, §7) and
GitHub issues (#42). Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing
anything; it describes the flow and the rules. This file is the short form.

## Commands

- `corepack pnpm check` — lint, typecheck, tests. Run it in a shell call of
  its own and read the exit code; it must pass before a commit.
- `corepack pnpm build` — `dist/`, which the scripts under `scripts/` import.
- `scripts/*-smoke.ts` write to real Notion and Google sources. They need the
  owner's sign-in, create their own objects and trash them at the end, and
  are never piped through another command (that re-runs them). Do not run
  one unless the task says to.

## Rules you must not learn by breaking them

- Stage by path. Never `git add -A`, never `git commit -a`, never push, never
  run `scripts/release.sh` or push a tag.
- One agent at a time in the shared tree on `main`; no worktrees.
- Only the owner's session edits `MANUAL.md`, `skill/SKILL.md` and
  `CHANGELOG.md`. If the manual is wrong or silent, say so in your report.
- Fixture trees at the sources (the Drive folder "Docsync test", the Notion
  fixture pages) are read-only. Do not re-record `__fixtures__` unless asked.
- Never permanently delete anything at a source; trash is the most a script
  does.
- Nothing from a client's documents enters the repo or an issue: no names,
  ids, emails, quoted text. Fixtures use invented content.
- Tests first. Match the surrounding code's voice: comments say why, in
  prose, and cite the manual section or the issue that decided it.
- Commit messages cite the issue (`#42: …`) and end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
