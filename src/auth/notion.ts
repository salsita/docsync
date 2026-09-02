/**
 * Notion's half of the OAuth flow, done with plain `fetch`.
 *
 * `openid-client` drives Google (see `google.ts`) and it does accept Notion's
 * token *response* — the missing `expires_in` and the extra `workspace_name`,
 * `bot_id` and `owner` fields are all fine. What it cannot do is send the
 * *request* the way Notion wants it:
 *
 * - Notion's token endpoint takes a JSON body, not `application/x-www-form-
 *   urlencoded`, and `openid-client` only speaks the latter (correctly — it is
 *   what RFC 6749 says).
 * - `openid-client` builds the HTTP Basic header per RFC 6749 §2.3.1, which
 *   form-encodes each half before base64. Notion's client ids are UUIDs, and
 *   `-` comes out as `%2D`, so the credentials would not match.
 *
 * So the Notion exchange is thirty lines of `fetch` rather than a library, and
 * that is the whole of the deviation. Notion has no scopes, its tokens do not
 * expire, and there is no refresh token, so this file has no refresh path.
 */
import { AuthError } from './errors.js';
import type { Credential, Identity, OAuthApp } from './types.js';

export const NOTION_ENDPOINTS = {
  authorization: 'https://api.notion.com/v1/oauth/authorize',
  token: 'https://api.notion.com/v1/oauth/token',
};

/**
 * Where to send the browser. `owner=user` is what makes Notion show the page
 * picker and mint a token acting as the person, rather than as a bare
 * integration that pages must be shared with by hand (MANUAL §2).
 */
export function notionAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  endpoint?: string;
}): string {
  const url = new URL(options.endpoint ?? NOTION_ENDPOINTS.authorization);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    owner: 'user',
    redirect_uri: options.redirectUri,
    state: options.state,
  }).toString();
  return url.toString();
}

/** The shape of the bits of Notion's token response docsync reads. */
interface NotionTokenResponse {
  access_token?: unknown;
  workspace_name?: unknown;
  owner?: { user?: { name?: unknown; person?: { email?: unknown } } };
  error?: unknown;
  error_description?: unknown;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function identityOf(body: NotionTokenResponse): Identity {
  const identity: Identity = {};
  const name = stringOr(body.owner?.user?.name);
  const email = stringOr(body.owner?.user?.person?.email);
  const workspace = stringOr(body.workspace_name);
  if (name) identity.name = name;
  if (email) identity.email = email;
  if (workspace) identity.workspace = workspace;
  return identity;
}

/** Trade the authorization code for a token. Nothing here is ever logged. */
export async function exchangeNotionCode(options: {
  app: OAuthApp;
  code: string;
  redirectUri: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<Credential> {
  const { app, code, redirectUri, endpoint = NOTION_ENDPOINTS.token, fetchImpl = fetch } = options;

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      // Plain base64 of `client_id:client_secret`, which is what Notion checks.
      authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });

  const body: NotionTokenResponse | undefined = await response
    .json()
    .then((value) => value as NotionTokenResponse)
    .catch(() => undefined);

  if (!response.ok) {
    const error = stringOr(body?.error);
    const description = stringOr(body?.error_description);
    throw new AuthError(
      'notion',
      error
        ? `Notion refused the sign-in: ${error}${description ? ` (${description})` : ''}.`
        : `Notion's token endpoint answered ${response.status}.`,
    );
  }

  const accessToken = stringOr(body?.access_token);
  if (!accessToken) {
    throw new AuthError('notion', "Notion's token response carried no access token.");
  }
  // No `expiresAt` and no `refreshToken`: Notion tokens do not expire.
  return { accessToken, identity: identityOf(body ?? {}) };
}
