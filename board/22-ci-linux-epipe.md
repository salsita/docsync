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
