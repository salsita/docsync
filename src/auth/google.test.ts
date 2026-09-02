import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import {
  exchangeGoogleCode,
  GOOGLE_SCOPES,
  googleAuthorizationUrl,
  googleConfiguration,
  refreshGoogleToken,
} from './google.js';

const APP = { clientId: '1234.apps.googleusercontent.com', clientSecret: 'GOCSPX-abc' };
const REDIRECT = 'http://localhost:27183/callback';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key';
const JWK = {
  ...publicKey.export({ format: 'jwk' }),
  kid: KID,
  use: 'sig',
  alg: 'RS256',
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function idToken(issuer: string, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: APP.clientId,
      sub: '1029384756',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

interface Options {
  /** What the token endpoint answers, given the form body it received. */
  token?: (form: URLSearchParams, issuer: string) => { status?: number; body: unknown };
  userinfo?: { status?: number; body: unknown };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** A Google-shaped OpenID provider on loopback. */
async function mockGoogle(options: Options = {}) {
  const forms: URLSearchParams[] = [];
  let issuer = '';
  const server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const path = new URL(req.url ?? '/', issuer).pathname;

      if (path === '/.well-known/openid-configuration') {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/o/oauth2/v2/auth`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/v1/userinfo`,
          jwks_uri: `${issuer}/certs`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
        });
      }
      if (path === '/certs') return json(200, { keys: [JWK] });
      if (path === '/v1/userinfo') {
        const { status = 200, body = { sub: '1029384756' } } = options.userinfo ?? {};
        return json(status, body);
      }
      if (path === '/token') {
        const form = new URLSearchParams(await readBody(req));
        forms.push(form);
        const reply = options.token?.(form, issuer) ?? {
          body: {
            access_token: 'ya29.access',
            refresh_token: '1//refresh',
            expires_in: 3599,
            token_type: 'Bearer',
            scope: GOOGLE_SCOPES,
            id_token: idToken(issuer, { email: 'jiri@example.test', name: 'Jiri' }),
          },
        };
        return json(reply.status ?? 200, reply.body);
      }
      return json(404, { error: 'not_found' });
    })();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { issuer, forms };
}

describe('googleAuthorizationUrl', () => {
  it('asks for offline access, a fresh consent, PKCE and exactly our scopes', async () => {
    const { issuer } = await mockGoogle();
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
    const { issuer, forms } = await mockGoogle();
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const credential = await exchangeGoogleCode(config, {
      code: 'THE-CODE',
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier-verifier-verifier-verifier-abc',
      now: () => 1_000_000,
    });

    expect(forms[0]?.get('grant_type')).toBe('authorization_code');
    expect(forms[0]?.get('code')).toBe('THE-CODE');
    expect(forms[0]?.get('code_verifier')).toBe('verifier-verifier-verifier-verifier-abc');
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
    const { issuer } = await mockGoogle({
      token: (_form, iss) => ({
        body: {
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expires_in: 3599,
          token_type: 'Bearer',
          id_token: idToken(iss, {}),
        },
      }),
      userinfo: { body: { sub: '1029384756', email: 'from-userinfo@example.test' } },
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const credential = await exchangeGoogleCode(config, {
      code: 'c',
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier-verifier-verifier-verifier-abc',
    });

    expect(credential.identity).toEqual({ email: 'from-userinfo@example.test' });
  });

  it('signs in with no identity at all rather than failing', async () => {
    const { issuer } = await mockGoogle({
      token: (_form, iss) => ({
        body: {
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          token_type: 'Bearer',
          id_token: idToken(iss, {}),
        },
      }),
      userinfo: { status: 500, body: { error: 'boom' } },
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const credential = await exchangeGoogleCode(config, {
      code: 'c',
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier-verifier-verifier-verifier-abc',
    });

    expect(credential).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      identity: {},
    });
  });

  it('refuses a sign-in that came back without a refresh token', async () => {
    const { issuer } = await mockGoogle({
      token: (_form, iss) => ({
        body: {
          access_token: 'ya29.access',
          expires_in: 3599,
          token_type: 'Bearer',
          id_token: idToken(iss, { email: 'jiri@example.test' }),
        },
      }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await exchangeGoogleCode(config, {
      code: 'c',
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier-verifier-verifier-verifier-abc',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/no refresh token/i);
    expect((error as AuthError).message).toContain('myaccount.google.com/permissions');
  });

  it('reports a token response that is not a token response', async () => {
    const { issuer } = await mockGoogle({
      token: () => ({ body: { token_type: 'Bearer' } }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await exchangeGoogleCode(config, {
      code: 'c',
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier-verifier-verifier-verifier-abc',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/refused the sign-in/);
  });

  it('reports what Google said when the code is bad', async () => {
    const { issuer } = await mockGoogle({
      token: () => ({
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Bad Request' },
      }),
    });
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    const error = await exchangeGoogleCode(config, {
      code: 'c',
      state: 'st',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier-verifier-verifier-verifier-abc',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('invalid_grant');
    expect((error as AuthError).message).toContain('Bad Request');
    expect((error as AuthError).message).not.toContain(APP.clientSecret);
  });
});

describe('refreshGoogleToken', () => {
  it('renews the access token, keeping the refresh token and the identity', async () => {
    const { issuer, forms } = await mockGoogle({
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
    const { issuer } = await mockGoogle({
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
    const { issuer } = await mockGoogle({
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
    const { issuer } = await mockGoogle();
    const config = await googleConfiguration(APP, { googleIssuer: issuer });

    await expect(refreshGoogleToken(config, { accessToken: 'old', identity: {} })).rejects.toThrow(
      /no refresh token/i,
    );
  });
});

describe('googleConfiguration', () => {
  it('uses the fetch it is given', async () => {
    const { issuer } = await mockGoogle();
    let calls = 0;
    const counting: typeof fetch = (...args) => {
      calls += 1;
      return fetch(...args);
    };

    await googleConfiguration(APP, { googleIssuer: issuer, fetch: counting });

    expect(calls).toBe(1);
  });
});
