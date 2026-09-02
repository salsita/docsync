# 10 — docsync CLI

Phase 1. Manual §5, §13.

## Goal

Every command in the reference, with the output the manual describes.

## Scope

- `init`, `add`, `remove`, `status`, `fetch`, `pull`, `push`, `resolve`,
  `auth`, `--version`.
- `init`: directory, manifest, `git init -b main`, `core.autocrlf=false`,
  `info/exclude`, skill file, roots, remote, fetch, checkout.
- `push`: per-document report, trashed documents prominent, fast-forward when
  clean.
- `pull`/`fetch`: changed documents and editors.
- Git is driven by spawning `git`, never reimplemented.

## Done when

Each command has a test against the fake source from 09, and the quick start in
the manual works verbatim.
