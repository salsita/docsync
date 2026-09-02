import type { Source } from '../source-ref.js';

/**
 * Who a stored token belongs to — the "signed in as" line, and nothing else.
 * Every field is optional because the two sources volunteer different things:
 * Google gives an email, Notion gives a workspace and usually a name.
 */
export interface Identity {
  name?: string;
  email?: string;
  workspace?: string;
}

/** What is kept in the keychain for one source, serialised as JSON. */
export interface Credential {
  accessToken: string;
  /** Google only. Notion tokens do not expire and are never refreshed. */
  refreshToken?: string;
  /** Epoch milliseconds. Absent when the token does not expire (Notion). */
  expiresAt?: number;
  identity: Identity;
}

/**
 * The keychain, or a stand-in for it. Async because the real one is
 * (`@napi-rs/keyring`'s `AsyncEntry`), and because a store that talks to an
 * agent process is a plausible future.
 */
export interface CredentialStore {
  read(source: Source): Promise<Credential | undefined>;
  write(source: Source, credential: Credential): Promise<void>;
  /** `true` when something was removed, `false` when there was nothing there. */
  delete(source: Source): Promise<boolean>;
}

/** One OAuth app as the user pasted it into `~/.docsync/oauth-apps.yaml`. */
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
}

/**
 * Everything this module touches that is not a pure function, in one bag, so
 * that the flows can be driven end to end in a test without a keychain, an
 * editor, a browser, a wall clock or the network. Every field has a real
 * default; a test overrides only what it cares about.
 */
export interface AuthDeps {
  /** Where tokens live. Default: the OS keychain under service `docsync`. */
  store?: CredentialStore;
  /** Home directory holding `.docsync/`. Default: `os.homedir()`. */
  home?: string;
  /** Opens the apps file and blocks until the editor exits. Default: `$EDITOR`. */
  runEditor?: (path: string) => void;
  /** Hands the authorization URL to a browser. Default: the platform opener. */
  openBrowser?: (url: string) => void;
  /** Where the URL and progress lines go. Default: `console.log`. */
  log?: (line: string) => void;
  /** Epoch milliseconds. Default: `Date.now`. */
  now?: () => number;
  /** HTTP. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Loopback ports to try in order. Default: `[27183, 27184]`. */
  ports?: number[];
  /** How long to wait for the callback. Default: five minutes. */
  timeoutMs?: number;
  /** Google's issuer, so a test can point discovery at a local server. */
  googleIssuer?: string;
  /** Notion's OAuth endpoints, so a test can point them at a local server. */
  notionEndpoints?: { authorization: string; token: string };
}
