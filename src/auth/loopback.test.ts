import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from './errors.js';
import { defaultOpenBrowser, openerCommand, receiveCallback } from './loopback.js';

const blockers: Server[] = [];

afterEach(async () => {
  await Promise.all(blockers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function block(port: number): Promise<void> {
  const server = createServer();
  blockers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

/** A browser that immediately follows the URL it was handed. */
function browser(query: (state: string) => string) {
  return async (url: string) => {
    const parsed = new URL(url);
    const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '');
    const state = parsed.searchParams.get('state') ?? '';
    const response = await fetch(`${redirect.origin}${redirect.pathname}?${query(state)}`);
    return { status: response.status, body: await response.text() };
  };
}

const PORTS = [27183, 27184];

function run(options: Partial<Parameters<typeof receiveCallback>[0]> = {}) {
  return receiveCallback({
    source: 'notion',
    ports: PORTS,
    state: 'the-state',
    authorizationUrl: (redirectUri, state) =>
      `https://example.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    openBrowser: () => undefined,
    log: () => undefined,
    ...options,
  });
}

describe('receiveCallback', () => {
  it('uses the first port and returns the code', async () => {
    let seen: { status: number; body: string } | undefined;
    const open = browser((state) => `code=THE-CODE&state=${state}`);

    const result = await run({ openBrowser: (url) => void open(url).then((r) => (seen = r)) });

    expect(result).toMatchObject({
      code: 'THE-CODE',
      redirectUri: 'http://localhost:27183/callback',
      port: 27183,
    });
    await vi.waitFor(() => expect(seen?.status).toBe(200));
    expect(seen?.body).toContain('close this tab');
  });

  it('hands back the callback URL with every parameter intact', async () => {
    const open = browser(
      (state) => `code=c3&state=${state}&iss=https%3A%2F%2Faccounts.google.com&scope=email`,
    );

    const result = await run({ openBrowser: (url) => void open(url) });

    const url = new URL(result.callbackUrl);
    expect(url.origin + url.pathname).toBe(result.redirectUri);
    expect(url.searchParams.get('code')).toBe('c3');
    expect(url.searchParams.get('iss')).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('email');
  });

  it('falls back to the second port when the first is busy', async () => {
    await block(27183);
    const open = browser((state) => `code=c2&state=${state}`);

    const result = await run({ openBrowser: (url) => void open(url) });

    expect(result.port).toBe(27184);
    expect(result.redirectUri).toBe('http://localhost:27184/callback');
  });

  it('says which ports are busy when none is free', async () => {
    await block(27183);
    await block(27184);

    const error = await run().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toContain('27183');
    expect((error as AuthError).message).toContain('27184');
  });

  it('always prints the authorization URL, browser or no browser', async () => {
    const lines: string[] = [];
    const open = browser((state) => `code=c&state=${state}`);

    await run({
      log: (line) => lines.push(line),
      openBrowser: (url) => void open(url),
    });

    expect(lines.join('\n')).toContain('https://example.test/authorize');
  });

  it('still works when the browser cannot be opened', async () => {
    const open = browser((state) => `code=c&state=${state}`);

    const result = await run({
      openBrowser: (url) => {
        void open(url);
        throw new Error('no browser here');
      },
    });

    expect(result.code).toBe('c');
  });

  it('rejects a callback whose state does not match', async () => {
    let seen: { status: number; body: string } | undefined;
    const open = browser(() => 'code=c&state=someone-elses-state');

    const error = await run({
      openBrowser: (url) => void open(url).then((r) => (seen = r)),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/state/i);
    await vi.waitFor(() => expect(seen?.status).toBe(400));
  });

  it('reports the error the authorization server sent back', async () => {
    const open = browser((state) => `error=access_denied&state=${state}`);

    const error = await run({ openBrowser: (url) => void open(url) }).catch((e: unknown) => e);

    expect((error as AuthError).message).toContain('access_denied');
  });

  it('reports a callback with neither a code nor an error', async () => {
    const open = browser((state) => `state=${state}`);

    const error = await run({ openBrowser: (url) => void open(url) }).catch((e: unknown) => e);

    expect((error as AuthError).message).toMatch(/no authorization code/i);
  });

  it('ignores requests to other paths and keeps waiting', async () => {
    const open = async (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
      const stray = await fetch(`${redirect.origin}/favicon.ico`);
      expect(stray.status).toBe(404);
      await stray.text();
      await fetch(`${redirect.origin}${redirect.pathname}?code=late&state=the-state`).then((r) =>
        r.text(),
      );
    };

    expect((await run({ openBrowser: (url) => void open(url) })).code).toBe('late');
  });

  it('gives up after the timeout', async () => {
    const error = await run({ timeoutMs: 20 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).message).toMatch(/timed out|5 minutes|did not/i);
    // The port is free again, so a second attempt can bind it.
    await block(27183);
  });
});

describe('openerCommand', () => {
  it('is the platform opener', () => {
    expect(openerCommand('darwin')).toEqual({ command: 'open', args: [] });
    expect(openerCommand('linux')).toEqual({ command: 'xdg-open', args: [] });
    expect(openerCommand('win32')).toEqual({ command: 'cmd', args: ['/c', 'start', ''] });
  });
});

describe('defaultOpenBrowser', () => {
  it('does not throw when the opener is missing', () => {
    expect(() =>
      defaultOpenBrowser('https://example.test/', 'docsync-no-such-opener'),
    ).not.toThrow();
  });
});
