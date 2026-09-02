# 02 — Manifest, paths, ignore rules

Phase 1. Manual §4, §5 (`add` alias table), §6 (filenames).

## Goal

Pure, fully tested logic for everything the manifest decides. No I/O, no
source API, no git. Every later ticket calls into this module instead of
reinterpreting the manual.

## Module

`src/manifest/` exporting:

| Function | Purpose |
|---|---|
| `parseManifest(text)` | YAML → `Manifest`, or a list of `ManifestError` with line numbers. |
| `serializeManifest(manifest)` | The inverse, stable key order, used by `add` and `remove`. Comments in the user's file are preserved (use the `yaml` package's document API). |
| `validateRoots(roots)` | Overlap, case collisions, path syntax. Returns all errors, not the first. |
| `resolveAlias(alias, resolved)` | `<src>[=<path>]` plus the resolved object (`title`, `kind`) → the root `path`. |
| `isIgnored(root, relPath, ref)` | Ignore matching for one candidate document. |
| `fileNameFor(title, ext)` | Title → safe filename, without collision handling. |
| `assignNames(siblings, previous)` | Collision suffixes for one directory, stable across fetches. |

Types: `Manifest`, `Root`, `SourceRef` (from ticket 03; stub a minimal type
here if 03 is not done yet), `Kind = 'leaf' | 'container'`.

## Rules to encode

### Manifest schema

```yaml
version: 1
roots:
  - src: notion:<id>        # required, parsed by ticket 03
    path: Product Specs/    # required
    ignore:                 # optional, list of strings
      - "Archive/**"
      - "notion:8c1d…"
```

Errors, each with the YAML line: unknown `version`, missing `roots`, root
missing `src` or `path`, unknown keys, `ignore` not a list of strings, empty
`roots` is **valid**.

### Path syntax

- Relative. No leading `/`, no `./`, no `..` segment, no empty segment, no
  `\`. Unicode NFC-normalised.
- Trailing `/` = **directory root**. The object's contents live inside. If the
  object is itself a document (a Notion page with children), that document is
  `<path>/<title>.md` inside the directory.
- No trailing `/` = **file root**. Only valid for a leaf. Must end in `.md`
  for a Notion page or Google Doc. Any extension for another Drive file.
- Two roots may not have the same path, and no root's path may be a segment
  prefix of another's. Comparison is case-insensitive.
- `a/` and `a.md` are distinct paths and both allowed. They are what a Notion
  page with children produces anyway.

### Alias resolution

Input: the alias text after `=`, or nothing, plus `{ title, kind }`.

| Alias | Leaf | Container |
|---|---|---|
| none | `<title>.md` | `<title>/` |
| `dir/` | `dir/<title>.md` | `dir/<title>/` |
| `dir/name.md` | `dir/name.md` | error: a container cannot be a file |
| `dir/name` | error: a leaf needs an extension | `dir/name/` |

So a trailing slash means "under here, by title"; no trailing slash means
"exactly this name". The **resolved** path is what goes in the manifest, so a
later title change at the source does not move a root.

A leaf that later gains children at the source keeps its file root; the
children go in a sibling directory with the same stem (`specs/auth.md` and
`specs/auth/`). The root's territory is therefore the file plus that sibling
directory. `validateRoots` treats them as one when checking overlap.

### Ignore

- Patterns are matched against the on-disk path relative to the root
  directory, using gitignore semantics (the `ignore` package). Negation
  patterns work.
- An entry that parses as a source ref (ticket 03) matches by id, regardless
  of path, and also matches every descendant of that object.
- The root object itself cannot be ignored. That is what `remove` is for.

### Filenames

`fileNameFor(title, ext)`:

1. NFC-normalise. Trim.
2. Replace `/ \ : * ? " < > |` and control characters (U+0000–U+001F, U+007F)
   with `-`.
3. Remove leading dots (so no hidden files). Trim trailing dots and spaces.
4. If the stem, case-insensitively, is a Windows reserved name (`CON`, `PRN`,
   `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), append `-`.
5. If the result is empty, use `untitled`.
6. Truncate the stem so that stem + ext is at most 200 bytes in UTF-8, cutting
   on a character boundary.
7. Append the extension.

`assignNames(siblings, previous)`:

- Input: `[{ id, title, ext }]` for one directory, plus the previous
  `Map<id, filename>` from the index (ticket 09) if any.
- Every id that already has a name in `previous` keeps it, provided the title
  still derives to the same stem. Otherwise it gets a new name.
- Remaining ids are processed in a deterministic order (by id) and receive the
  first free name: `Notes.md`, then `Notes (2).md`, `Notes (3).md`, …
- Comparison for "free" is case-insensitive.
- Returns `Map<id, filename>`.

## Tests

Table-driven, one `describe` per function. At minimum:

- Manifest: each error case, a valid file with comments that survives a
  round trip through parse and serialize unchanged.
- Paths: every bullet under *Path syntax* as an accepted and a rejected case;
  overlap in both directions; case-only collision; `a/` with `a.md`.
- Alias: every cell of the table, plus a title containing `/` and a title
  that is only dots.
- Ignore: glob, negation, directory pattern, source-ref entry, descendant of
  an ignored ref, root itself never ignored.
- Filenames: every step above with one example each, `CON.md`, an emoji
  title, a 300-character title, and a collision set where the previous map
  keeps `Notes (2).md` for an id even after the other `Notes` is gone.

## Dependencies

`yaml`, `ignore`. Both pure JS, no build scripts.

## Done when

`pnpm check` is green with this module at 100% line coverage, and the manual's
§4, §5 alias table and §6 filename rules match what the tests assert. Update
the manual's alias table to the rule above as part of this ticket.
