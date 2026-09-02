# 04 — Auth

Phase 1. Manual §2.

## Goal

`docsync auth <source>` produces a working token for each source, stored in
the OS keychain, using a user-supplied OAuth app.

## Scope

- `~/.docsync/oauth-apps.yaml`: template with instructions, opened in the
  editor when the entry is missing, owner-only permissions.
- Localhost callback server on port 27183, browser launch, code exchange.
- Google: PKCE, Drive + Docs scopes. Also read Application Default Credentials
  from gcloud when present, and prefer them.
- Notion: public integration flow, workspace and page picker handled by Notion.
- Keychain storage on macOS, Windows, Linux. `--logout`.
- A `CredentialProvider` interface the adapters consume, so tests never touch
  the keychain.
- Uniform "not signed in" error that names the command to run.

## Done when

Both flows work end to end on macOS and Windows against real accounts, and
everything except the browser round trip is unit tested.
