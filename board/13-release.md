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
| Publish auth | npm **trusted publishing** (OIDC from GitHub Actions, no token secret), configured once on npmjs.com for the package by the owner | No long-lived secret in the repo. Needs the package to exist or the org to allow first publish via OIDC; see Open questions. |
| Repo visibility | Provenance attestations require a public source repository. **Open question** whether the repo goes public at release | Owner's call; private repo means `--provenance` is dropped. |
| README | Rewritten around the quick start: install, `docsync auth`, `docsync init`, edit, `docsync push`, in the manual's §3 shape but shorter; a "for agents" paragraph pointing at the skill file; a link to the manual for everything else; requirements (Node ≥ 22, git, an OAuth app per source from the team) | Done-when of the ticket. |
| Package contents | `npm pack --dry-run` reviewed in the ticket: `dist`, `skill`, `LICENSE`, `README.md`, `MANUAL.md`, `package.json`; no tests, no mocks, no maps of test files. `MANUAL.md` ships so `docsync --help` §13 and the skill's references resolve offline | 241 files today; trim `dist/**/*.test.js`, `*.mock.js` via `tsconfig.build.json` excludes if they are in |
| Guarded stdout | `src/cli.ts` `out`/`err` and `src/remote-helper.ts` `--version` go through `createLineWriter` from `src/helper/main.ts` (or a small shared `src/stdio.ts` both import), so `docsync status \| head` cannot crash on EPIPE | Carried over from ticket 22. |
| ai-starter | **Out of this ticket.** A separate ai-starter change (its own repo) adds a setup step that installs docsync and drops `oauth-apps.yaml` from the team's store. Nothing in ai-starter does setup today, and the store is not named anywhere in it | Different repo, different owner decision; see Open questions. |

## Open questions for the owner

1. Public or private repository at release? Public gives provenance and a
   reachable README from the npm page. Private means no `--provenance`.
2. Does the `@salsita` npm org exist and who administers it? The owner has
   to `npm login` and set up trusted publishing for `@salsita/docsync`
   (npmjs.com → package or org settings → Trusted publishers → GitHub
   Actions, repo `salsita/docsync`, workflow `release.yml`). First publish
   through OIDC needs the org to allow it; otherwise the owner publishes
   `0.1.0` once by hand and CI takes over from `0.1.1`.
3. ai-starter: which secret store holds the team's OAuth app values, and
   should that step be a ticket here or a task in ai-starter?

## Module

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | Publish on tag. |
| `CHANGELOG.md` | `0.1.0` section written from `board/done/`. |
| `README.md` | Quick start. |
| `src/stdio.ts` (or reuse of `createLineWriter`) + `src/cli.ts`, `src/remote-helper.ts` | Guarded writers; a test that a closed stdout does not throw. |
| `package.json`, `tsconfig.build.json` | Version `0.1.0`; `files` and excludes verified with `npm pack --dry-run`. |

## Done when

`pnpm check` green; `npm pack --dry-run` lists no test or mock files; the
release workflow is green on a dry run (`npm publish --dry-run` on a push,
real publish only on a tag); after the owner tags `v0.1.0`, a fresh machine
installs it from npm and reaches a working checkout following only the
README.
