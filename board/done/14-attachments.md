# 14 — Attachments

Phase 2. Manual §6 "Layout" and dialect tables (the two **later** rows),
§7 Fetch and Write-back, §12 phase 2.

## Goal

Files hosted by the source round-trip: an image or file inside a Notion page
or a Google Doc is a real file on disk, linked from the Markdown; a new or
changed file on disk is uploaded on push; nothing is re-downloaded or
re-uploaded when it did not change.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Where | `<title>.assets/` beside `<title>.md`. Names from the source's file name where it has one (Notion `name`, the URL's last path segment) or `image-<n>.<ext>` from the content type (Docs inline images), made unique with the filename rules of §6 and kept stable across fetches by the index | Manual §12; stable names keep diffs quiet. |
| Link | `![caption](<title>.assets/photo.png)` for images, `[name](<title>.assets/spec.pdf)` for files, PDF and video, replacing the placeholder comment. Docs images keep the object's alt text as the caption | The dialect already has these forms for external URLs. |
| Index | Each asset is an index entry: type `asset`, its path, the owning document's path, the source id (Notion block id, Docs inline object id), a checksum, and the block or object's last-edit time where the source has one | Change detection and rename mapping without touching the Markdown. |
| Change detection | Notion: the block's `last_edited_time` moved, or the asset is not in the index. Docs: images of a changed Doc are downloaded and compared by checksum; the file is rewritten only when the bytes differ. A document that did not change downloads nothing | Notion's URLs are signed and change every hour, so the URL says nothing; the block time does. Docs does not stamp objects. |
| Push, Notion | A link into `<title>.assets/` that is new or whose file's checksum changed: File Upload API (`POST /v1/file_uploads`, then send the bytes; single part to 20 MB, multipart above), then the block is created or patched with `file_upload: { id }`. The block type follows the link form and the extension: `![]()` → image; `.pdf` → pdf; video extensions → video; anything else → file. Uploaded assets get a fresh name from Notion; the post-push fetch re-downloads and re-links, and the report says `uploaded <n> files` | Manual §12. |
| Push, Google Docs | The image bytes are uploaded to Drive into a folder `<doc title>.assets` beside the Doc, given a temporary "anyone with the link" reader permission, inserted with `insertInlineImage` (Docs copies the bytes into the document), then the permission is removed and the Drive copy trashed, in that order, all in one push. Non-image files are refused on Docs: "Google Docs cannot hold a file; link to it instead" | `insertInlineImage` takes only a public URI. The exposure lasts one push; the trash keeps nothing shared. Owner to confirm. |
| Diff write-back | An unchanged link is a kept block. A changed link target or changed bytes replaces the block (Notion: patch the file on the same block, id kept; Docs: delete the object and insert). A link to a file that is not on disk is refused naming the path | Ticket 15/16 rules carry over. |
| Deletion | The Markdown link gone → the block goes (diff). An asset file deleted while its link stays → refused. Assets of a document that was deleted or renamed follow it: `git mv` of the directory is a rename, its files' index entries move with the document | No orphans, no silent loss. |
| Limits | Files over 5 MB in a Doc, or over Notion's plan limit, are reported and skipped on push, never partially uploaded. A fetch downloads whatever the source serves | Predictable. |
| External URLs | Unchanged: `![](https://…)` stays a link to the URL, nothing downloaded | Manual §6. |
| Git | Assets are ordinary tracked files. `init` adds `*.assets/** binary` to `.gitattributes` so diffs stay readable | Housekeeping. |

## Module

| File | Purpose |
|---|---|
| `src/assets.ts` | Names, index entries, checksum, link rewriting; source-agnostic. |
| `src/notion/assets.ts`, `src/gdrive/assets.ts` | Download and upload per source. |
| `src/notion/api.ts`, `src/gdrive/api.ts` | File Upload endpoints; `insertInlineImage`, permissions. |
| `src/helper/changes.ts` | Asset entries in the diff (bytes, owning document). |

## Tests

- Naming and uniqueness; stability across two fetches; rename of the
  owning document moves the entries.
- Notion fetch: a hosted image and a hosted file (fixture to be added by
  the owner) downloaded and linked; unchanged block not re-downloaded;
  expired URL handled by re-reading the block.
- Docs fetch: the Elements image downloaded, linked with its alt text,
  identical bytes not rewritten.
- Push, both sources, through the fake APIs: new image, changed bytes,
  removed link, missing file refused, non-image on Docs refused, size limit.
- Round trip on both fixtures. Smoke scripts for both sources that upload a
  small PNG into a page or Doc they create, verify, and trash it; the Docs
  one asserts the permission is gone and the Drive copy trashed.

## Done when

`pnpm check` green, both smoke scripts pass, manual rows updated and the
**later** marks removed.

## Outcome

Landed 2026-09-04 in six agent commits (`3878dd5` … `a0f81a5`) plus the
landing commit. `pnpm check` green, 1324 tests. Both fixtures now check out
with `<title>.assets/` (Notion: `chili.png`, `sample-file.bin`; Docs:
`image-1.png`), fixtures re-recorded.

- Docs image push request sequence, verified against real Google: create
  the assets folder, private upload, share anyone/reader, one `batchUpdate`
  with `insertInlineImage`, unshare, trash, the last two in a `finally`; a
  failure names what was left behind. The smoke script proved clean-up
  after a deliberately failed insert.
- Notion smoke: upload, in-place patch of the same block id, new bytes
  served. Run 1 found a real bug (`blocks.update` refuses `type` inside the
  body), fixed. The last check (missing file refused) failed on the script's
  own dashed id; fixed both in the script and in `push.ts` lookup, unit
  tested, not re-run against Notion since the script had used its two runs.
- Notion plan limit is not readable; 5 GiB pre-check plus upload failure
  handling, both reported as skipped. Multipart above 20 MB unit-tested only.
- Docs cannot set alt text on insert; a pushed image loses it. An image
  inside a text paragraph with empty alt is not detected as added or
  removed. `replaceImage` would keep the object on changed bytes; a
  follow-up.
- `.gitattributes` written by `init` and excluded like `.prettierrc`.
- Manual: both dialect rows, layout row, identity, `init` steps, §7
  write-back, §12 phase 2 done.
