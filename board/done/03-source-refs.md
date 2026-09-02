# 03 — Source refs and URL normalisation

Phase 1. Manual §1, §13.

## Goal

`notion:<id>` and `gdocs:<id>` as one typed value, parsed from refs and from
the URLs people actually paste, printed back in one canonical form. Pure, no
I/O. Extends the minimal `src/source-ref.ts` that ticket 02 stubbed.

## Module

`src/source-ref.ts` exporting:

| Function | Purpose |
|---|---|
| `parseSourceRef(text)` | Ref or URL → `SourceRef`, or a `SourceRefError` with a message that says what was expected. |
| `formatSourceRef(ref)` | `SourceRef` → canonical `notion:<id>` / `gdocs:<id>`. |
| `isSourceRef(text)` | Cheap test used by ignore-list parsing (ticket 02) and CLI argument handling. |

`SourceRef = { source: 'notion' | 'gdocs'; id: string }`. No type hint
(page, folder, document): the source decides that when the ref is resolved
(tickets 05 and 07), and a URL is not a reliable witness.

## Canonical ids

- **Notion:** 32 lowercase hex characters, no dashes. Input accepts the
  dashed UUID form, uppercase, and both forms inside URLs. Output is always
  undashed. Rationale: it is what appears in URLs, and the API accepts both.
- **Google:** the id verbatim. Drive ids are opaque; accept `[A-Za-z0-9_-]`
  of length 20 or more and do not try to be smarter.

## Accepted inputs

Refs, with optional surrounding whitespace:

- `notion:<32 hex>`, `notion:<8-4-4-4-12 uuid>`
- `gdocs:<id>`

Notion URLs. Host `notion.so`, `www.notion.so`, or any `*.notion.site`.
The id is the last 32-hex run in the path, whatever precedes it:

- `https://www.notion.so/<hex>`
- `https://www.notion.so/<Title-slug>-<hex>`
- `https://www.notion.so/<workspace>/<Title-slug>-<hex>`
- Any of the above with a query (`?v=…`, `?pvs=4`) or a fragment
  (`#<hex>` block anchor). Query and fragment are dropped. A `#<hex>` block
  anchor is **not** the page id; the page id is the one in the path.

Google URLs. Hosts `docs.google.com` and `drive.google.com`, with or without
the `/u/<n>/` account segment:

- `https://docs.google.com/document/d/<id>/edit`
- `https://docs.google.com/spreadsheets/d/<id>/…`, `/presentation/d/<id>/…`,
  `/drawings/d/<id>/…`
- `https://drive.google.com/drive/folders/<id>`
- `https://drive.google.com/file/d/<id>/view`
- `https://drive.google.com/open?id=<id>`
- Any of the above with query (`?usp=sharing`) or fragment
  (`#heading=h.abc`). Both dropped.

Anything else is an error: unknown scheme prefix, unknown host, a Notion URL
with no 32-hex run, a Google URL with no recognisable id position, an empty
string.

## Errors

`SourceRefError` carries `input` and `message`. Messages name the accepted
forms briefly, for example:

```
Not a source ref: "foo". Expected notion:<id>, gdocs:<id>, or a Notion / Google Docs / Drive URL.
```

## Tests

Table-driven in `src/source-ref.test.ts`:

- Every bullet above as an accepted input with its expected canonical output.
- Round trip: `formatSourceRef(parseSourceRef(x))` is stable for every
  accepted input.
- Rejected: `notion:` with 31 hex, a Notion URL for a workspace root with no
  id, `https://example.com/…`, `gdocs:` with a slash inside, an `http://`
  Notion URL (accept it; it is not a rejection — note in tests), whitespace
  only.
- `isSourceRef` agrees with `parseSourceRef` on every case.

## Done when

`pnpm check` green, 100% line coverage on the module, and ticket 02's ignore
matching and the future CLI (ticket 10) can rely on `parseSourceRef` for every
place the manual says "URLs are accepted everywhere a source ref is".

## Outcome

Landed in `4ddd2d3..668ddfa`. 100% coverage on `src/source-ref.ts`, 363 tests
overall, no new dependencies.

- Two parsers: `parseSourceRef` for literal refs (manifests, ignore lists) and
  `parseSourceRefOrUrl` for anything a person types, returning a
  `SourceRefError` with a specific message. Both validate id shape identically.
- Decision on the manual's "URLs are accepted everywhere a source ref is":
  narrowed to command arguments. Manifests and ignore lists hold canonical refs
  only, since a serialized manifest must not diverge from its in-memory value.
  Manual §1 and §13 updated.
- Ticket 02's test fixtures used placeholder ids that no longer parse under
  strict validation; replaced with real-shaped ids, which also revealed two
  ignore tests that had been silently exercising the wrong branch.
- `/<kind>/d/<id>` is accepted for any kind, and the `/u/<n>/` account segment
  is dropped wherever it appears in the path.
