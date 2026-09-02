# 02 — Manifest, paths, ignore rules

Phase 1. Manual §4, §5 (`add` alias table).

## Goal

Pure, fully tested logic for everything the manifest decides.

## Scope

- Parse and validate `.docsync.yaml` (`version`, `roots`, `src`, `path`, `ignore`).
- Path rules: trailing slash, overlap detection, case-only collisions, `/` only.
- Alias resolution: `<src>`, `<src>=dir/`, `<src>=file.md`, `<src>=dir/` with title
  override, given a resolved title and whether the object has children.
- Ignore matching: gitignore syntax against title paths, and source-ref entries.
- Filename derivation from titles: illegal characters, leading dots, trailing
  dots and spaces, Windows reserved names, `(2)` collision suffixes (Manual §6).
- Clear error messages for each validation failure.

## Done when

Every rule in the manual's tables has a test, and no source API is involved.
