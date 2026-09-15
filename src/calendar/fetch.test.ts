/**
 * A calendar root as git sees it (MANUAL §6, §7, ticket 38).
 *
 * The fetch tests next door stop at the files a fetch answers. This one runs
 * the whole read path — the real calendar adapter over a fake calendar and a
 * fake Drive, through the helper's `fetchCommit` — into a real repository, so
 * that the commit, the index and the second fetch that finds nothing are the
 * ones the Done-when asks for rather than a claim about them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import { createFakeDrive, type FakeDrive } from '../gdrive/fake-api.mock.js';
import { createGDriveWriter } from '../gdrive/write.js';
import { type FetchDeps, fetchCommit } from '../helper/fetch.js';
import { createTempRepo, type TempRepo } from '../helper/temp-repo.mock.js';
import type { Manifest } from '../manifest/types.js';
import { parseMarkdown } from '../markdown.js';
import type { FetchOptions, SourceRegistry } from '../source.js';
import { createFakeCalendar, type FakeCalendar } from './fake-api.mock.js';
import { fetchRoot } from './index.js';

const EVENT = '0gce3vkvut6cj027fb86qrtc2a';
const NOTES = '1GeminiNotesDocIdXXXXXXX';

const manifest: Manifest = {
  version: 1,
  roots: [{ src: { source: 'calendar', id: EVENT }, path: 'calls/', ignore: [] }],
};

/** The registry `fetchCommit` calls, with the two fakes behind the adapter. */
function registry(drive: FakeDrive, calendar: FakeCalendar): SourceRegistry {
  const source = {
    fetchRoot: (
      root: Parameters<typeof fetchRoot>[0],
      provider: Parameters<typeof fetchRoot>[1],
      previous: Parameters<typeof fetchRoot>[2],
      options: FetchOptions = {},
    ) =>
      fetchRoot(root, provider, previous, {
        ...options,
        api: drive,
        calendar,
        now: () => new Date('2026-09-20T00:00:00Z'),
      }),
    pushRoot: () => {
      throw new Error('this test does not push');
    },
    describe: () => {
      throw new Error('this test does not resolve');
    },
  };
  return { gdocs: source, notion: source, calendar: source } as unknown as SourceRegistry;
}

describe('a recurring call with notes on it', () => {
  let repo: TempRepo;
  let drive: FakeDrive;
  let calendar: FakeCalendar;
  let deps: FetchDeps;

  beforeAll(async () => {
    repo = createTempRepo('docsync-calendar-');
    drive = createFakeDrive([
      { id: NOTES, name: 'Contracts review - Notes by Gemini', modifiedTime: '2026-09-01T10:00Z' },
    ]);
    const writer = createGDriveWriter(drive);
    await writer.writeTab(NOTES, 't.0', parseMarkdown('The quick notes.\n'));
    const full = await writer.addTab(NOTES, 'Full notes');
    await writer.writeTab(NOTES, full, parseMarkdown('The full notes.\n'));

    calendar = createFakeCalendar([
      {
        id: EVENT,
        summary: 'Contracts review',
        updated: '2026-09-01T10:00:00Z',
        recurring: true,
        instances: [
          {
            id: `${EVENT}_20260901T070000Z`,
            start: { dateTime: '2026-09-01T09:00:00+02:00', timeZone: 'Europe/Prague' },
            attachments: [{ fileId: NOTES, title: 'Contracts review - Notes by Gemini' }],
          },
        ],
      },
    ]);

    deps = {
      git: repo.git,
      sources: registry(drive, calendar),
      provider: createFakeCredentialProvider({ gdocs: { accessToken: 'x', identity: {} } }),
      log: () => {},
      now: () => new Date('2026-09-20T12:00:00Z'),
    };
  });

  afterAll(() => repo.remove());

  it('commits the call as a directory of the notes, and finds nothing the second time', async () => {
    const first = await fetchCommit(deps, manifest, undefined);

    expect(first.commit).toBeDefined();
    expect(names(repo, first.commit ?? '')).toEqual([
      '.docsync/index.yaml',
      'calls/2026-09-01 09-00 Contracts review/Contracts review - Notes by Gemini/Contracts review - Notes by Gemini.md',
      'calls/2026-09-01 09-00 Contracts review/Contracts review - Notes by Gemini/Full notes.md',
    ]);
    // The index keeps the Drive identity of the attachment, tab by tab: every
    // rule about a Drive file holds under a calendar root too (ticket 38).
    const index = blob(repo, first.commit ?? '', '.docsync/index.yaml');
    expect(index).toContain(`src: gdocs:${NOTES}#t.0`);
    expect(index).not.toContain('calendar:');

    // Nothing moved at either source, so the second fetch writes no commit.
    const again = await fetchCommit(deps, manifest, first.commit);
    expect(again.commit).toBe(first.commit);
    expect(again.changed).toBe(false);
    expect(again.report.changed).toEqual([]);
  });
});

/** Every path one commit holds, sorted. */
function names(repo: TempRepo, commit: string): string[] {
  return repo.run('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean).sort();
}

/** One file of one commit, as text. */
function blob(repo: TempRepo, commit: string, path: string): string {
  return repo.run('show', `${commit}:${path}`);
}
