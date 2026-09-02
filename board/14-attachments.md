# 14 — Attachments

Phase 2. Manual §12 phase 2.

## Goal

Source-hosted images and files round-trip.

## Scope

- Fetch: download into `<title>.assets/` beside the document, link relatively.
  Notion URLs expire, so download always happens at fetch time. Change
  detection so unchanged assets are not re-downloaded.
- Push, Notion: File Upload API (single request to 20 MB, multipart above),
  attach to image, file, PDF or video blocks. New and changed files.
- Push, Google Docs: upload to Drive, insert by reference.
- Deleted asset file → block removed.
- Manifest and index updates as needed.

## Done when

Round-trip tests with image and file fixtures pass for both sources.
