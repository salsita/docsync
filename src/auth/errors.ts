import type { Source } from '../source-ref.js';
import { appKeyOf, labelOf } from './sources.js';

/** Anything that went wrong signing in to, or reading a credential for, a source. */
export class AuthError extends Error {
  readonly source: Source;

  constructor(source: Source, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
    this.source = source;
  }
}

/**
 * No usable token for this source. The message carries the literal command to
 * run, because this is what every other command turns into when a credential
 * is missing (MANUAL §2: "fails immediately and clearly ... with the command
 * to run").
 */
export class NotSignedInError extends AuthError {
  constructor(source: Source, detail?: string) {
    const why = detail ? `${detail} ` : '';
    super(source, `${why}Not signed in to ${labelOf(source)}. Run: docsync auth ${source}`);
    this.name = 'NotSignedInError';
  }
}

/** The apps file exists but the entry this source needs is still blank. */
export class AppsFileIncompleteError extends AuthError {
  readonly path: string;

  constructor(source: Source, path: string) {
    super(
      source,
      `No ${appKeyOf(source)} OAuth app in ${path}. ` +
        `Fill in client_id and client_secret under "${appKeyOf(source)}:" and run the command again.`,
    );
    this.name = 'AppsFileIncompleteError';
    this.path = path;
  }
}
