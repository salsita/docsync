# 20 — A Notion page is a file root

Phase 1. Manual §3, §4 "Path rules", §5 `add` alias table, §6 "Layout".

## Goal

`docsync add notion:<page>` yields `<title>.md` with the children in
`<title>/` beside it, at the top level exactly as at every other level. No
more `X/X.md` and `X/X/Y.md`.

## Why

The directory-root rule of ticket 02 was written for Drive folders and was
applied to Notion pages unchanged. The walk already supports a file root with
children (`src/notion/walk.ts`, "a page with children owns the sibling
directory of the same stem"); only the alias resolver and the default forbid
it.

## Scope

- `src/manifest/alias.ts`: the `container` kind means a Drive folder only. A
  Notion page, children or not, resolves like a document: default alias
  `<title>.md`, `=dir/` → `dir/<title>.md`, `=dir/name.md` → as given,
  `=dir/name` → the "needs an extension" error. `ResolvedObject.kind` and
  `Source.describe` for Notion change accordingly (a page is never a
  container); `docsync resolve` still prints the child count.
- Manifest validation: unchanged. A file root already owns its sibling
  directory.
- The Notion walk with a directory root (`Specs/`) keeps working for
  manifests written by hand or by earlier versions: page inside as
  `Specs/<title>.md`, children in `Specs/<title>/`. Test it stays so.
- Tests: alias table rows for a page with children; the Notion walk from a
  file root with nested children; the fixture index's root path if it was a
  directory; the CLI quick start test and `add` tests now expect
  `Product Specs.md` and `Product Specs/Auth.md`; the fake `Source` lays
  children out as the real adapter does (the ticket 10 follow-up), so the
  layout assertions are real.
- Manual §3, §4, §5 already say the new rule (edited with this ticket).
  Report anything else in the manual that still describes the old layout.

## Done when

`pnpm check` green; the quick start test's `ls` matches manual §3.

## Outcome

Landed 2026-09-03 in two agent commits (`b612873`, `6937ea8`) plus the
landing commit. `pnpm check` green, 1034 tests.

- Smaller than feared: `resolveAlias` was already kind-driven, so the change
  is Notion's `describe` always answering `leaf` (child count kept), the
  error wording "a folder cannot be a file", and tests. The directory-root
  layout for a Notion page (`Specs/Specs.md`) stays supported and tested as
  the hand-written case.
- The fake `Source` now nests children as the real adapters do, closing the
  ticket 10 follow-up; the CLI quick start test asserts exactly §3's listing.
- At landing: `docsync resolve` prints `type document` / `type folder`
  instead of the raw kind; the manual's §4 example manifest now says
  `path: Product Specs.md`.
