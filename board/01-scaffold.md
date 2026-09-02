# 01 — Project scaffold

Phase 1.

## Goal

A TypeScript package that builds, tests, and installs two executables:
`docsync` and `git-remote-docsync`.

## Scope

- pnpm 11, Node LTS, TypeScript strict, ESM.
- `pnpm-workspace.yaml` supply-chain hardening:
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
- vitest for tests. TDD from here on: every ticket starts with failing tests.
- `bin` entries for both executables, working via `pnpm link --global`.
- The skill file (`SKILL.md`) lives in the package and is bundled.
- GitHub Actions: lint, typecheck, test on macOS, Linux and Windows.
- Lint and format with a single tool (biome or eslint+prettier, pick one).

## Done when

`pnpm install && pnpm test` is green on all three OSes in CI and
`docsync --version` prints the version after a global link.
