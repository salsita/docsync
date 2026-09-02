/**
 * `docsync auth <source>`, as three functions and one interface.
 *
 * Everything a command needs is here: `signIn` runs the browser flow and puts
 * the result in the keychain, `signOut` takes it out, `whoAmI` reads it back,
 * and `createCredentialProvider` is what every other part of docsync uses to
 * get a token without knowing any of this happened. Ticket 10 wires the CLI
 * over the top.
 *
 * Every one of them takes an optional `deps` bag (`AuthDeps`) holding the
 * keychain, the editor, the browser, the clock and `fetch`, so that the whole
 * module can be driven in a test without touching any of them.
 */
import { calculatePKCECodeChallenge, randomPKCECodeVerifier, randomState } from 'openid-client';
import type { Source } from '../source-ref.js';
import { loadOAuthApp } from './apps-file.js';
import { exchangeGoogleCode, googleAuthorizationUrl, googleConfiguration } from './google.js';
import { receiveCallback } from './loopback.js';
import { exchangeNotionCode, notionAuthorizationUrl } from './notion.js';
import { createCredentialProvider } from './provider.js';
import { createKeychainStore } from './store.js';
import type { AuthDeps, Credential, Identity } from './types.js';

/**
 * What to grant, said in the terminal before the browser opens. Most people
 * never read the vendor's consent screen carefully; this is the one line that
 * tells them what docsync needs (MANUAL §2).
 */
export function grantHint(source: Source): string {
  if (source === 'notion') {
    return [
      'Notion will ask which pages docsync may access. Grant the teamspaces you',
      'work in: everything under a granted page is included. You can change the',
      'selection later under Notion Settings → Connections.',
    ].join('\n');
  }
  return 'Google will ask for access to Drive and Docs. Approve both; docsync needs them to read and update your documents.';
}

async function signInToNotion(source: Source, deps: AuthDeps): Promise<Credential> {
  const app = await loadOAuthApp(source, deps);
  (deps.log ?? console.log)(`${grantHint(source)}\n`);
  const state = randomState();
  const { code, redirectUri } = await receiveCallback({
    source,
    state,
    ports: deps.ports,
    timeoutMs: deps.timeoutMs,
    log: deps.log,
    openBrowser: deps.openBrowser,
    authorizationUrl: (uri, state) =>
      notionAuthorizationUrl({
        clientId: app.clientId,
        redirectUri: uri,
        state,
        endpoint: deps.notionEndpoints?.authorization,
      }),
  });
  return exchangeNotionCode({
    app,
    code,
    redirectUri,
    endpoint: deps.notionEndpoints?.token,
    fetchImpl: deps.fetch,
  });
}

async function signInToGoogle(source: Source, deps: AuthDeps): Promise<Credential> {
  const app = await loadOAuthApp(source, deps);
  const config = await googleConfiguration(app, deps);
  (deps.log ?? console.log)(`${grantHint(source)}\n`);
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = randomState();

  const { callbackUrl, redirectUri } = await receiveCallback({
    source,
    state,
    ports: deps.ports,
    timeoutMs: deps.timeoutMs,
    log: deps.log,
    openBrowser: deps.openBrowser,
    authorizationUrl: (uri, state) =>
      googleAuthorizationUrl(config, { redirectUri: uri, state, codeChallenge }),
  });

  return exchangeGoogleCode(config, {
    state,
    callbackUrl,
    redirectUri,
    codeVerifier,
    now: deps.now,
  });
}

/**
 * Run the whole sign-in for one source and store the result: read the OAuth
 * app (asking the user to fill it in if need be), take a callback on the
 * loopback port, exchange the code, write the token to the keychain. Answers
 * the identity to print as "signed in as".
 */
export async function signIn(source: Source, deps: AuthDeps = {}): Promise<Identity> {
  const credential =
    source === 'notion' ? await signInToNotion(source, deps) : await signInToGoogle(source, deps);
  await (deps.store ?? createKeychainStore()).write(source, credential);
  return credential.identity;
}

/** Remove the stored token. `false` when there was nothing to remove. */
export async function signOut(source: Source, deps: AuthDeps = {}): Promise<boolean> {
  return (deps.store ?? createKeychainStore()).delete(source);
}

/**
 * Who the stored token belongs to, renewing it first if it is nearly expired —
 * which is what makes this a check that the credential still works, and not
 * just a read. Fails with `NotSignedInError` when there is nothing stored.
 */
export async function whoAmI(source: Source, deps: AuthDeps = {}): Promise<Identity> {
  return createCredentialProvider(deps).identity(source);
}

export { appsFilePath } from './apps-file.js';
export { AppsFileIncompleteError, AuthError, NotSignedInError } from './errors.js';
export {
  createCredentialProvider,
  createFakeCredentialProvider,
  type FakeCredentialProvider,
  REFRESH_MARGIN_MS,
} from './provider.js';
export type {
  AuthDeps,
  Credential,
  CredentialProvider,
  CredentialStore,
  Identity,
} from './types.js';
