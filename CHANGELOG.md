# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
versions are [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
the version is `0.x` a minor release may still change behaviour.

Each release is written by hand from the finished tickets in `board/done/`.
The release workflow takes a version's section here as the body of its GitHub
release, so a section's heading is `## [<version>] — <date>`.
`scripts/release.sh` turns `[Unreleased]` into that heading, bumps the
version, commits, tags and pushes.

## [Unreleased]

### Changed

- CI is green on Windows: the git runner spells the checkout's paths the
  platform's way (long names, backslashes), and the three path tests that
  assumed `/` pass there.

## [0.1.2] — 2026-09-09

### Changed

- Every checkout carries `pull.rebase=true` in its own git config, set by
  the refresh every command runs, so `git pull` over a local commit rebases
  instead of asking how to reconcile divergent branches. An explicit local
  value is kept. `docsync push`'s follow-up pull passes `--no-rebase` so an
  edit in progress still only blocks it when git would overwrite it.

## [0.1.1] — 2026-09-09

### Changed

- Releases go through npm trusted publishing: `scripts/release.sh` bumps the
  version, turns this section into the release, tags and pushes, and the tag
  run publishes with provenance and creates the GitHub release.
- Biome's warnings cleared; no behaviour change.

## [0.1.0] — 2026-09-09

Initial release. What it does is in [MANUAL.md](MANUAL.md); the tickets that
built it are in `board/done/`.
