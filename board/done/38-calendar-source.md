# 38 — A calendar event as a source

Phase 1. Manual §1 concepts, §2 credentials, §4 manifest, §5 `add`/`init`/`resolve`, §6 layout, §7 fetch and push, §13.

## Problem

Recurring client calls leave a trail of Docs: the notes Gemini takes and the
transcripts Meet writes, one per call, attached to that call's instance of
the recurring Calendar event and dropped in the organiser's "Meet Recordings"
folder. Nobody wants to `docsync add` each one. The event is the thing that
knows them all: `docsync add calendar:<eventId>` should pull every past
call's attachments, and every later pull should pick up the calls that
happened since.

Ticket 37 made a Gemini notes Doc a directory of tabs; this ticket puts
those directories under the calls they belong to.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Source | A third source, `calendar`, beside `gdocs` and `notion`: `Source` gains the name, the registry gains an adapter, `sourceNames` lists it. Its credential is the Google one: `provider.accessToken('gdocs')` behind a small mapping from source to credential, so there is no `docsync auth calendar` and the Google sign-in covers both | One token, one consent screen. |
| Scope | `https://www.googleapis.com/auth/calendar.events.readonly` added to `GOOGLE_SCOPES`. A Calendar call refused for insufficient scope (403, "insufficient authentication scopes") fails the fetch with "the Google sign-in predates calendar support; run `docsync auth google` again" | Existing tokens lack it; the message says the one thing to do. |
| Ref | `calendar:<eventId>` on the user's primary calendar, or `calendar:<eventId>@<calendarId>` for another calendar, split at the first `@` (an event id is `[a-v0-9_]` and never holds one). Instance ids (`<eventId>_<start>`) are cut to the series in `parseSourceRefOrUrl` and in `describe` | The ref names the object fully, so it survives in ignore lists and the index. |
| URL | `docsync add`, `init` and `resolve` accept a Calendar URL: the segment after `eventedit/` or `event?eid=` is unpadded base64url of `<eventId> <calendarId>`. The calendar part is dropped when it equals the signed-in identity's email or `primary`; otherwise it is kept in the ref | The URL is the only place the UI shows an event id. |
| What one root is | The series, or a single event, read with `events.get`. A series lists its instances with `events.instances`, `timeMax` now, paged at 250, `status` cancelled skipped; a single event is its own one instance. Instances are ordered by start, oldest first | Past calls only; the future has no notes. |
| What is pulled | Every instance's `attachments[]` whose `fileId` is a Drive file: a Google Doc as ticket 37 lays it out (a file, or a directory of tabs), any other file as the Drive adapter checks it out (binary, or an export). Video and audio attachments (Meet recordings) are skipped and reported as skipped objects, not checked out | Recordings are hundreds of megabytes and not text. |
| Layout | `<root>/<YYYY-MM-DD HH-MM> <instance title>/` per instance that has at least one attachment pulled, the time from `start.dateTime` in the event's own time zone (`start.date` for an all-day event, no time part), the title the instance's `summary` by the §6 filename rules; inside it the attachments by their Drive titles as §6 has them. An instance with nothing to pull makes no directory | Sorts by date; a call is a folder. |
| Identity | Attachments keep their Drive identity: index entries `src: gdocs:<fileId>` (`gdoc`, `drive-file`, `asset`, and the tab and directory entries of ticket 37) exactly as a Drive root writes them. No entry for an instance directory: its name is derived, and git follows a retitled series as a rename | The files are Drive files; every rule about them holds. |
| Reuse | The adapter builds the `WalkedFile` list itself (instances → attachments → one `files.get` per attachment for the modified time and mime type) and hands it to the Drive adapter's file conversion, exported for the purpose, so tabs, assets, comments and sidecars are the same code. Nothing in `src/gdrive` learns about calendars | One conversion path. |
| Change detection | As Drive: the file's modified time and, for binaries, the md5. A new instance or a new attachment on an old one is an addition; an attachment removed from the event, or its file trashed, is a deletion in the checkout | The listing is the walk. |
| Comments | `comments: true` works as on a Drive root: threads on the notes into sidecars | Reviewing notes is a use. |
| Push | A calendar root is read-only, always: any change under it is refused with the read-only wording of §7 step 3, naming the root, and `readonly:` is not a field it takes. `suggest` is refused by the manifest on a calendar root | Nothing meaningful to write back in this version; the notes belong to Gemini. |
| `describe` | Title the series' `summary`, kind `container`, `childCount` the number of past instances that carry an attachment, `lastEditedTime` the event's `updated` | What `docsync add` needs for a path and `resolve` prints. |
| `changedSince` | Instances and attachments listed again, one `files.get` per attachment; a new or gone instance or attachment counts as moved | Status stays a listing, no downloads. |
| `docsync add` default path | `<series title>/` by the §6 rules, as a folder root gets | A series is a container. |
| Errors | An event id the calendar does not have, or a calendar the user cannot read, fails `add`/`resolve` with the API's message and the ref | Nothing to guess. |
| Notion, Drive | Untouched | |
| Skill file | No change: a calendar root is read-only and the read-only sentence already covers it | |

## Module

| File | Purpose |
|---|---|
| `src/source-ref.ts` | `calendar` in `Source`; the ref with an optional calendar; the URL decoding; the instance suffix cut; `sourceUrl` → `https://calendar.google.com/calendar/event?eid=<base64url of "<eventId> <calendarId>">`. |
| `src/auth/google.ts`, `src/auth/provider.ts` | The scope; `calendar` resolved to the Google credential. |
| `src/calendar/api.ts` (new) | `events.get`, `events.instances` paged, plain `fetch` with the Drive adapter's retry, the scope refusal message. |
| `src/calendar/index.ts` (new) | `fetchRoot`, `describe`, `changedSince`, `pushRoot` (the refusal); instance directories; the walk handed to the Drive conversion. |
| `src/gdrive/index.ts` | The file conversion exported for the calendar adapter; nothing else. |
| `src/source.ts` | The registry entry. |
| `src/manifest/*` | `readonly`/`suggest` refused on a calendar root; the src forms in messages. |
| `src/cli/commands/add.ts`, `resolve.ts` | Nothing beyond the parser, unless a message lists sources. |
| `src/calendar/fake-api.mock.ts` (new) | Instances with attachments over the fake Drive of `src/gdrive/fake-api.mock.ts`. |
| Tests | Ref parsing: both forms, the instance suffix, the URL with and without the user's own calendar, `sourceUrl`; scope refusal message; a series of three past instances and one future, two with attachments (one a tabbed Doc, one a PDF, one a recording) fetched as two directories, the recording reported skipped, the future instance absent; a single event; an all-day instance's name; a second fetch after a new instance gained a notes Doc adds one directory; an attachment removed is a deletion; retitled series renames the directories; `comments: true` yields sidecars; push under the root refused with the read-only wording; manifest refuses `readonly`/`suggest`; `describe` counts; `changedSince` on a new attachment; the CLI e2e adds a fake series and pulls it. |

The tests run on fakes: a person's calendar is private and not a fixture.
The live check is the Done-when.

## Done when

`pnpm check` green. In a checkout, `docsync add <the event's eventedit URL>=calls/`
followed by `docsync pull` (after `docsync auth google`) checks out one
directory per past call that has notes, each holding the Gemini notes as a
directory of tabs, and a second `docsync pull` reports nothing changed.

## Outcome

Landed 2026-09-15 in five agent commits (`dd06fab` … `575591c`), a review
fix and the wording commit. `pnpm check` green, 1754 tests (+108).

- The adapter in `src/calendar/`: `events.get`, `events.instances` paged
  with `timeMax` now, cancelled instances dropped; one directory per past
  call with an attachment, named from the start in the event's own offset;
  the `WalkedFile` list handed to the Drive adapter's conversion, exported
  as `convertWalk` with `driveMemory`, so tabs, assets, comments and
  sidecars are the same code. The Google HTTP retry moved to
  `src/google-http.ts`, shared by Drive and Calendar; `GoogleApiError`
  carries status and detail.
- `calendar` in `Source`; auth maps it to the Google credential
  (`credentialSourceOf`), `docsync auth calendar` is refused; the scope
  `calendar.events.readonly` added; a 403 for scope becomes "run `docsync
  auth google` again".
- Read-only everywhere via `isReadOnlyRoot`: the planner, `status`, the
  manifest (`readonly:` refused on a calendar root), `add --readonly`
  refused; `resolve` prints `calendar event`.
- Deviations: the calendar id is dropped by `describe` (which has the
  identity), not the parser; the instance-suffix cut is in the shared
  literal parser; a single non-recurring event is not bounded by now;
  `describe` counts an instance whose only attachment is a recording;
  ignore patterns are not applied; a 404 on an attachment's file is
  reported as skipped `gone` rather than failing the fetch.
- Review fix: the agent had every `files.get` failure read as gone, which
  would have turned an expired token into a deletion of every attachment;
  only a 404 is gone now, anything else fails the fetch, with two tests.
- Done-when: not yet run. It needs the owner's `docsync auth google` first,
  since the stored token predates the calendar scope; the add and pull
  follow.
- Follow-ups: a trashed attachment file is still checked out (the field
  mask carries no `trashed`); `status` on a calendar root costs one
  `files.get` per attachment; two calls deriving to the same directory name
  get a suffix that is not id-stable; ignore patterns on calendar roots.
