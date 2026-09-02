# 01 — Project scaffold

Phase 1.

## Goal

A TypeScript package that builds, tests, and installs two executables,
`docsync` and `git-remote-docsync`, with CI green on macOS, Linux and Windows.
No product logic yet: both executables only print their version.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Package manager | pnpm 11, pinned via `packageManager` in `package.json`, activated with corepack | Your machine has pnpm 8 globally; corepack picks the pinned version per repo, and CI's `pnpm/action-setup` reads the same field. |
| Node | `>=22`, CI on 22 and 24 | Current LTS lines. |
| Module system | ESM only, TypeScript strict, `moduleResolution: node16`, `verbatimModuleSyntax` | Nothing needs CJS. |
| Build | `tsc` to `dist/`, no bundler | Simplest thing that works. Git spawns the helper on every fetch, so if startup time ever matters, switch to a bundler then, not now. |
| Tests | vitest, tests beside sources as `*.test.ts` | Fast, TS native, works on Windows. |
| Lint and format | biome | One tool, one config, one command. |
| CLI parsing | deferred to ticket 10 | The scaffold's bins take no arguments beyond `--version`. |
| License | MIT | Standard for a public npm package. **Confirm.** |

## Layout

```
package.json
pnpm-workspace.yaml        # hardening settings, see below
tsconfig.json
biome.json
.editorconfig              # LF, 2 spaces, utf-8
.gitignore                 # node_modules, dist, coverage
.github/workflows/ci.yml
LICENSE
README.md                  # one paragraph + pointer to MANUAL.md for now
MANUAL.md
board/
skill/SKILL.md             # placeholder; content is ticket 11
src/
  cli.ts                   # bin: docsync
  remote-helper.ts         # bin: git-remote-docsync
  version.ts               # reads version from package.json
  version.test.ts
```

## package.json essentials

```json
{
  "name": "@salsita/docsync",
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@11.x.y",
  "bin": {
    "docsync": "dist/cli.js",
    "git-remote-docsync": "dist/remote-helper.js"
  },
  "files": ["dist", "skill"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "biome check .",
    "typecheck": "tsc --noEmit",
    "check": "pnpm lint && pnpm typecheck && pnpm test"
  }
}
```

Both bin sources start with `#!/usr/bin/env node`. `tsc` keeps the shebang.

## pnpm-workspace.yaml

```yaml
# supply chain hardening — https://pnpm.io/supply-chain-security
minimumReleaseAge: 1440
blockExoticSubdeps: true
trustPolicy: no-downgrade
# grandfather deps older than 30d — initial-adoption retrofit, revisit per package over time
trustPolicyIgnoreAfter: 43200
strictDepBuilds: true
allowBuilds:
```

`allowBuilds` stays empty. Nothing in the scaffold needs a build script. When
a dependency does, it is added here explicitly with a comment, and native
modules are avoided in favour of prebuilt ones (relevant for the keychain
library in ticket 04).

## CI

`.github/workflows/ci.yml`: on push and pull request, matrix of
`ubuntu-latest`, `macos-latest`, `windows-latest` × Node 22, 24. Steps:
checkout, `pnpm/action-setup` (version from `packageManager`), `setup-node`
with pnpm cache, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`.

Then a smoke step on every OS: `pnpm link --global`, run `docsync --version`
and `git-remote-docsync --version`, assert the output equals the package
version. This is the earliest possible check that the Windows shim for the
helper exists at all. Whether git itself can invoke it is ticket 12.

## Steps

1. `git init` exists. Add `.gitignore`, `.editorconfig`, `LICENSE`.
2. `corepack use pnpm@11`, which writes `packageManager`. `pnpm init`, fill in
   the fields above.
3. `pnpm-workspace.yaml` with the hardening block.
4. `pnpm add -D typescript vitest @biomejs/biome @types/node`. Expect
   `minimumReleaseAge` to refuse anything published in the last day; that is
   working as intended, wait or pin one version back.
5. `tsconfig.json`, `biome.json`.
6. `src/version.ts` with a test (TDD starts here, even for this).
7. The two bins, printing the version and exiting 0.
8. `skill/SKILL.md` placeholder with a one-line note that ticket 11 fills it.
9. `README.md`.
10. CI workflow. Push, watch all six jobs go green.
11. `pnpm link --global` locally and confirm both commands work from another
    directory.

## Done when

- `pnpm install && pnpm check && pnpm build` passes locally.
- All CI jobs green, including the smoke step on Windows.
- `docsync --version` and `git-remote-docsync --version` print the package
  version after a global link.

## Open

- License: MIT unless you say otherwise.
- Repo settings on GitHub (branch protection, required CI) are outside this
  ticket; do them when CI exists.
