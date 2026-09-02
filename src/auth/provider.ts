/**
 * The one interface adapters use. An adapter asks for an access token and gets
 * a usable one, or an error that tells the user exactly which command to run;
 * it never learns that OAuth exists.
 */
import type { Source } from '../source-ref.js';
import { loadOAuthApp } from './apps-file.js';
import { NotSignedInError } from './errors.js';
import { googleConfiguration, refreshGoogleToken } from './google.js';
import { createKeychainStore } from './store.js';
import type { AuthDeps, Credential, CredentialProvider, Identity } from './types.js';

/**
 * Renew this long before the token actually expires, so that a request started
 * now still has a valid token when it reaches Google.
 */
export const REFRESH_MARGIN_MS = 60_000;

/** A provider over the OS keychain (or whatever store `deps` supplies). */
export function createCredentialProvider(deps: AuthDeps = {}): CredentialProvider {
  const store = deps.store ?? createKeychainStore();
  const now = deps.now ?? Date.now;

  async function current(source: Source): Promise<Credential> {
    const stored = await store.read(source);
    if (!stored) throw new NotSignedInError(source);
    // No expiry means a token that does not expire — every Notion token.
    if (stored.expiresAt === undefined) return stored;
    if (now() < stored.expiresAt - REFRESH_MARGIN_MS) return stored;
    if (!stored.refreshToken) {
      throw new NotSignedInError(source, 'The stored token has expired.');
    }

    // Only Google issues an expiry with a refresh token, so this is its path.
    // `prompt` is false: a token renewal happens in the middle of some other
    // command and must not stop to open an editor.
    const app = await loadOAuthApp(source, deps, false);
    const renewed = await refreshGoogleToken(await googleConfiguration(app, deps), stored, now);
    await store.write(source, renewed);
    return renewed;
  }

  return {
    async accessToken(source) {
      return (await current(source)).accessToken;
    },
    async identity(source) {
      return (await current(source)).identity;
    },
  };
}

/** A provider that has been seeded with tokens, for tests of everything else. */
export interface FakeCredentialProvider extends CredentialProvider {
  set(source: Source, credential: Credential): void;
  forget(source: Source): void;
}

/**
 * A provider backed by a `Map`. Handed out so that the source adapters, the
 * CLI and the remote helper can be tested without a keychain or a network:
 * seed it, pass it in, assert on what the adapter sent.
 */
export function createFakeCredentialProvider(
  seed: Partial<Record<Source, Credential>> = {},
): FakeCredentialProvider {
  const credentials = new Map<Source, Credential>(
    Object.entries(seed).map(([source, credential]) => [source as Source, credential]),
  );
  const of = (source: Source): Credential => {
    const found = credentials.get(source);
    if (!found) throw new NotSignedInError(source);
    return found;
  };
  return {
    // Expiry is ignored on purpose: a fake that renews tokens would need a
    // Google to renew them against, which is the thing being faked away.
    async accessToken(source) {
      return of(source).accessToken;
    },
    async identity(source) {
      return of(source).identity;
    },
    set(source, credential) {
      credentials.set(source, credential);
    },
    forget(source) {
      credentials.delete(source);
    },
  };
}

export type { CredentialProvider, Identity };
