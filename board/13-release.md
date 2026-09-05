# 13 — Release

Phase 1. Manual §2, §11, §12.

## Goal

`npm install -g @salsita/docsync` works on a fresh machine, from a tagged
commit, published by CI. The README gets a person from zero to a working
checkout; the manual stays the reference.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Version | `0.1.0` first. SemVer; `0.x` until the owner has used it for real work. `package.json` is the one place the version lives (`src/version.ts` reads it) | Both binaries already print it and CI checks it. |
| Changelog | `CHANGELOG.md`, Keep a Changelog format, hand-written per release from the `board/done/` outcomes. No commit-message tooling | The board is already the record; a generator would repeat it worse. |
| Release trigger | Tag `v<version>` on `main`. A `release.yml` workflow runs on the tag: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, asserts the tag equals `package.json` version, `npm publish --access public --provenance`, then `gh release create` with the changelog section as the body | One command for the owner: `git tag v0.1.0 && git push --tags`. |
| Publish auth | npm **trusted publishing** (OIDC from GitHub Actions, no token secret). The trusted-publisher setting lives on the package page, so the package has to exist first: the owner publishes `0.1.0` by hand from the logged-in machine (`npm publish --access public` on the tagged commit, after `pnpm check && pnpm build`), then configures npmjs.com → `@salsita/docsync` → Settings → Trusted publisher → GitHub Actions, org `salsita`, repo `docsync`, workflow `release.yml`. The workflow takes over from `0.1.1`. The workflow needs `permissions: id-token: write, contents: write` and no `NPM_TOKEN` anywhere | No long-lived secret in the repo. Owner (`goce`) is admin of the `@salsita` org and logged in, 2026-09-05. |
| Repo visibility | **Public** at release; the owner flips it before tagging. `--provenance` stays in | Decided 2026-09-05. |
| License | **MIT**, as `LICENSE` and `package.json` already say, holder Salsita Software, 2026. Permissive, no patent clause, the norm for a CLI of this kind | Decided 2026-09-05; Apache-2.0 only if a patent grant is ever wanted. |
| README | Rewritten around the quick start: install, `docsync auth`, `docsync init`, edit, `docsync push`, in the manual's §3 shape but shorter; a "for agents" paragraph pointing at the skill file; a link to the manual for everything else; requirements (Node ≥ 22, git, an OAuth app per source from the team) | Done-when of the ticket. |
| Package contents | `npm pack --dry-run` reviewed in the ticket: `dist`, `skill`, `LICENSE`, `README.md`, `MANUAL.md`, `package.json`; no tests, no mocks, no maps of test files. `MANUAL.md` ships so `docsync --help` §13 and the skill's references resolve offline | 241 files today; trim `dist/**/*.test.js`, `*.mock.js` via `tsconfig.build.json` excludes if they are in |
| Guarded stdout | `src/cli.ts` `out`/`err` and `src/remote-helper.ts` `--version` go through `createLineWriter` from `src/helper/main.ts` (or a small shared `src/stdio.ts` both import), so `docsync status \| head` cannot crash on EPIPE | Carried over from ticket 22. |
| OAuth app values | **Not distributed by any repo or tool.** The owner sends `oauth-apps.yaml` to each interested person securely; the README says to ask the team for it and where to put it (§2). ai-starter is not involved | Owner's decision, 2026-09-05. |
| Package contents, addendum | `files` gains `MANUAL.md`; `README.md` and `LICENSE` npm includes on its own. `npm pack --dry-run` today lists 241 files and no test or mock file (the build excludes them already) | Verified 2026-09-05. |

## Decided (2026-09-05)

Repo public at release. License MIT (in place). npm: the owner is admin of
`@salsita` and logged in; first publish by hand because the trusted-publisher
setting is per package, CI from the next version. OAuth app values are
handed to people directly and securely by the owner; no repo or setup tool
carries them.

## Module

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | On tag `v*`: check, build, tag equals version, `npm publish --access public --provenance` via OIDC, `gh release create` with the changelog section. On a push to `main`: the same minus the publish, with `npm publish --dry-run`, so the workflow is exercised before any tag. |
| `CHANGELOG.md` | `0.1.0` section written from `board/done/`. |
| `README.md` | Quick start. |
| `src/stdio.ts` (or reuse of `createLineWriter`) + `src/cli.ts`, `src/remote-helper.ts` | Guarded writers; a test that a closed stdout does not throw. |
| `package.json`, `tsconfig.build.json` | Version `0.1.0`; `files` and excludes verified with `npm pack --dry-run`. |

## Done when

`pnpm check` green; `npm pack --dry-run` lists no test or mock files and
does list `MANUAL.md`; the release workflow is green on its dry run; the
owner then makes the repo public, tags `v0.1.0`, publishes once by hand,
configures the trusted publisher; a fresh machine installs it from npm and
reaches a working checkout following only the README. The agent does not
tag and does not publish.
