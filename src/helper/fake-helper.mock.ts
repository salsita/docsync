/**
 * The helper binary of the end-to-end tests: the real helper over the fake
 * `Source`, whose store is the JSON file `DOCSYNC_FAKE_STORE` names, and a
 * credential provider signed in to the sources `DOCSYNC_FAKE_SIGNED_IN`
 * lists (both, by default). Built by `e2e.test.ts` and put on git's PATH
 * under the name `git-remote-docsync`.
 */
import { createFakeCredentialProvider } from '../auth/provider.js';
import type { SourceName } from '../source.js';
import { createFakeRegistry, createFileStore } from './fake-source.mock.js';
import { main } from './main.js';

const store = createFileStore(process.env.DOCSYNC_FAKE_STORE ?? 'docsync-fake-store.json');
const signedIn = (process.env.DOCSYNC_FAKE_SIGNED_IN ?? 'notion,gdocs')
  .split(',')
  .filter((name) => name !== '') as SourceName[];
const provider = createFakeCredentialProvider(
  Object.fromEntries(signedIn.map((name) => [name, { accessToken: 'fake', identity: {} }])),
);

process.exitCode = await main(createFakeRegistry(store), provider);
