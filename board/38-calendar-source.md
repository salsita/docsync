# 38 — A calendar event as a source

Unrefined. Waits for 37 (tabs).

## Goal

`docsync add calendar:<eventId>` pulls the meeting notes and transcripts of
every past call of a recurring Google Calendar event: the Docs that Gemini
and Meet attach to each instance. Each call is a directory in the root, and
each notes Doc is the tabbed layout of ticket 37.

## Notes from the brainstorm (2026-09-14)

- Ref `calendar:<eventId>`, looked up on the user's primary calendar. A
  Calendar URL is accepted by `docsync add` and `init`: the token after
  `eventedit/` is unpadded base64 of `<eventId> <calendarId>`; an instance
  URL carries `<eventId>_<timestamp>`, stripped to reach the series. The
  calendar id is kept only when it is not the user's own.
- Discovery: `events.instances` on the series, paged, past instances only,
  oldest first; each instance's `attachments[]` carries Drive file ids. One
  Calendar call per 250 instances, then one `files.get` per Doc for the
  modified time, as a folder root pays per file. Recordings (video) are
  ignored by default.
- Scope: Calendar events read-only added to the Google OAuth app; everyone
  runs `docsync auth google` once more. The Calendar API is enabled on the
  project.
- Layout: `<root>/<instance start, YYYY-MM-DD HH-MM> <event title>/` holding
  the attached Docs; a tabbed notes Doc is a directory of tabs inside it.
- `readonly: true` by default; `comments: true` allowed.
- If an attachment is missing from an instance, nothing is expected: the
  feature works where Calendar shows the attachment.

## Open

- Whether to reuse the Drive adapter's walk for the attached Docs or hand
  the ids to it one by one.
- Whether the calendar id belongs in the ref (`calendar:<eventId>@<calendarId>`)
  or in a root field.
