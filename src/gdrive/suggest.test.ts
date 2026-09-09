/**
 * A push under a root with `suggest: true`, end to end on the fake Drive
 * (ticket 33, MANUAL §4, §7).
 *
 * The three halves of the feature meet here and nowhere else: the batch goes
 * out in suggesting mode, the body at the source is not written, and the fetch
 * that follows reads the Doc whatever its `modifiedTime` says — which is what
 * takes the checkout back to the source text and puts one thread per suggestion
 * in the sidecar.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { FetchedFile } from '../source.js';
import { suggestionThreads } from './comments.js';
import { createFakeDrive, type FakeDrive } from './fake-api.mock.js';
import { markdownToRequests } from './from-markdown.js';
import { fetchRoot } from './index.js';
import { pushRoot } from './push.js';
import { footnoteRequests } from './write.js';

const FOLDER_ID = 'folder-client';
const BRIEF_ID = 'doc-brief';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PATH = 'client/Brief.md';

const provider = createFakeCredentialProvider();

const root: Root = {
  path: 'client/',
  src: { source: 'gdocs', id: FOLDER_ID },
  ignore: [],
  comments: true,
  suggest: true,
};

const BASE = '# Brief\n\nOne.\n\nTwo.\n';
const NEXT = '# Brief\n\nOne, edited.\n\nTwo.\n';

async function drive(): Promise<FakeDrive> {
  const api = createFakeDrive([
    { id: FOLDER_ID, name: 'Client', mimeType: FOLDER_MIME },
    { id: BRIEF_ID, name: 'Brief', parents: [FOLDER_ID] },
  ]);
  const { replies, ...rest } = await api.batchUpdate(BRIEF_ID, markdownToRequests(BASE).requests);
  void replies;
  void rest;
  api.calls.length = 0;
  return api;
}

/** One fetch of the root, with the index the last one left. */
async function fetched(
  api: FakeDrive,
  previous: DocumentIndex = new Map(),
): Promise<{ files: FetchedFile[]; index: DocumentIndex }> {
  const result = await fetchRoot(root, provider, previous, { api });
  return {
    files: result.files,
    index: new Map(result.entries.map((one): [string, IndexEntry] => [one.path, one])),
  };
}

const textOf = (files: readonly FetchedFile[], path: string): string | undefined =>
  files.find((file) => file.path === path)?.text;

describe('a push under a suggest root', () => {
  it('suggests the edit, leaves the body, and comes back to the source text', async () => {
    const api = await drive();
    const first = await fetched(api);
    const before = textOf(first.files, PATH);
    expect(before).toContain('One.');

    const report = await pushRoot(
      root,
      [
        {
          kind: 'modified',
          path: PATH,
          text: (before ?? '').replace('One.', 'One, edited.'),
          previousText: before ?? '',
        },
      ],
      provider,
      first.index,
      { api },
    );

    // The batch went out in suggesting mode, and the report says `suggested`
    // rather than `updated`. The API reports no count, and neither does the fake.
    expect(api.calls).toContain(`batchUpdate ${BRIEF_ID} suggest`);
    expect(report[0]?.action).toBe('suggested');
    expect(report[0]?.suggested ?? 0).toBe(0);
    // Nothing was written to the document itself (MANUAL §7).
    expect(api.markdown(BRIEF_ID)).toBe(BASE);

    // The fetch after the push reads the Doc whatever Drive's metadata says,
    // so the file goes back to the source text and the sidecar gains a thread
    // per suggestion.
    const second = await fetched(api, first.index);
    expect(textOf(second.files, PATH)).toBe(before);
    const sidecar = textOf(second.files, 'client/Brief.comments.md') ?? '';
    expect(sidecar).toContain('— suggestion');
    expect(sidecar).toContain('One, edited.');
    expect(sidecar.match(/^## /gm)?.length ?? 0).toBeGreaterThan(0);

    // And there is nothing left to push: the branch says what the source says.
    api.calls.length = 0;
    expect(await pushRoot(root, [], provider, second.index, { api })).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it('shows a suggestion somebody made in Docs on the next fetch', async () => {
    const api = await drive();
    const first = await fetched(api);
    expect(first.files.map((file) => file.path)).not.toContain('client/Brief.comments.md');

    // The client suggests a word in Docs. Drive moves no `modifiedTime` for it,
    // which is exactly why a suggest root re-reads every Doc (MANUAL §4).
    await api.batchUpdate(
      BRIEF_ID,
      [{ insertText: { location: { index: 12 }, text: ' Really.' } }],
      { suggest: true },
    );

    const second = await fetched(api, first.index);

    // The body is what it always was; the suggestion is in the sidecar.
    expect(textOf(second.files, PATH)).toBe(textOf(first.files, PATH));
    const sidecar = textOf(second.files, 'client/Brief.comments.md') ?? '';
    expect(sidecar).toContain('— suggestion');
    expect(sidecar).toContain('Really.');
  });

  it('reads a Doc whose modified time did not move, and writes no other request', async () => {
    const api = await drive();
    const first = await fetched(api);
    api.calls.length = 0;

    // What a fetch of a suggest root costs, counted: the fake records the
    // requests it is given, and the reads are wrapped here (MANUAL §7).
    const counts = { getDocument: 0, comments: 0, listFolder: 0 };
    const { getDocument, comments, listFolder } = api;
    api.getDocument = (id, mode) => {
      counts.getDocument += 1;
      return getDocument(id, mode);
    };
    api.comments = (id) => {
      counts.comments += 1;
      return comments(id);
    };
    api.listFolder = (id) => {
      counts.listFolder += 1;
      return listFolder(id);
    };

    const again = await fetched(api, first.index);

    // Nothing moved at the source, and the Doc is still read once, with its
    // comments, and written back for git to compare.
    expect(counts).toEqual({ getDocument: 1, comments: 1, listFolder: 1 });
    // And nothing was written: the root's own metadata read is the whole of it.
    expect(api.calls).toEqual([`getFile ${FOLDER_ID}`]);
    expect(textOf(again.files, PATH)).toBe(textOf(first.files, PATH));
    // The body is offered on every fetch; git decides it is not a change.
    expect(again.files.find((file) => file.path === PATH)?.changed).toBe(true);
    expect(again.files.find((file) => file.path === PATH)?.sourceChanged).toBe(false);
  });

  it('does not suggest under a root that does not ask for it', async () => {
    const api = await drive();
    const plain: Root = { ...root, suggest: false };
    const first = await fetchRoot(plain, provider, new Map(), { api });
    const index = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    const before = textOf(first.files, PATH) ?? '';

    const report = await pushRoot(
      plain,
      [
        {
          kind: 'modified',
          path: PATH,
          text: before.replace('One.', 'One, edited.'),
          previousText: before,
        },
      ],
      provider,
      index,
      { api },
    );
    expect(api.calls).toContain(`batchUpdate ${BRIEF_ID}`);
    expect(report[0]?.action).toBe('updated');
    expect(api.markdown(BRIEF_ID)).toBe(NEXT);
  });
});

describe('a suggesting push that the API will not take', () => {
  /** One edit under the suggest root, pushed against `api`. */
  async function push(api: FakeDrive, index: DocumentIndex, before: string): Promise<void> {
    await pushRoot(
      root,
      [
        {
          kind: 'modified',
          path: PATH,
          text: before.replace('One.', 'One, edited.'),
          previousText: before,
        },
      ],
      provider,
      index,
      { api },
    );
  }

  it('adds the enrolment hint to what the API said (MANUAL §7)', async () => {
    const api = await drive();
    const first = await fetched(api);
    api.batchUpdate = async () => {
      throw new Error(
        'Google API 403 on https://docs.googleapis.com/v1/documents/doc-brief:batchUpdate: ' +
          'the caller does not have access to the developer preview',
      );
    };

    await expect(push(api, first.index, textOf(first.files, PATH) ?? '')).rejects.toThrow(
      /the caller does not have access to the developer preview\. suggesting needs the Google Workspace Developer Preview Program on the project that owns the OAuth client \(client\/Brief\.md\)/,
    );
  });

  it('leaves a 400 about an index exactly as it came: that is the patch, not enrolment', async () => {
    const api = await drive();
    const first = await fetched(api);
    api.batchUpdate = async () => {
      throw new Error(
        'Google API 400 on …: Invalid requests[2].insertText: The insertion index must be inside the bounds of an existing paragraph.',
      );
    };

    await expect(push(api, first.index, textOf(first.files, PATH) ?? '')).rejects.toThrow(
      /existing paragraph\.$/,
    );
  });

  it('leaves an ordinary failure exactly as it came', async () => {
    const api = await drive();
    const first = await fetched(api);
    api.batchUpdate = async () => {
      throw new Error('Google API 503 on …: backend error');
    };

    await expect(push(api, first.index, textOf(first.files, PATH) ?? '')).rejects.toThrow(
      /^Google API 503 on …: backend error$/,
    );
  });

  it('fails the push when `commentUpdateState` is not a success (MANUAL §7)', async () => {
    const api = await drive();
    const first = await fetched(api);
    const { batchUpdate } = api;
    api.batchUpdate = async (id, requests, options) => ({
      ...(await batchUpdate(id, requests, options)),
      commentUpdateState: { state: 'FAILED', message: 'the comments could not be written' },
    });

    await expect(push(api, first.index, textOf(first.files, PATH) ?? '')).rejects.toThrow(
      'the suggestions were not written: the comments could not be written (client/Brief.md)',
    );
  });
});

/**
 * The rewrite the ticket 33 smoke pushed, on the fake: one thread per
 * suggestion id, whatever a suggestion spans (ticket 34).
 *
 * The smoke against the real API turned 13 suggestion ids into 106 sidecar
 * threads, because the sidecar grouped by paragraph. The fake cuts the same
 * rewrite into more suggestions than Docs does — one per request — but the
 * claim under test is the equality, not the count.
 */
describe('the discovery rewrite, suggested', () => {
  const fixture = (name: string): string =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', name), 'utf8');

  it('makes exactly one sidecar thread per distinct suggestion id', async () => {
    const api = createFakeDrive([
      { id: FOLDER_ID, name: 'Client', mimeType: FOLDER_MIME },
      { id: BRIEF_ID, name: 'Brief', parents: [FOLDER_ID] },
    ]);
    const plan = markdownToRequests(fixture('push-discovery-base.md'));
    const { replies } = await api.batchUpdate(BRIEF_ID, plan.requests);
    await api.batchUpdate(
      BRIEF_ID,
      footnoteRequests(plan.footnotes, replies, 0, await api.getDocument(BRIEF_ID)),
    );

    const first = await fetched(api);
    const before = textOf(first.files, PATH) ?? '';
    const frontmatter = before.slice(0, before.indexOf('\n---\n') + '\n---\n\n'.length);

    await pushRoot(
      root,
      [
        {
          kind: 'modified',
          path: PATH,
          text: `${frontmatter}${fixture('push-discovery-next.md')}`,
          previousText: before,
        },
      ],
      provider,
      first.index,
      { api },
    );

    const inline = await api.getDocument(BRIEF_ID, 'inline');
    const threads = suggestionThreads(inline, api.markdown(BRIEF_ID));
    const ids = new Set(threads.map((thread) => thread.id));

    expect(ids.size).toBeGreaterThan(10);
    expect(threads).toHaveLength(ids.size);
    // And every one of them is in the sidecar the fetch after the push writes.
    const second = await fetched(api, first.index);
    const sidecar = textOf(second.files, 'client/Brief.comments.md') ?? '';
    expect(sidecar.match(/^## /gm) ?? []).toHaveLength(ids.size);
  });
});
