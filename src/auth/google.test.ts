import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import {
  exchangeGoogleCode,
  GOOGLE_SCOPES,
  googleAuthorizationUrl,
  googleConfiguration,
  reason,
  refreshGoogleToken,
} from './google.js';
import { closeAll, type GoogleMockOptions, idToken, mockGoogle } from './oauth-servers.mock.js';

const APP = { clientId: '1234.apps.googleusercontent.com', clientSecret: 'GOCSPX-abc' };
const REDIRECT = 'http://localhost:27183/callback';
const VERIFIER = 'verifier-verifier-verifier-verifier-abc';

const servers: Server[] = [];

afterEach(() => closeAll(servers));

async function provider(options: Omit<GoogleMockOptions, 'clientId'> = {}) {
  const mock = await mockGoogle({ clientId: APP.clientId, ...options });
  servers.push(mock.server);
  return mock;
}

describe('googleAuthorizationUrl', () => {
  it('asks for offline access, a fresh consent, PKCE and exactly our scopes', async () => {
    const { issuer } = await provider();
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const url = new URL(
      googleAuthorizationUrl(config, {
        redirectUri: REDIRECT,
        state: 'st',
        codeChallenge: 'ch',
      }),
    );

    expect(url.pathname).toBe('/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('exchangeGoogleCode', () => {
  it('sends the code and verifier, and keeps tokens, expiry and identity', async () => {
    const { issuer, forms } = await provider();
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const credential = await exchangeGoogleCode(config, {
      callbackUrl: `${REDIRECT}?code=THE-CODE&state=st`,
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      now: () => 1_000_000,
    });

    expect(forms[0]?.get('grant_type')).toBe('authorization_code');
    expect(forms[0]?.get('code')).toBe('THE-CODE');
    expect(forms[0]?.get('code_verifier')).toBe(VERIFIER);
    expect(forms[0]?.get('redirect_uri')).toBe(REDIRECT);
    expect(forms[0]?.get('client_secret')).toBe(APP.clientSecret);

    expect(credential).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAt: 1_000_000 + 3599 * 1000,
      identity: { name: 'Jiri', email: 'jiri@example.test' },
    });
  });

  it('falls back to userinfo when the ID token names nobody', async () => {
    const { issuer } = await provider({
      token: (_form, iss) => ({
        body: {
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expires_in: 3599,
          token_type: 'Bearer',
          id_token: idToken(iss, APP.clientId),
        },
      }),
      userinfo: { body: { sub: '1029384756', email: 'from-userinfo@example.test' } },
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const credential = await exchangeGoogleCode(config, {
      callbackUrl: `${REDIRECT}?code=c&state=st`,
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
    });

    expect(credential.identity).toEqual({ email: 'from-userinfo@example.test' });
  });

  it('signs in with no identity at all rather than failing', async () => {
    const { issuer } = await provider({
      token: (_form, iss) => ({
        body: {
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          token_type: 'Bearer',
          id_token: idToken(iss, APP.clientId),
        },
      }),
      userinfo: { status: 500, body: { error: 'boom' } },
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const credential = await exchangeGoogleCode(config, {
      callbackUrl: `${REDIRECT}?code=c&state=st`,
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
    });

    expect(credential).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      identity: {},
    });
  });

  it('refuses a sign-in that came back without a refresh token', async () => {
    const { issuer } = await provider({
      token: (_form, iss) => ({
        body: {
          access_token: 'ya29.access',
          expires_in: 3599,
          token_type: 'Bearer',
          id_token: idToken(iss, APP.clientId, { email: 'jiri@example.test' }),
        },
      }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await exchangeGoogleCode(config, {
      callbackUrl: `${REDIRECT}?code=c&state=st`,
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/no refresh token/i);
    expect((error as AuthError).message).toContain('myaccount.google.com/permissions');
  });

  it('reports a token response that is not a token response', async () => {
    const { issuer } = await provider({
      token: () => ({ body: { token_type: 'Bearer' } }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await exchangeGoogleCode(config, {
      callbackUrl: `${REDIRECT}?code=c&state=st`,
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/refused the sign-in/);
  });

  it('reports what Google said when the code is bad', async () => {
    const { issuer } = await provider({
      token: () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Bad Request' },
      }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await exchangeGoogleCode(config, {
      callbackUrl: `${REDIRECT}?code=c&state=st`,
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('invalid_grant');
    expect((error as AuthError).message).toContain('Bad Request');
    expect((error as AuthError).message).not.toContain(APP.clientSecret);
  });
});

describe('refreshGoogleToken', () => {
  it('renews the access token, keeping the refresh token and the identity', async () => {
    const { issuer, forms } = await provider({
      token: () => ({
        body: {
          access_token: 'ya29.renewed',
          expires_in: 3599,
          token_type: 'Bearer',
          scope: GOOGLE_SCOPES,
        },
      }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const renewed = await refreshGoogleToken(
      config,
      {
        accessToken: 'ya29.old',
        refreshToken: '1//refresh',
        expiresAt: 5,
        identity: { email: 'jiri@example.test' },
      },
      () => 2_000_000,
    );

    expect(forms[0]?.get('grant_type')).toBe('refresh_token');
    expect(forms[0]?.get('refresh_token')).toBe('1//refresh');
    expect(renewed).toEqual({
      accessToken: 'ya29.renewed',
      refreshToken: '1//refresh',
      expiresAt: 2_000_000 + 3599 * 1000,
      identity: { email: 'jiri@example.test' },
    });
  });

  it('takes a rotated refresh token when Google sends one', async () => {
    const { issuer } = await provider({
      token: () => ({
        body: { access_token: 'a', refresh_token: '1//rotated', token_type: 'Bearer' },
      }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const renewed = await refreshGoogleToken(config, {
      accessToken: 'old',
      refreshToken: '1//refresh',
      identity: { email: 'jiri@example.test' },
    });

    expect(renewed.refreshToken).toBe('1//rotated');
    expect(renewed.expiresAt).toBeUndefined();
  });

  it('reports a revoked grant', async () => {
    const { issuer } = await provider({
      token: () => ({ status: 400, body: { error: 'invalid_grant' } }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await refreshGoogleToken(config, {
      accessToken: 'old',
      refreshToken: '1//refresh',
      identity: {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('invalid_grant');
  });

  it('refuses to refresh a credential that has no refresh token', async () => {
    const { issuer } = await provider();
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    await expect(refreshGoogleToken(config, { accessToken: 'old', identity: {} })).rejects.toThrow(
      /no refresh token/i,
    );
  });
});

describe('googleConfiguration', () => {
  it('uses the fetch it is given', async () => {
    const { issuer } = await provider();
    let calls = 0;
    const counting: typeof fetch = (...args) => {
      calls += 1;
      return fetch(...args);
    };

    await googleConfiguration(APP, { googleIssuer: issuer, fetch: counting });

    expect(calls).toBe(1);
  });
});

describe('reason', () => {
  it('walks the cause chain so the specific complaint is visible', () => {
    const inner = Object.assign(new Error('"response" body "id_token" property must be a string'), {
      code: 'OAUTH_INVALID_RESPONSE',
    });
    const outer = new Error('invalid response encountered', { cause: inner });
    expect(reason(outer)).toBe(
      'invalid response encountered: "response" body "id_token" property must be a string [OAUTH_INVALID_RESPONSE]',
    );
  });
});
