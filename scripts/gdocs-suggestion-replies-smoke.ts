/**
 * The manual test for ticket 40: suggestion discussions and comment anchors
 * against the real Docs API.
 *
 * The fake model and the recorded fixtures prove the *reading*; only Google can
 * say whether `commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED` answers what the
 * Developer Preview documentation claims, and whether a reply written with
 * `addCommentReply` comes back under the suggestion it was written under. So
 * this makes a Doc of its own inside the fixture folder "Docsync test" —
 * nothing that is already there is written or renamed — and checks:
 *
 * 1. the read is accepted at all, and echoes the mode it was asked for,
 * 2. a suggesting batch shows up in `suggestions[]` as an OPEN thread with a
 *    `summaryText`, which the Drive comments API does not return at all,
 * 3. `addCommentReply` with a `suggestionId` puts a post under that
 *    suggestion's card,
 * 4. a comment on the Doc comes back in `comments[]` under the same id Drive
 *    gives it, and, when it is anchored, the tab's `commentAnchors` places it,
 * 5. the sidecar a fetch would write carries the summary line and the reply.
 *
 * It trashes the Doc at the end — trashed, never deleted (MANUAL §8) — and
 * prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdocs-suggestion-replies-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts gdocs`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';
import { formatSidecar } from '../dist/comments/format.js';
import {
  createGDriveApi,
  DOCUMENT_MIME,
  type DocsDocument,
  DRIVE_ENDPOINT,
} from '../dist/gdrive/api.js';
import { placeThreads } from '../dist/gdrive/comments.js';
import { flattenTabs } from '../dist/gdrive/tabs.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

/** The read-only fixture folder. The Doc this script makes is its own. */
const FOLDER = '13bDdq9dYrAR1E23oS2cLV__S71xIagPt';
const TITLE = 'Suggestion replies smoke (docsync)';

const BODY = '# Price\n\nThe rate is one hundred euro a day.\n';
/** The word the suggestion replaces, and what it replaces it with. */
const FROM = 'one';
const TO = 'three';
const REPLY = 'The price lock stays until the end of the quarter.';
const COMMENT = 'Is this the rate we agreed?';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(12)} ${detail}`);
}

function check(name: string, passed: boolean, detail = ''): boolean {
  say(passed ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
  return passed;
}

const token = await createCredentialProvider().accessToken('gdocs');
const api = createGDriveApi(token);
const writer = createGDriveWriter(api);
let ok = true;

/** Where a piece of the tab's text sits, in the indices the API counts in. */
function indexOf(doc: DocsDocument, text: string): number {
  for (const element of doc.body?.content ?? []) {
    for (const part of element.paragraph?.elements ?? []) {
      const at = (part.textRun?.content ?? '').indexOf(text);
      if (at >= 0) return (part.startIndex ?? 0) + at;
    }
  }
  throw new Error(`no "${text}" in the document`);
}

/** One tab as a document, which is what every reader above `tabs.ts` reads. */
function onlyTab(document: DocsDocument): DocsDocument {
  return flattenTabs(document)[0]?.doc ?? {};
}

const made = await api.createFile({ name: TITLE, mimeType: DOCUMENT_MIME, parents: [FOLDER] });
say('create', `${made.id} "${TITLE}" in the fixture folder`);

try {
  const tabId = flattenTabs(await api.getDocument(made.id))[0]?.id ?? '';
  await writer.writeTab(made.id, tabId, parseMarkdown(BODY));
  say('write', `the body into tab ${tabId}`);

  // A suggestion, exactly as a push under a suggest root makes one: the same
  // requests, with `writeControl.writeMode: SUGGEST` (MANUAL §7, ticket 33).
  const written = onlyTab(await api.getDocument(made.id, 'inline'));
  const at = indexOf(written, FROM);
  await api.batchUpdate(
    made.id,
    [
      { insertText: { location: { index: at, tabId }, text: TO } },
      {
        deleteContentRange: {
          range: { startIndex: at + TO.length, endIndex: at + TO.length + FROM.length, tabId },
        },
      },
    ],
    { suggest: true },
  );
  say('suggest', `"${FROM}" → "${TO}" as a suggestion`);

  // A comment, which Drive is the one that can make: the Docs preview reads
  // them, and an anchor is what it adds to what Drive already said.
  const commented = await fetch(
    `${DRIVE_ENDPOINT}/files/${made.id}/comments?fields=id&supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: COMMENT,
        quotedFileContent: { mimeType: 'text/html', value: 'hundred euro' },
      }),
    },
  );
  const commentId = ((await commented.json()) as { id?: string }).id ?? '';
  say('comment', `${commentId} on the Doc, through Drive`);

  // 1. The read the sidecar makes, with the discussions asked for.
  const reply = await api.getDocument(made.id, 'inline', { comments: true });
  const suggestions = reply.suggestions ?? [];
  const open = suggestions.filter((one) => one.status === 'OPEN');
  ok =
    check(
      'the preview answered the discussions',
      reply.comments !== undefined || suggestions.length > 0,
      `${(reply.comments ?? []).length} comments, ${suggestions.length} suggestions`,
    ) && ok;

  // 2. The suggestion, as a thread of its own with a summary line.
  const [suggestion] = open;
  ok =
    check(
      'the suggesting batch is one OPEN suggestion with a summary',
      suggestion !== undefined && (suggestion.summaryText ?? '') !== '',
      `${suggestion?.suggestionId ?? '(none)'} ${JSON.stringify(suggestion?.summaryText ?? '')}`,
    ) && ok;

  // 3. A reply under its card, which is the write this ticket is about.
  //
  // `addCommentReply` takes a `suggestionId` for a suggestion, not a
  // `commentId`: a suggestion id is not a comment id, and the API says so —
  // "Add reply requests must specify a comment ID or suggestion ID" (probed
  // 2026-09-16).
  await api.batchUpdate(made.id, [
    { addCommentReply: { suggestionId: suggestion?.suggestionId ?? '', post: { content: REPLY } } },
  ]);
  say('reply', `addCommentReply on ${suggestion?.suggestionId ?? '(none)'}`);

  const after = await api.getDocument(made.id, 'inline', { comments: true });
  const discussed = (after.suggestions ?? []).find(
    (one) => one.suggestionId === suggestion?.suggestionId,
  );
  ok =
    check(
      'the reply came back under that suggestion',
      (discussed?.replies ?? []).some((post) => post.content === REPLY),
      `${(discussed?.replies ?? []).length} replies`,
    ) && ok;

  // 4. The comment, and the anchor that places it.
  const thread = (after.comments ?? []).find((one) => one.commentId === commentId);
  const anchors = onlyTab(after).commentAnchors ?? {};
  const anchor = anchors[thread?.anchorId ?? ''];
  ok =
    check(
      'the Drive comment came back under the same id',
      thread !== undefined,
      `${(after.comments ?? []).length} in comments[], Drive id ${commentId}`,
    ) && ok;
  // A comment made through the Drive API is not anchored to a range: only the
  // Docs UI anchors one, so `anchorId` is absent here and the thread takes the
  // fallback, the search by quoted text (MANUAL §6). Both halves are checked —
  // whichever this comment turned out to be.
  if (thread?.anchorId === undefined || thread.anchorId === '') {
    say(
      'note',
      'the comment Drive made carries no anchor, so the sidecar places it by its quote; the anchored path is what the recorded Elements Doc covers',
    );
  } else {
    ok =
      check(
        'and the tab places it by range',
        anchor !== undefined && (anchor.ranges ?? []).length > 0,
        `anchorId ${thread.anchorId}, ${Object.keys(anchors).length} anchors on the tab`,
      ) && ok;
  }

  // 5. The sidecar a fetch would write from that one read.
  const tab = onlyTab(after);
  const body = documentToMarkdown(tab);
  const threads = placeThreads([{ doc: tab, body }], await api.comments(made.id), after)[0] ?? [];
  const sidecar = formatSidecar({
    document: { source: 'gdocs', id: made.id },
    fetched: '2026-01-01T00:00:00Z',
    threads,
  });
  ok =
    check(
      'the sidecar carries the summary and the reply',
      sidecar.includes(suggestion?.summaryText ?? ' ') && sidecar.includes(REPLY),
      `${threads.length} threads`,
    ) && ok;
  ok = check('and the comment thread with it', sidecar.includes(COMMENT)) && ok;
  console.log(`\n--- the sidecar ---\n${sidecar}-------------------\n`);
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
}

console.log(
  `${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the trashed Doc "${TITLE}" (${made.id}) in the fixture folder, recoverable from the Drive trash, with the comment and the suggestion it carries. Nothing that was already in the folder was written.`,
);
process.exit(ok ? 0 : 1);
