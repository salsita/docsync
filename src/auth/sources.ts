import type { Source } from '../source-ref.js';

/**
 * The key a source has in `~/.docsync/oauth-apps.yaml`. The file is written by
 * hand and talks about the *vendor* whose console you registered the app in
 * (MANUAL §2), while the rest of docsync says `gdocs`, the prefix of a source
 * ref. The mapping lives here so only one file knows about the difference.
 */
export function appKeyOf(source: Source): string {
  return source === 'gdocs' ? 'google' : source;
}

/** The name for a source in a sentence addressed to the user. */
export function labelOf(source: Source): string {
  return source === 'notion' ? 'Notion' : 'Google';
}

/**
 * Which credential a source signs its requests with (#38).
 *
 * A calendar is Google: the Calendar scope is part of the Google sign-in
 * (`GOOGLE_SCOPES`), so there is no `docsync auth calendar` and no fourth
 * token in the keychain. Everything that reads, writes or names a credential
 * goes through this first, which is why a missing one sends the user to
 * `docsync auth gdocs` rather than to a command that does not exist.
 */
export function credentialSourceOf(source: Source): Source {
  return source === 'calendar' ? 'gdocs' : source;
}

/** Every source name there is, sorted. The registry in `source.ts` agrees. */
const ALL: Source[] = ['calendar', 'gdocs', 'notion'];

/**
 * The sources one can sign in to: the ones that own a credential of their own.
 * What `docsync auth <source>` takes, and what its refusal lists (MANUAL §2).
 */
export const authSourceNames: Source[] = ALL.filter(
  (source) => credentialSourceOf(source) === source,
);
