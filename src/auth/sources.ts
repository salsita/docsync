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
  return source === 'gdocs' ? 'Google' : 'Notion';
}
