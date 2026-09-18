# Contributing

Work is tracked in [GitHub issues](https://github.com/salsita/docsync/issues).
The manual ([MANUAL.md](MANUAL.md)) is the spec; an issue points at its
sections instead of repeating them. Issues #1–#42 were files in a `board/`
directory before the tracker, which is why the code cites them by number and
why their bodies read as finished tickets.

An issue ready for work has a **Goal** (or **Problem**), a **Scope** list and
a **Done when**. A closed one ends in an **Outcome** comment: deviations from
the issue, follow-ups, surprises.

## How an issue moves

The human is the owner. Claude (the assistant in the main session) is the
reviewer and dispatcher. An implementation agent (Opus) does the coding.

1. **Refine.** Claude rewrites the issue body based on what the previous
   issues actually produced: decisions, module layout, rules to encode, tests,
   done criteria. Anything in doubt is a question to the owner, not a guess.
2. **Approve.** The owner answers and approves. Claude commits any resulting
   manual changes.
3. **Dispatch.** Claude starts one Opus agent with the issue and the manual
   as its brief.
4. **Meanwhile,** the owner and Claude refine the next issue. They do not
   touch source files while an agent runs.
5. **Land.** When the agent is done, it has committed its work locally.
   Claude reviews the diff, fixes small issues directly, and sends larger ones
   back to the same agent. Claude commits the improvements.
6. **Close.** Claude writes the Outcome as a comment, pushes, and closes the
   issue. A follow-up worth doing becomes an issue of its own.

## Rules

- **One agent at a time,** in the shared working tree on `main`. No parallel
  agents, no worktrees.
- **Stage by path.** Nobody runs `git add -A` or `git commit -a`. Agents
  commit their source files by name; manual edits made during a run are
  committed separately by Claude. This is what makes a shared tree safe.
- **Only the owner's session pushes.** Agents never push, and never write to
  the issue tracker.
- **TDD.** Tests are written before the code they test, in every issue.
- **The manual is the spec, and only Claude edits it.** If implementing an
  issue shows the manual is wrong or silent, the agent reports the needed
  change in its result; Claude applies it in the landing and the Outcome says
  so. The same goes for `skill/SKILL.md` and `CHANGELOG.md`.
- **Smoke tests clean up.** A script that writes to a real source creates
  its own objects, verifies, trashes them at the end, and prints what it did
  and what it left behind. Fixture trees are read-only. Never pipe a smoke
  script through another command; it re-runs it.
- **No client material in an issue.** The tracker is public: no client names,
  document ids or people's names. Say "a client's Doc".
- **Commit messages** cite the issue (`#42: …`) and end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
