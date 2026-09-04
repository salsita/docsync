# 22 — CI is red on Linux: the helper dies with EPIPE

Phase 1. Manual §7, §9. Urgent: `main` has been red on `ubuntu-latest`
since ticket 09 landed (2026-09-03); macOS is green; Windows failures are
ticket 12's.

## Evidence

Run 33850382599, `ubuntu-latest / node 22` and `node 24`:

- `src/helper/e2e.test.ts`: cases 5, 7, 8, 9, 12 fail. The stderr shows
  `Error: write EPIPE` as an unhandled `'error'` event on a Socket, from a
  run of the helper, and git then reports `git clone … failed` / exit 128.
- `src/cli/commands.test.ts` "status prints git's own status and then one
  line per root": git exit 128, same cause one level up.
- Locally on macOS the same two files flake with exit 128 under load
  (ticket 13's note), which is the same bug showing rarely.

## Diagnosis to confirm

The helper writes to stdout or stderr after git has closed the pipe: after
`done` on a fetch or push, on a rejected push where git stops reading, or
progress on stderr when git exits first. On macOS the write usually lands
before the close; on Linux it does not. An unhandled `error` on
`process.stdout` / `process.stderr` kills the process.

## Scope

- Reproduce on Linux (a container, or CI on a branch), not by guessing.
- `src/helper/protocol.ts` / `run.ts`: handle `error` on stdout and stderr
  (ignore `EPIPE`, exit quietly), flush and await `stdout.write` callbacks
  before exiting, never write after the protocol's final blank line except
  through a guarded writer.
- A test that closes the read end early and asserts the helper exits 0
  without an unhandled error.
- Make the two real-git test files build the helper once (a global setup or
  a shared cached build) so the suite is not the slowest thing in CI.

## Done when

CI green on `ubuntu-latest`, both Node versions, twice in a row; the two
local flakes gone in ten consecutive `pnpm check` runs.

## Outcome

Landed 2026-09-04 in two agent commits (`8b127f1`, `0d73b68`) plus the
landing commit. `pnpm check` green, 1328 tests; ten consecutive local runs
all exit 0; CI on a scratch branch green on `ubuntu-latest` for Node 22 and
24 twice in a row (runs 33867173262, 33867342014).

- The ticket's diagnosis was wrong in its location. The EPIPE was in
  `src/helper/git.ts`: every plumbing call got its input through
  `child.stdin.end(...)`, and commands that never read stdin could exit
  first, with nothing listening for `error` on that stream. Linux loses
  the race routinely, macOS rarely, hence the local flake.
- Fix: ignore `error` on the child's stdin; a guarded line writer for the
  helper's stdout and stderr that goes quiet on a closed pipe, flushed
  before `main` returns. Reproduced deterministically with 4 MB of input
  to a child that exits without reading.
- The two real-git test files share one helper build through a vitest
  `globalSetup`, dropping the per-file `tsc` and the 120 s `beforeAll`s.
- Windows CI still fails on the path tests, ticket 12.
- Follow-up: `src/cli.ts` and the helper's `--version` still write to
  `process.stdout` unguarded; `docsync status | head` could hit the same
  class of crash. Fold into ticket 13.
