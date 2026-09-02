/**
 * Where tokens live: the OS keychain (macOS Keychain, Windows Credential
 * Manager, Secret Service on Linux) through `@napi-rs/keyring`, under service
 * `docsync` and account `<source>` (MANUAL §2). One entry per source, holding
 * the JSON of a `Credential`.
 *
 * Nothing here logs a value. A credential that cannot be understood is treated
 * as absent, so a stale or half-written entry turns into "run `docsync auth`"
 * rather than a crash on JSON that nobody can look at.
 */
import { AsyncEntry } from '@napi-rs/keyring';
import type { Source } from '../source-ref.js';
import { AuthError } from './errors.js';
import type { Credential, CredentialStore } from './types.js';

/** The keychain service every docsync entry sits under. */
export const KEYCHAIN_SERVICE = 'docsync';

/** The part of `@napi-rs/keyring`'s `AsyncEntry` this module uses. */
export interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type EntryFactory = (service: string, account: string) => KeyringEntry;

/** The real thing. Constructing an entry does not touch the OS store. */
export const defaultEntry: EntryFactory = (service, account) => new AsyncEntry(service, account);

function isCredential(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null) return false;
  const { accessToken, identity } = value as Record<string, unknown>;
  return typeof accessToken === 'string' && accessToken !== '' && typeof identity === 'object';
}

async function guard<T>(source: Source, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new AuthError(source, `Could not ${what} the OS keychain.`, { cause });
  }
}

/** A store over the OS keychain. */
export function createKeychainStore(entry: EntryFactory = defaultEntry): CredentialStore {
  const of = (source: Source) => entry(KEYCHAIN_SERVICE, source);
  return {
    async read(source) {
      const raw = await guard(source, 'read from', () => of(source).getPassword());
      if (raw === undefined || raw === null) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      return isCredential(parsed) ? parsed : undefined;
    },
    async write(source, credential) {
      await guard(source, 'write to', () => of(source).setPassword(JSON.stringify(credential)));
    },
    delete(source) {
      return guard(source, 'delete from', () => of(source).deleteCredential());
    },
  };
}

/**
 * A store in a `Map`. Exported because every test that is not about the
 * keychain wants one, and because `docsync auth` in a container without a
 * Secret Service is a plausible use for it later.
 */
export function createMemoryStore(seed: Partial<Record<Source, Credential>> = {}): CredentialStore {
  const entries = new Map<Source, Credential>(
    Object.entries(seed).map(([source, credential]) => [source as Source, credential]),
  );
  return {
    async read(source) {
      const found = entries.get(source);
      return found && structuredClone(found);
    },
    async write(source, credential) {
      entries.set(source, structuredClone(credential));
    },
    async delete(source) {
      return entries.delete(source);
    },
  };
}
