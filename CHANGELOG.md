# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
versions are [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While
the version is `0.x` a minor release may still change behaviour.

Each release is written by hand from the finished tickets in `board/done/`.
The release workflow takes a version's section here as the body of its GitHub
release, so a section's heading is `## [<version>] — <date>`.

## [Unreleased]

## [0.1.0] — 2026-09-05

The first release: the core loop of the manual, plus attachments, diff-based
write-back and read-only comments.

### Added

- `docsync init`, `add`, `remove` and a manifest (`.docsync.yaml`) that says
  which Notion page trees and Drive folders a checkout holds, where each is
  mounted, and what is ignored. Roots can be `readonly:` or opt into comments.
- The git remote helper `git-remote-docsync`: `git clone`, `fetch`, `pull` and
  `push` work against a `docsync::<manifest>` remote with no docsync command
  involved. A push that would overwrite a source change is refused, and git's
  ordinary three-way merge resolves it.
- `docsync status`, `fetch`, `pull`, `push` and `resolve`. `status` previews
  what a push would do to each document before it touches anything; `pull`
  works on a branch; `push` does the push and its follow-up pull in one step
  and reports per document. Long fetches and pushes report progress as they go.
- `docsync auth notion|gdocs`, an OAuth flow over a temporary localhost
  callback, with the tokens in the OS keychain and the team's OAuth apps read
  from `~/.docsync/oauth-apps.yaml`.
- Notion and Google Drive as sources: pages and Docs as canonical Markdown,
  other Drive files as bytes, Sheets, Slides and Drawings as read-only
  exports. Frontmatter carries the identity and a link back to the source.
- Attachments: images and files hosted by a source are fetched into
  `<title>.assets/` beside the document and linked relatively; new and changed
  ones are uploaded on push.
- Diff-based write-back for both sources: a push patches only the characters
  that changed, so untouched blocks keep their ids, comments, history and
  everything the Markdown dialect does not express.
- Open comment threads and pending suggestions pulled into a read-only sidecar
  beside a document, on roots with `comments: true`.
- A skill file written into every checkout for Claude Code, Codex and Cursor,
  refreshed by every command so an upgrade reaches existing checkouts.
- A Markdown dialect that survives a round trip and Prettier's defaults
  unchanged, including Notion's inline runs and block-edge whitespace.
- Windows support: LF everywhere, `/` in manifests and frontmatter, no
  symlinks, and both executables installed as shims.
- The manual ships in the package, so `docsync --help` and the skill file's
  references resolve offline.

### Known limitations

- Notion databases, and pages inside them, are not synced.
- Sheets, Slides and Drawings are read-only.
- A Google Docs fetch collapses the source's revisions into one commit.
- The helper serves one branch, `main`, per remote.
- Comments and suggestions are read-only: nothing is pushed back.
