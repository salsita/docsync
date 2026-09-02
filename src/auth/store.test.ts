import { describe, expect, it } from 'vitest';
import { AuthError } from './errors.js';
import {
  createKeychainStore,
  createMemoryStore,
  defaultEntry,
  KEYCHAIN_SERVICE,
  type KeyringEntry,
} from './store.js';
import type { Credential } from './types.js';

const token: Credential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: 1_700_000_000_000,
  identity: { email: 'j@example.com' },
};

/** An `AsyncEntry` that keeps its password in a map instead of the OS. */
function fakeKeyring() {
  const entries = new Map<string, string>();
  const factory = (service: string, account: string): KeyringEntry => ({
    async getPassword() {
      return entries.get(`${service}/${account}`);
    },
    async setPassword(password) {
      entries.set(`${service}/${account}`, password);
    },
    async deleteCredential() {
      return entries.delete(`${service}/${account}`);
    },
  });
  return { entries, factory };
}

describe('createKeychainStore', () => {
  it('round-trips a credential under service docsync and account <source>', async () => {
    const { entries, factory } = fakeKeyring();
    const store = createKeychainStore(factory);

    await store.write('gdocs', token);

    expect([...entries.keys()]).toEqual(['docsync/gdocs']);
    expect(JSON.parse(entries.get('docsync/gdocs') ?? '')).toEqual(token);
    expect(await store.read('gdocs')).toEqual(token);
  });

  it('keeps the two sources apart', async () => {
    const store = createKeychainStore(fakeKeyring().factory);

    await store.write('notion', { accessToken: 'n', identity: { workspace: 'W' } });

    expect(await store.read('notion')).toEqual({
      accessToken: 'n',
      identity: { workspace: 'W' },
    });
    expect(await store.read('gdocs')).toBeUndefined();
  });

  it('deletes, and says whether there was anything to delete', async () => {
    const store = createKeychainStore(fakeKeyring().factory);
    await store.write('notion', token);

    expect(await store.delete('notion')).toBe(true);
    expect(await store.delete('notion')).toBe(false);
    expect(await store.read('notion')).toBeUndefined();
  });

  it('treats an unreadable entry as absent rather than crashing', async () => {
    const { entries, factory } = fakeKeyring();
    const store = createKeychainStore(factory);
    entries.set('docsync/notion', 'not json');

    expect(await store.read('notion')).toBeUndefined();
  });

  it('rejects a credential the keychain gave back without an access token', async () => {
    const { entries, factory } = fakeKeyring();
    const store = createKeychainStore(factory);
    entries.set('docsync/notion', JSON.stringify({ identity: {} }));

    expect(await store.read('notion')).toBeUndefined();
  });

  it('reports a keychain that will not answer', async () => {
    const store = createKeychainStore(() => ({
      getPassword: () => Promise.reject(new Error('the keychain is locked')),
      setPassword: () => Promise.reject(new Error('the keychain is locked')),
      deleteCredential: () => Promise.reject(new Error('the keychain is locked')),
    }));

    await expect(store.read('notion')).rejects.toThrow(AuthError);
    await expect(store.write('notion', token)).rejects.toThrow(/keychain/i);
    await expect(store.delete('notion')).rejects.toThrow(/keychain/i);
  });
});

describe('createMemoryStore', () => {
  it('is a store, seeded or empty', async () => {
    const store = createMemoryStore({ notion: token });

    expect(await store.read('notion')).toEqual(token);
    expect(await store.read('gdocs')).toBeUndefined();
    await store.write('gdocs', token);
    expect(await store.read('gdocs')).toEqual(token);
    expect(await store.delete('gdocs')).toBe(true);
    expect(await store.delete('gdocs')).toBe(false);
    expect(await createMemoryStore().read('notion')).toBeUndefined();
  });

  it('hands back a copy, so a caller cannot mutate the store by accident', async () => {
    const store = createMemoryStore({ notion: token });

    const read = await store.read('notion');
    // biome-ignore lint/style/noNonNullAssertion: just asserted above
    read!.accessToken = 'tampered';

    expect((await store.read('notion'))?.accessToken).toBe('at');
  });
});

describe('defaultEntry', () => {
  it('is an AsyncEntry for the docsync service', () => {
    // Constructing an entry does not read or write the keychain, so this runs
    // everywhere; the round trip against the real OS store is the tagged test
    // below.
    const entry = defaultEntry(KEYCHAIN_SERVICE, 'notion');

    expect(typeof entry.getPassword).toBe('function');
    expect(typeof entry.setPassword).toBe('function');
    expect(typeof entry.deleteCredential).toBe('function');
  });
});

// Touches the real OS keychain, which does not exist on a CI runner and pops a
// dialog on a locked one. Run with DOCSYNC_TEST_KEYCHAIN=1.
describe.runIf(process.env.DOCSYNC_TEST_KEYCHAIN === '1')('the real keychain', () => {
  it('round-trips and deletes', async () => {
    const store = createKeychainStore((_service, account) => defaultEntry('docsync-test', account));
    try {
      await store.write('notion', token);
      expect(await store.read('notion')).toEqual(token);
    } finally {
      expect(await store.delete('notion')).toBe(true);
    }
    expect(await store.read('notion')).toBeUndefined();
  });
});
