/**
 * Google- and Notion-shaped OAuth servers on loopback, for the tests in this
 * directory. Not part of the shipped surface — nothing under `src/` imports it
 * outside a test — but it is a `.ts` module rather than a `.test.ts` one so
 * that three test files can share it. `vitest.config.ts` keeps `*.mock.ts` out
 * of the coverage report for the same reason it keeps `*.test.ts` out.
 *
 * The Google mock signs its ID tokens with a real RSA key and serves a real
 * JWKS, so `openid-client`'s signature and claim checks run for real.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'docsync-test-key';

/** The public half of the signing key, as the mock's `jwks_uri` serves it. */
export const SIGNING_JWK = {
  ...publicKey.export({ format: 'jwk' }),
  kid: KID,
  use: 'sig',
  alg: 'RS256',
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** A signed RS256 ID token. `claims` overrides or adds to the standard ones. */
export function idToken(
  issuer: string,
  audience: string,
  claims: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: '1029384756',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  return `${header}.${payload}.${base64url(sign('sha256', Buffer.from(`${header}.${payload}`), privateKey))}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

async function loopback(handler: Parameters<typeof createServer>[1]): Promise<{
  server: Server;
  origin: string;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
  };
}

/** Closes every server a test opened. Call from `afterEach`. */
export function closeAll(servers: Server[]): Promise<unknown[]> {
  return Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
}

export interface Reply {
  status?: number;
  body: unknown;
  /** Raw body, for answering with something that is not JSON at all. */
  text?: string;
}

export interface GoogleMockOptions {
  clientId: string;
  /** What the token endpoint answers, given the form it received. */
  token?: (form: URLSearchParams, issuer: string) => Reply;
  userinfo?: Reply;
}

export interface GoogleMock {
  server: Server;
  issuer: string;
  /** Every form body the token endpoint received, in order. */
  forms: URLSearchParams[];
}

/** An OpenID provider shaped like `accounts.google.com`. */
export async function mockGoogle(options: GoogleMockOptions): Promise<GoogleMock> {
  const forms: URLSearchParams[] = [];
  let issuer = '';

  const { server, origin } = await loopback((req, res) => {
    void (async () => {
      const json = ({ status = 200, body }: Reply) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const path = new URL(req.url ?? '/', issuer).pathname;

      if (path === '/.well-known/openid-configuration') {
        return json({
          body: {
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
          },
        });
      }
      if (path === '/certs') return json({ body: { keys: [SIGNING_JWK] } });
      if (path === '/v1/userinfo') {
        return json(options.userinfo ?? { body: { sub: '1029384756' } });
      }
      if (path === '/token') {
        const form = new URLSearchParams(await readBody(req));
        forms.push(form);
        return json(
          options.token?.(form, issuer) ?? {
            body: {
              access_token: 'ya29.access',
              refresh_token: '1//refresh',
              expires_in: 3599,
              token_type: 'Bearer',
              id_token: idToken(issuer, options.clientId, {
                email: 'jiri@example.test',
                name: 'Jiri',
              }),
            },
          },
        );
      }
      return json({ status: 404, body: { error: 'not_found' } });
    })();
  });

  issuer = origin;
  return { server, issuer, forms };
}

export interface NotionSeen {
  method: string;
  authorization?: string;
  contentType?: string;
  body: unknown;
}

export interface NotionMock {
  server: Server;
  endpoints: { authorization: string; token: string };
  seen: NotionSeen[];
}

/** Notion's `/v1/oauth/token`, which takes JSON and HTTP Basic. */
export async function mockNotion(reply?: Reply): Promise<NotionMock> {
  const seen: NotionSeen[] = [];
  const { server, origin } = await loopback((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      seen.push({
        method: req.method ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      const { status = 200, body } = reply ?? {
        body: {
          access_token: 'ntn_the-token',
          token_type: 'bearer',
          bot_id: '7bfb2e9f-1d3c-4f1a-9f5c-2b3d4e5f6a7b',
          workspace_name: "Jiri's Workspace",
          owner: {
            type: 'user',
            user: { object: 'user', name: 'Jiri', person: { email: 'jiri@example.test' } },
          },
        },
      };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(reply?.text ?? JSON.stringify(body));
    })();
  });

  return {
    server,
    seen,
    endpoints: {
      authorization: `${origin}/v1/oauth/authorize`,
      token: `${origin}/v1/oauth/token`,
    },
  };
}
