/**
 * The `docsync` binary of the end-to-end tests: the real front end over the
 * fake `Source`, whose store is the JSON file `DOCSYNC_FAKE_STORE` names.
 *
 * `cli.ts` is the same file with the real registry and the real keychain. This
 * exists because the skill file tells an agent to run `docsync pull` and
 * `docsync status`, and `skill.claude.test.ts` puts a real agent in a checkout
 * that has no real source behind it: the commands have to work there, printing
 * what the manual says they print, without a network or a credential.
 */
import { createFakeCredentialProvider } from '../auth/provider.js';
import { createFakeRegistry, createFileStore } from '../helper/fake-source.mock.js';
import { createContext } from './context.js';
import { runCli } from './program.js';

const store = createFileStore(process.env.DOCSYNC_FAKE_STORE ?? 'docsync-fake-store.json');
const FAKE_IDENTITY = { name: 'Ada Lovelace', email: 'ada@example.com' };

process.exitCode = await runCli(
  process.argv.slice(2),
  createContext({
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    sources: createFakeRegistry(store),
    provider: createFakeCredentialProvider({
      notion: { accessToken: 'fake', identity: {} },
      gdocs: { accessToken: 'fake', identity: {} },
    }),
    // Signed in already, and no keychain anywhere near the test.
    auth: {
      signIn: async () => FAKE_IDENTITY,
      signOut: async () => true,
      whoAmI: async () => FAKE_IDENTITY,
    },
  }),
);
