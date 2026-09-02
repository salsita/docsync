/**
 * The loopback half of an authorization code flow: bind a port on 127.0.0.1,
 * send the user to the authorization server, take exactly one callback, and
 * shut down.
 *
 * The ports are fixed at 27183 and 27184 rather than ephemeral because Notion
 * matches redirect URIs exactly and both are registered up front (MANUAL §2).
 * The redirect URI says `localhost` while the socket binds `127.0.0.1`: the
 * former is what is registered with the vendors and what the browser resolves,
 * the latter is what makes the listener unreachable from the network. On a
 * machine where `localhost` also resolves to `::1` the browser may try that
 * first and fall back, which costs a retry and nothing else.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Source } from '../source-ref.js';
import { AuthError } from './errors.js';

/** The two ports, in the order they are tried (MANUAL §2). */
export const LOOPBACK_PORTS = [27183, 27184];

/** Five minutes: long enough to find a password, short enough to not hang a terminal. */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface CallbackRequest {
  source: Source;
  /** Ports to try in order. */
  ports?: number[];
  /** The `state` this flow sent, and the only one the callback may carry back. */
  state: string;
  /** Built once the port is known, since it has to embed the redirect URI. */
  authorizationUrl: (redirectUri: string, state: string) => string;
  openBrowser?: (url: string) => void;
  log?: (line: string) => void;
  timeoutMs?: number;
}

export interface CallbackResult {
  code: string;
  /** The exact redirect URI the authorization server saw; the token exchange repeats it. */
  redirectUri: string;
  port: number;
}

/** How to spell "open this URL in the user's browser" on each platform. */
export function openerCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [] };
  // `start` is a cmd builtin; the empty string is the window title argument,
  // which `start` otherwise takes the URL for.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

/**
 * Hand the URL to the platform opener. Failures are swallowed on purpose: the
 * URL has already been printed, and a headless machine is a perfectly good
 * place to run this as long as the user can copy the line.
 */
export function defaultOpenBrowser(url: string, override?: string): void {
  const { command, args } = openerCommand(process.platform);
  const child = spawn(override ?? command, [...args, url], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => undefined);
  child.unref();
}

function page(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>docsync</title></head><body style="font:16px system-ui;padding:3rem">
<h1>${title}</h1><p>${detail}</p></body></html>`;
}

const OK_PAGE = page(
  'Signed in to docsync.',
  'You can close this tab and go back to the terminal.',
);

async function listen(ports: number[], source: Source) {
  const server = createServer();
  const refused: string[] = [];
  for (const port of ports) {
    // Any failure to bind is the same answer — try the next port — so that a
    // machine with an unusual reason (a firewall, a privileged port) still
    // gets the second chance, and the reason still reaches the user below.
    const failure = await new Promise<string | undefined>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(undefined);
      });
    });
    if (failure === undefined) return { server, port };
    refused.push(`${port} (${failure})`);
  }
  server.close();
  throw new AuthError(
    source,
    `Could not listen for the OAuth callback on ${refused.join(' or ')}. ` +
      'Close whatever is using those ports and run the command again.',
  );
}

/**
 * Run the browser half of the flow and answer the authorization code. Resolves
 * once, on the first callback to `/callback`; anything else gets a 404 and the
 * wait continues, because browsers ask for `/favicon.ico` unprompted.
 */
export async function receiveCallback(request: CallbackRequest): Promise<CallbackResult> {
  const {
    source,
    state,
    authorizationUrl,
    ports = LOOPBACK_PORTS,
    log = console.log,
    openBrowser = defaultOpenBrowser,
    timeoutMs = CALLBACK_TIMEOUT_MS,
  } = request;

  const { server, port } = await listen(ports, source);
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    return await new Promise<CallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AuthError(source, 'Timed out waiting for the browser to come back.'));
      }, timeoutMs);
      timer.unref();

      const done = (outcome: () => void) => {
        clearTimeout(timer);
        outcome();
      };

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback') {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not here.\n');
          return;
        }

        const fail = (message: string, detail: string) => {
          res
            .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
            .end(page('Sign-in failed.', detail));
          done(() => reject(new AuthError(source, message)));
        };

        if (url.searchParams.get('state') !== state) {
          return fail(
            'The OAuth callback carried the wrong state. Sign-in was abandoned.',
            'The callback did not belong to this sign-in. Nothing was stored.',
          );
        }
        const error = url.searchParams.get('error');
        if (error) {
          const description = url.searchParams.get('error_description');
          return fail(
            `Authorization was refused: ${error}${description ? ` (${description})` : ''}.`,
            'You can close this tab and try again.',
          );
        }
        const code = url.searchParams.get('code');
        if (!code) {
          return fail(
            'The OAuth callback carried no authorization code.',
            'You can close this tab and try again.',
          );
        }

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(OK_PAGE);
        done(() => resolve({ code, redirectUri, port }));
      });

      const url = authorizationUrl(redirectUri, state);
      log(`Opening your browser to sign in. If it does not open, visit:\n\n  ${url}\n`);
      try {
        openBrowser(url);
      } catch {
        // Printed above; a browser that will not start is not a failure.
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
