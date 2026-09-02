import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import { exchangeNotionCode, NOTION_ENDPOINTS, notionAuthorizationUrl } from './notion.js';

const APP = { clientId: '0f3a4b5c-1111-2222-3333-444455556666', clientSecret: 'secret_ABC-123' };

/** What Notion actually sends back, extra fields and all. */
const TOKEN_RESPONSE = {
  access_token: 'ntn_the-token',
  token_type: 'bearer',
  bot_id: '7bfb2e9f-1d3c-4f1a-9f5c-2b3d4e5f6a7b',
  workspace_id: '11111111-2222-3333-4444-555555555555',
  workspace_name: "Jiri's Workspace",
  workspace_icon: 'https://example.test/icon.png',
  duplicated_template_id: null,
  request_id: 'e6d1f0f4',
  owner: {
    type: 'user',
    user: {
      object: 'user',
      id: '9a8b7c6d-0000-1111-2222-333344445555',
      name: 'Jiri Stanisevsky',
      avatar_url: null,
      type: 'person',
      person: { email: 'jiri@example.test' },
    },
  },
};

interface Seen {
  method: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function mockNotion(reply: { status: number; body: unknown; text?: string }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({
        method: req.method ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.text ?? JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { seen, token: `http://127.0.0.1:${port}/v1/oauth/token` };
}

describe('notionAuthorizationUrl', () => {
  it('asks for a code, owned by a user', () => {
    const url = new URL(
      notionAuthorizationUrl({
        clientId: APP.clientId,
        redirectUri: 'http://localhost:27183/callback',
        state: 'st',
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(NOTION_ENDPOINTS.authorization);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.clientId,
      response_type: 'code',
      owner: 'user',
      redirect_uri: 'http://localhost:27183/callback',
      state: 'st',
    });
  });
});

describe('exchangeNotionCode', () => {
  it('posts JSON with HTTP Basic auth and keeps the identity', async () => {
    const { seen, token } = await mockNotion({ status: 200, body: TOKEN_RESPONSE });

    const credential = await exchangeNotionCode({
      app: APP,
      code: 'THE-CODE',
      redirectUri: 'http://localhost:27183/callback',
      endpoint: token,
    });

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
      redirect_uri: 'http://localhost:27183/callback',
    });

    expect(credential).toEqual({
      accessToken: 'ntn_the-token',
      identity: {
        name: 'Jiri Stanisevsky',
        email: 'jiri@example.test',
        workspace: "Jiri's Workspace",
      },
    });
    // Notion tokens do not expire and there is nothing to refresh with.
    expect(credential.expiresAt).toBeUndefined();
    expect(credential.refreshToken).toBeUndefined();
  });

  it('copes with a bot owner, which has no user at all', async () => {
    const { token } = await mockNotion({
      status: 200,
      body: {
        access_token: 'ntn_bot',
        token_type: 'bearer',
        workspace_name: 'Team',
        owner: { type: 'workspace', workspace: true },
      },
    });

    expect(
      await exchangeNotionCode({
        app: APP,
        code: 'c',
        redirectUri: 'http://localhost:27183/callback',
        endpoint: token,
      }),
    ).toEqual({ accessToken: 'ntn_bot', identity: { workspace: 'Team' } });
  });

  it('reports the error Notion sent, without the secret', async () => {
    const { token } = await mockNotion({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Invalid code.' },
    });

    const error = await exchangeNotionCode({
      app: APP,
      code: 'c',
      redirectUri: 'http://localhost:27183/callback',
      endpoint: token,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('invalid_grant');
    expect((error as AuthError).message).toContain('Invalid code.');
    expect((error as AuthError).message).not.toContain(APP.clientSecret);
  });

  it('reports a non-JSON failure by status', async () => {
    const { token } = await mockNotion({ status: 502, body: null, text: '<html>nope</html>' });

    await expect(
      exchangeNotionCode({
        app: APP,
        code: 'c',
        redirectUri: 'http://localhost:27183/callback',
        endpoint: token,
      }),
    ).rejects.toThrow(/502/);
  });

  it('rejects a 200 that carries no access token', async () => {
    const { token } = await mockNotion({ status: 200, body: { token_type: 'bearer' } });

    await expect(
      exchangeNotionCode({
        app: APP,
        code: 'c',
        redirectUri: 'http://localhost:27183/callback',
        endpoint: token,
      }),
    ).rejects.toThrow(/access token/i);
  });

  it('uses the injected fetch', async () => {
    const { token } = await mockNotion({ status: 200, body: TOKEN_RESPONSE });
    let called = 0;
    const counting: typeof fetch = (...args) => {
      called += 1;
      return fetch(...args);
    };

    await exchangeNotionCode({
      app: APP,
      code: 'c',
      redirectUri: 'http://localhost:27183/callback',
      endpoint: token,
      fetchImpl: counting,
    });

    expect(called).toBe(1);
  });
});
