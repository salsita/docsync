# Board

One file per ticket, numbered in rough execution order. The manual (`../MANUAL.md`)
is the spec; tickets point at its sections instead of repeating them.

Each ticket has a **Goal**, a **Scope** list, and **Done when**. Finished
tickets move to `done/` with an **Outcome** section.

| Phase | Tickets |
|---|---|
| 1 — core loop | 01–13, 18 |
| 2 — attachments | 14 |
| 3 — diff-based write-back | 15–16 |
| 4 — comment threads | 17 |

## How a ticket moves

The human is the owner. Claude (the assistant in the main session) is the
reviewer and dispatcher. An implementation agent (Opus) does the coding.

1. **Refine.** Claude rewrites the ticket based on what the previous tickets
   actually produced: decisions, module layout, rules to encode, tests, done
   criteria. Anything in doubt is a question to the owner, not a guess.
2. **Approve.** The owner answers and approves. Claude commits the refined
   ticket and any resulting manual changes.
3. **Dispatch.** Claude starts one Opus agent on the ticket with the ticket
   file and the manual as its brief.
4. **Meanwhile,** the owner and Claude refine the next ticket. They do not
   touch source files while an agent runs.
5. **Land.** When the agent is done, it has committed its work locally.
   Claude reviews the diff, fixes small issues directly, and sends larger ones
   back to the same agent. Claude commits the improvements.
6. **Close.** Claude moves the ticket to `done/`, adds an Outcome section
   (deviations from the ticket, follow-ups, surprises), commits, and pushes.

## Rules

- **One agent at a time,** in the shared working tree on `main`. No parallel
  agents, no worktrees.
- **Stage by path.** Nobody runs `git add -A` or `git commit -a`. Agents
  commit their source files by name; ticket and manual edits made during a
  run are committed separately by Claude. This is what makes a shared tree
  safe.
- **Only the owner's session pushes.** Agents never push. Claude pushes
  `main` after a reviewed ticket lands, and pushes ticket or manual
  refinements when the owner approves them.
- **TDD.** Tests are written before the code they test, in every ticket.
- **The manual is the spec, and only Claude edits it.** If implementing a
  ticket shows the manual is wrong or silent, the agent reports the needed
  change in its result; Claude applies it in the landing and the Outcome
  section says so. Two parties editing one file in a shared tree is how edits
  get swept into the wrong commit.
- **Smoke tests clean up.** A script that writes to a real source creates
  its own objects, verifies, trashes them at the end, and prints what it did
  and what it left behind. Fixture trees are read-only. Never pipe a smoke
  script through another command; it re-runs it.
- **Commit messages** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
