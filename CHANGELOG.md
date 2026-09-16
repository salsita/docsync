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

### Added

- The discussion under a Google Docs suggestion, and the line Docs prints
  on its card, are in the sidecar; comment threads are placed by the
  source's exact anchors, per tab. Both come from the Docs API under the
  Developer Preview; a project outside it keeps today's sidecar.
- A Google Calendar event as a source. `docsync add calendar:<eventId>`, or
  a Calendar URL, checks out the Drive files attached to the event's past
  instances, the Gemini notes and Meet transcripts, one directory per call,
  read-only. The Google sign-in gains the read-only calendar scope, so run
  `docsync auth google` once more before adding one.
- Google Docs tabs. A Doc with several tabs is checked out as a directory
  with one Markdown file per tab, each with its own id, sidecar and assets;
  a Doc with one tab is a file as before. A push writes into the right tab,
  creates a tab from a new file in the directory and retitles one; deleting
  a single tab file is refused. Until now only the first tab was pulled,
  and a checkout made before this release still holds only that until a
  `docsync pull --all` reads the Doc again.

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
