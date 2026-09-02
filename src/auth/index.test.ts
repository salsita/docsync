import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppsFileIncompleteError,
  appsFilePath,
  createCredentialProvider,
  grantHint,
  NotSignedInError,
  signIn,
  signOut,
  whoAmI,
} from './index.js';
import { closeAll, mockGoogle, mockNotion } from './oauth-servers.mock.js';
import { createMemoryStore } from './store.js';

const GOOGLE_CLIENT_ID = '1234.apps.googleusercontent.com';
// Not 27183/27184: `loopback.test.ts` uses those, and vitest runs files in
// parallel.
const PORTS = [27190, 27191];

let home: string;
const servers: Server[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docsync-auth-'));
  mkdirSync(join(home, '.docsync'), { recursive: true });
  writeFileSync(
    appsFilePath(home),
    `google:\n  client_id: "${GOOGLE_CLIENT_ID}"\n  client_secret: "GOCSPX-abc"\n` +
      'notion:\n  client_id: "0f3a4b5c-1111-2222-3333-444455556666"\n' +
      '  client_secret: "secret_ABC-123"\n',
  );
});

afterEach(async () => {
  rmSync(home, { recursive: true, force: true });
  await closeAll(servers);
});

/**
 * A browser that follows the authorization URL straight back to the loopback
 * server, which is the whole of what a real one does for these tests.
 */
function browser(query: (state: string) => string) {
  return (url: string) => {
    const parsed = new URL(url);
    const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '');
    const state = parsed.searchParams.get('state') ?? '';
    void fetch(`${redirect.origin}${redirect.pathname}?${query(state)}`).then((r) => r.text());
  };
}

const withCode = (code: string) => browser((state) => `code=${code}&state=${state}`);

function base() {
  return { home, ports: PORTS, log: () => undefined, store: createMemoryStore() };
}

describe('signIn to Notion', () => {
  it('runs the whole flow and stores the token', async () => {
    const { server, endpoints, seen } = await mockNotion();
    servers.push(server);
    const deps = { ...base(), notionEndpoints: endpoints, openBrowser: withCode('NOTION-CODE') };

    const identity = await signIn('notion', deps);

    expect(identity).toEqual({
      name: 'Jiri',
      email: 'jiri@example.test',
      workspace: "Jiri's Workspace",
    });
    expect(seen[0]?.body).toMatchObject({ code: 'NOTION-CODE' });
    expect(await deps.store.read('notion')).toEqual({
      accessToken: 'ntn_the-token',
      identity,
    });
  });

  it('says what to grant before opening the browser', async () => {
    const { server, endpoints } = await mockNotion();
    servers.push(server);
    const lines: string[] = [];
    let browserOpened = false;

    await signIn('notion', {
      ...base(),
      notionEndpoints: endpoints,
      log: (line) => {
        expect(browserOpened).toBe(false);
        lines.push(line);
      },
      openBrowser: (url) => {
        browserOpened = true;
        withCode('c')(url);
      },
    });

    expect(lines[0]).toContain('teamspaces');
    expect(grantHint('gdocs')).toContain('Drive and Docs');
  });

  it('sends the browser to Notion with owner=user', async () => {
    const { server, endpoints } = await mockNotion();
    servers.push(server);
    let authorizationUrl = '';

    await signIn('notion', {
      ...base(),
      notionEndpoints: endpoints,
      openBrowser: (url) => {
        authorizationUrl = url;
        withCode('c')(url);
      },
    });

    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('owner')).toBe('user');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:${PORTS[0]}/callback`);
  });

  it('fails before opening a browser when the app is not filled in', async () => {
    rmSync(appsFilePath(home));

    await expect(
      signIn('notion', {
        ...base(),
        runEditor: () => undefined,
        openBrowser: () => {
          throw new Error('the browser must not be opened');
        },
      }),
    ).rejects.toThrow(AppsFileIncompleteError);
  });
});

describe('signIn to Google', () => {
  it('runs the whole flow, with PKCE, and stores the token', async () => {
    const google = await mockGoogle({ clientId: GOOGLE_CLIENT_ID });
    servers.push(google.server);
    let authorizationUrl = '';
    const deps = {
      ...base(),
      googleIssuer: google.issuer,
      now: () => 1_000,
      openBrowser: (url: string) => {
        authorizationUrl = url;
        withCode('GOOGLE-CODE')(url);
      },
    };

    const identity = await signIn('gdocs', deps);

    expect(identity).toEqual({ name: 'Jiri', email: 'jiri@example.test' });
    expect(await deps.store.read('gdocs')).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAt: 1_000 + 3599 * 1000,
      identity,
    });

    // The verifier that was posted matches the challenge that was advertised.
    const challenge = new URL(authorizationUrl).searchParams.get('code_challenge');
    const verifier = google.forms[0]?.get('code_verifier');
    expect(verifier).toBeTruthy();
    expect(challenge).toBeTruthy();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier ?? ''));
    expect(Buffer.from(digest).toString('base64url')).toBe(challenge);
  });

  it('refuses a callback that carries someone else’s state', async () => {
    const google = await mockGoogle({ clientId: GOOGLE_CLIENT_ID });
    servers.push(google.server);
    const deps = {
      ...base(),
      googleIssuer: google.issuer,
      openBrowser: browser(() => 'code=c&state=not-the-state'),
    };

    await expect(signIn('gdocs', deps)).rejects.toThrow(/state/i);
    expect(await deps.store.read('gdocs')).toBeUndefined();
  });
});

describe('whoAmI and signOut', () => {
  it('reads back what signIn stored, and forgets it again', async () => {
    const { server, endpoints } = await mockNotion();
    servers.push(server);
    const deps = { ...base(), notionEndpoints: endpoints, openBrowser: withCode('c') };

    await signIn('notion', deps);

    expect(await whoAmI('notion', deps)).toEqual({
      name: 'Jiri',
      email: 'jiri@example.test',
      workspace: "Jiri's Workspace",
    });
    expect(await signOut('notion', deps)).toBe(true);
    expect(await signOut('notion', deps)).toBe(false);
    await expect(whoAmI('notion', deps)).rejects.toThrow(NotSignedInError);
  });

  it('gives an adapter a token through the provider alone', async () => {
    const { server, endpoints } = await mockNotion();
    servers.push(server);
    const deps = { ...base(), notionEndpoints: endpoints, openBrowser: withCode('c') };
    await signIn('notion', deps);

    const provider = createCredentialProvider(deps);

    expect(await provider.accessToken('notion')).toBe('ntn_the-token');
  });
});
