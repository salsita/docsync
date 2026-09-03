# 21 — Comments are opt-in per root

Phase 4. Manual §4 (the `comments` field), §6 "Comments and suggestions",
§7 Fetch (the warning).

## Goal

Sidecars are produced only for roots with `comments: true`. The default is
off, because on Notion the refresh costs one request per block per fetch.

## Scope

- `src/manifest/`: `comments?: boolean` on a root, parsed, validated (a
  boolean or absent), serialised with comments preserved, default `false`.
- Both adapters' `fetchRoot`: no comment requests at all when the option is
  off. An existing sidecar under a root that turned the option off is
  removed by the next fetch, as a resolved-away thread would remove it.
- `docsync add` and `init` do not set it; the manifest is edited by hand.
  `docsync status` shows `comments on` on a root that has it.
- Tests: manifest parse and validation; the request counts on the fixture
  trees with the option off equal the pre-17 counts (Drive 3, Notion 19
  when nothing changed); on; turning it off removes the sidecar.

## Done when

`pnpm check` green; the manual's §4 row and §7 warning match behaviour.

## Outcome

Landed 2026-09-04 in one agent commit (`c56773a`) plus the landing commit.
`pnpm check` green, 1250 tests.

- `Root.comments?: boolean`, explicit `false` preserved on serialisation,
  written after `ignore`. Off by default; both adapters make no comment
  request when off, and a Drive Doc stops recording `suggested`.
- Request counts, now pinned by tests over counting fixture APIs: Drive 3
  off / 11 on, Notion 19 off / 85 on, nothing changed.
- Turning the option off drops the sidecars on the next fetch.
- `docsync status` appends `comments on`; manual §5 and §12 updated.
- The git-spawning e2e test flaked once under load, like the CLI one;
  noted in ticket 13.
