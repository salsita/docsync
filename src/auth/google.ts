/**
 * Google's half of the flow, driven by `openid-client`: discovery against
 * `https://accounts.google.com`, authorization code with PKCE, and the refresh
 * grant. Unlike Notion, Google is a plain OpenID Connect provider and the
 * library does all of it, ID token signature included.
 *
 * Two parameters are load-bearing and easy to lose: `access_type=offline` and
 * `prompt=consent`. Google only issues a refresh token for an offline request,
 * and it only issues one *again* on a re-consent — so without `prompt=consent`
 * a second `docsync auth gdocs` on an already-approved app comes back with an
 * access token and no way to renew it.
 *
 * The Drive scope is the full one: `drive.file` only ever sees files the app
 * itself created, which cannot list a folder the user picked (ticket 04).
 */
import * as client from 'openid-client';
import { AuthError } from './errors.js';
import type { AuthDeps, Credential, Identity, OAuthApp } from './types.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** Exactly the scopes docsync needs, and no more (ticket 04). */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
].join(' ');

/** A discovered, authenticated client for the user's own OAuth app. */
export async function googleConfiguration(
  app: OAuthApp,
  deps: AuthDeps = {},
): Promise<client.Configuration> {
  const issuer = deps.googleIssuer ?? GOOGLE_ISSUER;
  return client.discovery(
    new URL(issuer),
    app.clientId,
    app.clientSecret,
    client.ClientSecretPost(app.clientSecret),
    {
      // Only ever true for a mock issuer in a test; the real one is https.
      execute: issuer.startsWith('http://') ? [client.allowInsecureRequests] : [],
      ...(deps.fetch ? { [client.customFetch]: deps.fetch } : {}),
    },
  );
}

/** Where to send the browser. */
export function googleAuthorizationUrl(
  config: client.Configuration,
  options: { redirectUri: string; state: string; codeChallenge: string },
): string {
  return client
    .buildAuthorizationUrl(config, {
      redirect_uri: options.redirectUri,
      scope: GOOGLE_SCOPES,
      state: options.state,
      code_challenge: options.codeChallenge,
      code_challenge_method: 'S256',
      // Together: issue a refresh token, and issue one every time.
      access_type: 'offline',
      prompt: 'consent',
    })
    .toString();
}

/** `email` and `name` out of an ID token's claims or a userinfo response. */
function identityFrom(claims: unknown): Identity | undefined {
  const { email: rawEmail, name: rawName } = (claims ?? {}) as Record<string, unknown>;
  const email = typeof rawEmail === 'string' ? rawEmail : undefined;
  const name = typeof rawName === 'string' ? rawName : undefined;
  if (!email && !name) return undefined;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

async function credentialFrom(
  config: client.Configuration,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
  fallback: Credential | undefined,
  now: () => number,
): Promise<Credential> {
  // `expires_in` rather than the helper `expiresIn()`: the helper counts down
  // from when the response arrived, which makes the stored expiry depend on how
  // long the call took.
  const expiresIn = tokens.expires_in;
  const credential: Credential = {
    accessToken: tokens.access_token,
    identity: fallback?.identity ?? {},
  };
  const refreshToken = tokens.refresh_token ?? fallback?.refreshToken;
  if (refreshToken) credential.refreshToken = refreshToken;
  if (expiresIn !== undefined) credential.expiresAt = now() + expiresIn * 1000;

  // The ID token is the cheap answer; `userinfo` is the fallback for a
  // response that carried no `email` claim, which is what a refresh looks like.
  const fromIdToken = identityFrom(tokens.claims());
  if (fromIdToken) {
    credential.identity = fromIdToken;
  } else if (!credential.identity.email) {
    const info = await client
      .fetchUserInfo(config, tokens.access_token, client.skipSubjectCheck)
      .catch(() => undefined);
    credential.identity = identityFrom(info) ?? credential.identity;
  }
  return credential;
}

/** Trade the authorization code for tokens, checking `state` and the PKCE verifier. */
export async function exchangeGoogleCode(
  config: client.Configuration,
  options: {
    code: string;
    state: string;
    redirectUri: string;
    codeVerifier: string;
    now?: () => number;
  },
): Promise<Credential> {
  const callback = new URL(options.redirectUri);
  callback.searchParams.set('code', options.code);
  callback.searchParams.set('state', options.state);

  const tokens = await client
    .authorizationCodeGrant(config, callback, {
      expectedState: options.state,
      pkceCodeVerifier: options.codeVerifier,
      idTokenExpected: true,
    })
    .catch((cause: unknown) => {
      throw new AuthError('gdocs', `Google refused the sign-in: ${reason(cause)}`, { cause });
    });

  const credential = await credentialFrom(config, tokens, undefined, options.now ?? Date.now);
  if (!credential.refreshToken) {
    throw new AuthError(
      'gdocs',
      'Google issued no refresh token. Remove docsync from ' +
        'https://myaccount.google.com/permissions and sign in again.',
    );
  }
  return credential;
}

/** Renew an access token. The identity and the refresh token carry over. */
export async function refreshGoogleToken(
  config: client.Configuration,
  credential: Credential,
  now: () => number = Date.now,
): Promise<Credential> {
  if (!credential.refreshToken) {
    throw new AuthError('gdocs', 'The stored Google credential has no refresh token.');
  }
  const tokens = await client
    .refreshTokenGrant(config, credential.refreshToken)
    .catch((cause: unknown) => {
      throw new AuthError('gdocs', `Google would not renew the token: ${reason(cause)}`, { cause });
    });
  return credentialFrom(config, tokens, credential, now);
}

/** A message for the user that never repeats a secret back at them. */
export function reason(cause: unknown): string {
  if (cause instanceof client.ResponseBodyError) {
    return `${cause.error}${cause.error_description ? ` (${cause.error_description})` : ''}.`;
  }
  // openid-client wraps the specific oauth4webapi complaint one level down, so
  // walk the chain: "invalid response encountered" alone helps nobody.
  const parts: string[] = [];
  let current: unknown = cause;
  while (current instanceof Error && parts.length < 4) {
    const code = 'code' in current && typeof current.code === 'string' ? ` [${current.code}]` : '';
    parts.push(`${current.message}${code}`);
    current = current.cause;
  }
  return parts.length > 0 ? parts.join(': ') : String(cause);
}
