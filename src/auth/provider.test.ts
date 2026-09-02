import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appsFilePath } from './apps-file.js';
import { AppsFileIncompleteError, NotSignedInError } from './errors.js';
import { closeAll, mockGoogle } from './oauth-servers.mock.js';
import {
  createCredentialProvider,
  createFakeCredentialProvider,
  REFRESH_MARGIN_MS,
} from './provider.js';
import { createMemoryStore } from './store.js';
import type { Credential } from './types.js';

const EXPIRES_AT = 1_000_000_000;

function google(overrides: Partial<Credential> = {}): Credential {
  return {
    accessToken: 'ya29.old',
    refreshToken: '1//refresh',
    expiresAt: EXPIRES_AT,
    identity: { email: 'jiri@example.test' },
    ...overrides,
  };
}

let home: string;
const servers: Server[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docsync-provider-'));
});

afterEach(async () => {
  rmSync(home, { recursive: true, force: true });
  await closeAll(servers);
});

function writeApps(): void {
  mkdirSync(join(home, '.docsync'), { recursive: true });
  writeFileSync(appsFilePath(home), 'google:\n  client_id: "cid"\n  client_secret: "csec"\n');
}

/** Just enough Google to answer one refresh. */
async function refreshingGoogle() {
  const mock = await mockGoogle({
    clientId: 'cid',
    token: () => ({
      body: { access_token: 'ya29.renewed', expires_in: 3600, token_type: 'Bearer' },
    }),
  });
  servers.push(mock.server);
  return { issuer: mock.issuer, refreshes: mock.forms };
}

describe('createCredentialProvider', () => {
  it('fails with the command to run when nothing is stored', async () => {
    const provider = createCredentialProvider({ store: createMemoryStore() });

    await expect(provider.accessToken('notion')).rejects.toThrow(NotSignedInError);
    await expect(provider.identity('gdocs')).rejects.toThrow('docsync auth gdocs');
  });

  it('hands back a Notion token, which never expires', async () => {
    const store = createMemoryStore({
      notion: { accessToken: 'ntn_x', identity: { workspace: 'W' } },
    });
    const provider = createCredentialProvider({ store, now: () => Number.MAX_SAFE_INTEGER });

    expect(await provider.accessToken('notion')).toBe('ntn_x');
    expect(await provider.identity('notion')).toEqual({ workspace: 'W' });
  });

  it('does not refresh a token with more than a minute left', async () => {
    const { issuer, refreshes } = await refreshingGoogle();
    writeApps();
    const store = createMemoryStore({ gdocs: google() });

    const provider = createCredentialProvider({
      store,
      home,
      googleIssuer: issuer,
      now: () => EXPIRES_AT - REFRESH_MARGIN_MS - 1,
    });

    expect(await provider.accessToken('gdocs')).toBe('ya29.old');
    expect(refreshes).toHaveLength(0);
  });

  it('refreshes at the 60 s boundary and stores what came back', async () => {
    const { issuer, refreshes } = await refreshingGoogle();
    writeApps();
    const store = createMemoryStore({ gdocs: google() });
    const now = EXPIRES_AT - REFRESH_MARGIN_MS;

    const provider = createCredentialProvider({
      store,
      home,
      googleIssuer: issuer,
      now: () => now,
    });

    expect(await provider.accessToken('gdocs')).toBe('ya29.renewed');
    expect(refreshes[0]?.get('refresh_token')).toBe('1//refresh');
    expect(await store.read('gdocs')).toEqual({
      accessToken: 'ya29.renewed',
      refreshToken: '1//refresh',
      expiresAt: now + 3_600_000,
      identity: { email: 'jiri@example.test' },
    });
  });

  it('refreshes an already-expired token, and only once for two calls', async () => {
    const { issuer, refreshes } = await refreshingGoogle();
    writeApps();
    const store = createMemoryStore({ gdocs: google() });
    let clock = EXPIRES_AT + 1;

    const provider = createCredentialProvider({
      store,
      home,
      googleIssuer: issuer,
      now: () => clock,
    });

    expect(await provider.accessToken('gdocs')).toBe('ya29.renewed');
    clock += 1000;
    expect(await provider.identity('gdocs')).toEqual({ email: 'jiri@example.test' });
    expect(refreshes).toHaveLength(1);
  });

  it('says to sign in again when an expired token cannot be renewed', async () => {
    const store = createMemoryStore({
      gdocs: google({ refreshToken: undefined }),
    });
    const provider = createCredentialProvider({ store, home, now: () => EXPIRES_AT });

    const error = await provider.accessToken('gdocs').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotSignedInError);
    expect((error as Error).message).toContain('expired');
    expect((error as Error).message).toContain('docsync auth gdocs');
  });

  it('does not open an editor when the apps file went missing under it', async () => {
    const store = createMemoryStore({ gdocs: google() });
    const provider = createCredentialProvider({
      store,
      home,
      now: () => EXPIRES_AT,
      runEditor: () => {
        throw new Error('the editor must not be opened here');
      },
    });

    await expect(provider.accessToken('gdocs')).rejects.toThrow(AppsFileIncompleteError);
  });
});

describe('createFakeCredentialProvider', () => {
  it('answers from what it was seeded with', async () => {
    const provider = createFakeCredentialProvider({
      notion: { accessToken: 'ntn_x', identity: { workspace: 'W' } },
    });

    expect(await provider.accessToken('notion')).toBe('ntn_x');
    expect(await provider.identity('notion')).toEqual({ workspace: 'W' });
    await expect(provider.accessToken('gdocs')).rejects.toThrow(NotSignedInError);
  });

  it('can be signed in and out during a test', async () => {
    const provider = createFakeCredentialProvider();

    provider.set('gdocs', google());
    expect(await provider.accessToken('gdocs')).toBe('ya29.old');

    provider.forget('gdocs');
    await expect(provider.accessToken('gdocs')).rejects.toThrow('docsync auth gdocs');
  });

  it('ignores expiry, so a test never needs a clock', async () => {
    const provider = createFakeCredentialProvider({ gdocs: google({ expiresAt: 1 }) });

    expect(await provider.accessToken('gdocs')).toBe('ya29.old');
  });
});
