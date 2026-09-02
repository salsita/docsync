# 03 — Source refs and URL normalisation

Phase 1. Manual §1, §13.

## Goal

`notion:<id>` and `gdocs:<id>` as a typed value, parsed from refs and from
the URLs people actually paste.

## Scope

- Parse and print refs. Normalise Notion ids (dashed and undashed).
- Accept Notion page URLs (with and without the title slug) and Drive/Docs URLs
  (`/document/d/<id>`, `/drive/folders/<id>`, `open?id=`).
- Reject anything else with a helpful message.

## Done when

A table-driven test covers every accepted URL shape and several rejected ones.
