# 04 — Auth

Phase 1. Manual §2.

## Goal

`docsync auth <source>` produces a working token for each source, stored in
the OS keychain, using a user-supplied OAuth app. Adapters get tokens through
one interface and never see the flow.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| OAuth library | `openid-client` (v6, ESM, no build script) | Authorization code + PKCE, loopback redirect, refresh grant, discovery for Google, manual metadata for Notion. One library for both sources. |
| Keychain | `@napi-rs/keyring` | Prebuilt per-platform binaries, no postinstall script, so `allowBuilds` stays empty. macOS Keychain, Windows Credential Manager, Secret Service. **Verify it installs under `strictDepBuilds` before writing code; if it needs a build, stop and report.** |
| Loopback port | 27183, fallback 27184 | Notion requires exact redirect URIs, so ports are fixed and both are in the template instructions. Google allows any loopback port. |
| Google scopes | `openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents` | Full Drive scope is required to list folders and update existing files; `drive.file` only covers files the app created. `openid email` gives the "signed in as" line. |
| Notion scopes | none | Notion has no OAuth scopes; capabilities are set on the integration. |
| Apps file | `~/.docsync/oauth-apps.yaml`, mode 0600 | Manual §2. |

## Module

`src/auth/`:

| File | Purpose |
|---|---|
| `apps-file.ts` | Read `oauth-apps.yaml`; write the commented template when missing; open `$EDITOR` (`%EDITOR%`, then `notepad` on Windows, `vi` elsewhere) and re-read; validate that the needed entry is filled. |
| `loopback.ts` | Start an HTTP server on the first free port of the list, hand the authorization URL to the browser (`open`-style spawn of the platform opener, printing the URL as well), receive one callback, respond with a small "you can close this tab" page, shut down. Timeout after 5 minutes. |
| `google.ts` | `openid-client` discovery against `https://accounts.google.com`, PKCE, refresh grant. |
| `notion.ts` | Manual `Configuration` with `authorization_endpoint: https://api.notion.com/v1/oauth/authorize`, `token_endpoint: https://api.notion.com/v1/oauth/token`, client auth `ClientSecretBasic`, `owner=user` on the authorization URL. Notion tokens do not expire and have no refresh. The token response carries `workspace_name`, `bot_id` and `owner.user`; keep them for "signed in as". |
| `store.ts` | Keychain read/write/delete under service `docsync`, account `<source>`. Value is JSON: tokens, expiry, identity. |
| `provider.ts` | `CredentialProvider` interface: `accessToken(source): Promise<string>` that refreshes when within 60 s of expiry, and `identity(source)`. One implementation over `store.ts`; one in-memory fake for tests. |
| `errors.ts` | `NotSignedInError(source)` whose message is the exact command to run, and `AppsFileIncompleteError(source)` pointing at the file. |

`docsync auth <source>` and `--logout` themselves are wired in ticket 10; this
ticket exposes `signIn(source)`, `signOut(source)`, `whoAmI(source)` for it.

## Risks to retire first

1. `@napi-rs/keyring` under `strictDepBuilds`.
2. `openid-client` validating Notion's token response. Notion returns
   `token_type: "bearer"` and no `expires_in`; confirm the library accepts it
   (v6 validates token responses). If it does not, do the Notion token
   exchange with a plain `fetch` and Basic auth, and say so in the Outcome.
3. Loopback on Windows: firewall prompt on first listen. Document the
   expectation in the manual if it happens.

## Tests

- `apps-file`: template written when missing, permissions 0600 on POSIX,
  incomplete entry detected, comments preserved on re-read, editor spawn
  mocked.
- `loopback`: first port busy → second used; both busy → clear error; state
  mismatch on callback → rejected; timeout.
- `google` and `notion`: the code exchange and refresh against a local mock
  server driven by `openid-client`'s configuration override for the issuer
  URL (or `undici` MockAgent).
- `store`: round trip against the real keychain, tagged so it can be skipped
  in CI where no keychain exists (Linux runners); a fake store for everything
  else.
- `provider`: refresh happens at the 60 s boundary, `NotSignedInError` when
  the store is empty.

End to end on a real machine, once each, recorded in the Outcome: Google and
Notion.

## Done when

`pnpm check` green, both real flows verified on macOS and on Windows, and a
sketch adapter (a ten-line script) can list the signed-in user's Drive root
and Notion search results using only `CredentialProvider`.

## Outcome

Landed in `916f518..479c05a`. `src/auth/` at 100% line coverage, 441 tests,
one skipped unless `DOCSYNC_TEST_KEYCHAIN=1`.

- `@napi-rs/keyring` 2.0.0 installs with `allowBuilds` empty: prebuilt
  binaries, no lifecycle script. Loads and round-trips on macOS arm64.
- `openid-client` 6.8.7 drives Google (discovery, PKCE, refresh, ID-token
  verification). It accepts Notion's token *response* but cannot send the
  *request*: Notion wants a JSON body and a Basic header without RFC 6749
  form-encoding of the UUID client id. The Notion exchange is therefore
  thirty lines of `fetch`.
- The source name is `gdocs`, matching source refs; `google` is an alias and
  the apps-file key. Manual §2 updated.
- Token renewal never opens the editor; only `docsync auth` does. Manual §2
  updated.
- `AuthDeps` is a larger injectable bag than the ticket listed (home, log,
  ports, timeout, issuer and endpoint overrides) so every flow is testable
  against local mock servers.
- A Google sign-in that yields no refresh token is refused with a pointer to
  the account's permissions page.
- Smoke scripts: `scripts/auth-smoke.ts` and `scripts/api-smoke.ts`, run with
  `node --experimental-strip-types` after `pnpm build`. Real flows not yet
  run; the owner runs them.
- Not done: Windows verification, deferred to ticket 12. Manual §11 gained
  the firewall note in advance.
