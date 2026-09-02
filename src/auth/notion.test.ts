import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { exchangeNotionCode, NOTION_ENDPOINTS, notionAuthorizationUrl } from './notion.js';
import { closeAll, mockNotion, type Reply } from './oauth-servers.mock.js';

const APP = { clientId: '0f3a4b5c-1111-2222-3333-444455556666', clientSecret: 'secret_ABC-123' };
const REDIRECT = 'http://localhost:27183/callback';

const servers: Server[] = [];

afterEach(() => closeAll(servers));

async function notion(reply?: Reply) {
  const mock = await mockNotion(reply);
  servers.push(mock.server);
  return mock;
}

function exchange(endpoint: string, extra: { fetchImpl?: typeof fetch } = {}) {
  return exchangeNotionCode({
    app: APP,
    code: 'THE-CODE',
    redirectUri: REDIRECT,
    endpoint,
    ...extra,
  });
}

describe('notionAuthorizationUrl', () => {
  it('asks for a code, owned by a user', () => {
    const url = new URL(
      notionAuthorizationUrl({ clientId: APP.clientId, redirectUri: REDIRECT, state: 'st' }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(NOTION_ENDPOINTS.authorization);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.clientId,
      response_type: 'code',
      owner: 'user',
      redirect_uri: REDIRECT,
      state: 'st',
    });
  });
});

describe('exchangeNotionCode', () => {
  it('posts JSON with HTTP Basic auth and keeps the identity', async () => {
    const { seen, endpoints } = await notion();

    const credential = await exchange(endpoints.token);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.contentType).toContain('application/json');
    // Plain base64 of client_id:client_secret — no form encoding of either half.
    expect(seen[0]?.authorization).toBe(
      `Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString('base64')}`,
    );
    expect(seen[0]?.body).toEqual({
      grant_type: 'authorization_code',
      code: 'THE-CODE',
      redirect_uri: REDIRECT,
    });

    expect(credential).toEqual({
      accessToken: 'ntn_the-token',
      identity: { name: 'Jiri', email: 'jiri@example.test', workspace: "Jiri's Workspace" },
    });
    // Notion tokens do not expire and there is nothing to refresh with.
    expect(credential.expiresAt).toBeUndefined();
    expect(credential.refreshToken).toBeUndefined();
  });

  it('copes with a workspace owner, which names no user at all', async () => {
    const { endpoints } = await notion({
      body: {
        access_token: 'ntn_bot',
        token_type: 'bearer',
        workspace_name: 'Team',
        owner: { type: 'workspace', workspace: true },
      },
    });

    expect(await exchange(endpoints.token)).toEqual({
      accessToken: 'ntn_bot',
      identity: { workspace: 'Team' },
    });
  });

  it('reports the error Notion sent, without the secret', async () => {
    const { endpoints } = await notion({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid code.' },
    });

    const error = await exchange(endpoints.token).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('invalid_grant');
    expect((error as AuthError).message).toContain('Invalid code.');
    expect((error as AuthError).message).not.toContain(APP.clientSecret);
  });

  it('reports a non-JSON failure by status', async () => {
    const { endpoints } = await notion({ status: 502, body: null, text: '<html>nope</html>' });

    await expect(exchange(endpoints.token)).rejects.toThrow(/502/);
  });

  it('rejects a 200 that carries no access token', async () => {
    const { endpoints } = await notion({ body: { token_type: 'bearer' } });

    await expect(exchange(endpoints.token)).rejects.toThrow(/access token/i);
  });

  it('uses the injected fetch', async () => {
    const { endpoints } = await notion();
    let called = 0;
    const counting: typeof fetch = (...args) => {
      called += 1;
      return fetch(...args);
    };

    await exchange(endpoints.token, { fetchImpl: counting });

    expect(called).toBe(1);
  });
});
