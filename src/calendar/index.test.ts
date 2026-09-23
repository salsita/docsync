import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/provider.js';
import { createFakeDrive, type FakeDrive } from '../gdrive/fake-api.mock.js';
import { createGDriveWriter } from '../gdrive/write.js';
import { GoogleApiError } from '../google-http.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { parseMarkdown } from '../markdown.js';
import { createFakeCalendar, type FakeCalendar } from './fake-api.mock.js';
import { changedSince, describe as describeRef, fetchRoot, pushRoot } from './index.js';

const NOTES = 'doc-notes';
const NOTES_LATER = 'doc-notes-later';
const PDF = 'file-brief';
const RECORDING = 'file-recording';

/** The clock every test reads: two of the four calls are in the past. */
const NOW = new Date('2026-09-20T00:00:00Z');

const root: Root = { src: { source: 'calendar', id: 'ev1' }, path: 'calls/', ignore: [] };

const provider = createFakeCredentialProvider({
  gdocs: { accessToken: 'unused', identity: { email: 'owner@example.com' } },
});

let drive: FakeDrive;
let calendar: FakeCalendar;

/** The Drive files a call leaves behind: notes with two tabs, a brief, a recording. */
async function createDrive(): Promise<FakeDrive> {
  const api = createFakeDrive([
    {
      id: NOTES,
      name: 'Contracts review - Notes by Gemini',
      modifiedTime: '2026-09-01T10:00:00Z',
    },
    {
      id: NOTES_LATER,
      name: 'Contracts review - Notes by Gemini',
      modifiedTime: '2026-09-15T10:00:00Z',
    },
    {
      id: PDF,
      name: 'Brief.pdf',
      mimeType: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.4'),
      modifiedTime: '2026-09-08T10:00:00Z',
    },
    {
      id: RECORDING,
      name: 'Contracts review (2026-09-01) recording.mp4',
      mimeType: 'video/mp4',
      modifiedTime: '2026-09-01T11:00:00Z',
    },
  ]);
  // The notes Doc is what Gemini writes: several tabs (#37).
  const writer = createGDriveWriter(api);
  await writer.writeTab(NOTES, 't.0', parseMarkdown('The quick notes.\n'));
  const full = await writer.addTab(NOTES, 'Full notes');
  await writer.writeTab(NOTES, full, parseMarkdown('The full notes.\n'));
  await writer.writeTab(NOTES_LATER, 't.0', parseMarkdown('Notes of the fourth call.\n'));
  return api;
}

/** The series the root names: three past calls and one still to come. */
function createCalendar(): FakeCalendar {
  return createFakeCalendar([
    {
      id: 'ev1',
      summary: 'Contracts review',
      updated: '2026-09-15T10:00:00Z',
      recurring: true,
      instances: [
        {
          id: 'ev1_20260901T070000Z',
          start: { dateTime: '2026-09-01T09:00:00+02:00', timeZone: 'Europe/Prague' },
          attachments: [
            { fileId: NOTES, title: 'Contracts review - Notes by Gemini' },
            { fileId: RECORDING, title: 'Contracts review (2026-09-01) recording.mp4' },
          ],
        },
        {
          id: 'ev1_20260908T070000Z',
          start: { dateTime: '2026-09-08T09:00:00+02:00', timeZone: 'Europe/Prague' },
          attachments: [{ fileId: PDF, title: 'Brief.pdf' }],
        },
        // A call that happened and left nothing behind.
        {
          id: 'ev1_20260915T070000Z',
          start: { dateTime: '2026-09-15T09:00:00+02:00', timeZone: 'Europe/Prague' },
        },
        // The next call, which has not happened yet.
        {
          id: 'ev1_20260922T070000Z',
          start: { dateTime: '2026-09-22T09:00:00+02:00', timeZone: 'Europe/Prague' },
          attachments: [{ fileId: NOTES_LATER, title: 'Contracts review - Notes by Gemini' }],
        },
      ],
    },
  ]);
}

beforeEach(async () => {
  drive = await createDrive();
  calendar = createCalendar();
});

function options(over: Record<string, unknown> = {}) {
  return { api: drive, calendar, now: () => NOW, ...over };
}

/** The index of a fetch, as the next one is given it. */
function indexOf(entries: readonly IndexEntry[]): DocumentIndex {
  return new Map(entries.map((entry): [string, IndexEntry] => [entry.path, entry]));
}

const FIRST = 'calls/2026-09-01 09-00 Contracts review';
const SECOND = 'calls/2026-09-08 09-00 Contracts review';

describe('fetchRoot', () => {
  it('makes one directory per past call that has an attachment', async () => {
    const result = await fetchRoot(root, provider, new Map(), options());

    // The tabbed notes Doc is a directory of tabs inside the call's directory,
    // and the brief is a file; the call with nothing to pull has no directory
    // at all, and the call still to come is not listed (#38).
    expect(result.files.map((file) => file.path).sort()).toEqual([
      `${FIRST}/Contracts review - Notes by Gemini/Contracts review - Notes by Gemini.md`,
      `${FIRST}/Contracts review - Notes by Gemini/Full notes.md`,
      `${SECOND}/Brief.pdf`,
    ]);
  });

  it('keeps the attachments Drive identity, ids, tabs and all', async () => {
    const result = await fetchRoot(root, provider, new Map(), options());
    const notes = result.files.find((file) => file.path.endsWith('Full notes.md'));

    expect(notes?.entry).toMatchObject({ src: { source: 'gdocs' }, type: 'gdoc' });
    expect(notes?.text).toContain(`id: gdocs:${NOTES}#`);
    expect(notes?.text).toContain('The full notes.');
    // The Doc's directory has an entry of its own, as under a Drive root
    // (#37): no entry names the instance, whose name is derived.
    expect(result.entries.map((entry) => entry.path)).toContain(
      `${FIRST}/Contracts review - Notes by Gemini/`,
    );
    expect(result.entries.some((entry) => entry.path === `${FIRST}/`)).toBe(false);
    expect(result.entries.every((entry) => entry.src.source === 'gdocs')).toBe(true);

    const brief = result.files.find((file) => file.path === `${SECOND}/Brief.pdf`);
    expect(brief?.entry).toMatchObject({ src: { source: 'gdocs', id: PDF }, type: 'drive-file' });
    expect(new TextDecoder().decode(brief?.bytes)).toBe('%PDF-1.4');
  });

  it('skips a recording instead of checking hundreds of megabytes out', async () => {
    const result = await fetchRoot(root, provider, new Map(), options());

    expect(result.skipped).toEqual([
      {
        id: RECORDING,
        title: 'Contracts review (2026-09-01) recording.mp4',
        path: `${FIRST}/Contracts review (2026-09-01) recording.mp4`,
        reason: 'recording',
      },
    ]);
  });

  it('names an all-day call by its date alone', async () => {
    calendar.events.set('ev2', {
      id: 'ev2',
      summary: 'Offsite',
      updated: '2026-09-02T00:00:00Z',
      instances: [{ start: { date: '2026-09-02' }, attachments: [{ fileId: PDF }] }],
    });

    const result = await fetchRoot(
      { ...root, src: { source: 'calendar', id: 'ev2' } },
      provider,
      new Map(),
      options(),
    );

    expect(result.files.map((file) => file.path)).toEqual(['calls/2026-09-02 Offsite/Brief.pdf']);
  });

  it('reads a single event as its own one instance', async () => {
    calendar.events.set('ev3', {
      id: 'ev3',
      summary: 'Kickoff',
      updated: '2026-09-03T00:00:00Z',
      instances: [
        {
          start: { dateTime: '2026-09-03T14:30:00+02:00' },
          attachments: [{ fileId: PDF }],
        },
      ],
    });

    const result = await fetchRoot(
      { ...root, src: { source: 'calendar', id: 'ev3' } },
      provider,
      new Map(),
      options(),
    );

    expect(result.files.map((file) => file.path)).toEqual([
      'calls/2026-09-03 14-30 Kickoff/Brief.pdf',
    ]);
    // A single event is read, never listed: there are no instances to page.
    expect(calendar.calls).toEqual(['getEvent primary/ev3']);
  });

  it('adds a directory when a later call gains notes', async () => {
    const first = await fetchRoot(root, provider, new Map(), options());
    const index = indexOf(first.entries);

    // The fourth call happens, and Gemini leaves its notes on it.
    const later = new Date('2026-09-23T00:00:00Z');
    const result = await fetchRoot(root, provider, index, options({ now: () => later }));

    const paths = result.files.map((file) => file.path);
    expect(paths).toContain(
      'calls/2026-09-22 09-00 Contracts review/Contracts review - Notes by Gemini.md',
    );
    // The calls that did not move are listed again and downloaded again by
    // nobody: their content is absent, and the fetch reports them unchanged.
    expect(result.files.filter((file) => file.changed)).toHaveLength(1);
    expect(paths).toHaveLength(4);
  });

  it('drops an attachment that is no longer on the event', async () => {
    const first = await fetchRoot(root, provider, new Map(), options());
    const index = indexOf(first.entries);

    const series = calendar.events.get('ev1');
    const instance = series?.instances[1];
    if (instance !== undefined) instance.attachments = [];

    const result = await fetchRoot(root, provider, index, options());

    // The brief is gone from the listing, which is what makes it a deletion in
    // the checkout: the commit holds what the fetch answers (MANUAL §7).
    expect(result.files.map((file) => file.path)).not.toContain(`${SECOND}/Brief.pdf`);
  });

  it('renames the directories when the series is retitled', async () => {
    const first = await fetchRoot(root, provider, new Map(), options());
    const index = indexOf(first.entries);

    const series = calendar.events.get('ev1');
    if (series !== undefined) series.summary = 'Contracts sync';

    const result = await fetchRoot(root, provider, index, options());

    expect(result.files.map((file) => file.path)).toContain(
      'calls/2026-09-08 09-00 Contracts sync/Brief.pdf',
    );
  });

  it('pulls the threads on the notes into sidecars with comments: true', async () => {
    drive.threads.set(NOTES, [
      {
        id: 'c1',
        createdTime: '2026-09-01T12:00:00Z',
        author: { displayName: 'Jane Client' },
        content: 'Agreed, leave it.',
        quotedFileContent: { value: 'The full notes.' },
      },
    ]);

    const result = await fetchRoot({ ...root, comments: true }, provider, new Map(), options());
    const sidecar = result.files.find((file) => file.path.endsWith('.comments.md'));

    expect(sidecar?.path).toBe(
      `${FIRST}/Contracts review - Notes by Gemini/Full notes.comments.md`,
    );
    expect(sidecar?.text).toContain('Agreed, leave it.');
  });
});

describe('describe', () => {
  it('is a container of the past calls that carry an attachment', async () => {
    const described = await describeRef(root.src, provider, options());

    expect(described).toEqual({
      ref: { source: 'calendar', id: 'ev1' },
      title: 'Contracts review',
      kind: 'container',
      childCount: 2,
      lastEditedTime: '2026-09-15T10:00:00Z',
    });
  });

  it('keeps a calendar that is not the signed-in one in the ref', async () => {
    calendar.events.set('ev4', {
      id: 'ev4',
      summary: 'Their call',
      calendarId: 'client@example.test',
      updated: '2026-09-04T00:00:00Z',
      instances: [{ start: { date: '2026-09-04' } }],
    });

    const described = await describeRef(
      { source: 'calendar', id: 'ev4@client@example.test' },
      provider,
      options(),
    );

    expect(described.ref).toEqual({ source: 'calendar', id: 'ev4@client@example.test' });
  });

  it('drops the calendar when it is the signed-in identity', async () => {
    calendar.events.set('ev5', {
      id: 'ev5',
      summary: 'My call',
      calendarId: 'owner@example.com',
      updated: '2026-09-05T00:00:00Z',
      instances: [{ start: { date: '2026-09-05' } }],
    });

    const described = await describeRef(
      { source: 'calendar', id: 'ev5@owner@example.com' },
      provider,
      options(),
    );

    expect(described.ref).toEqual({ source: 'calendar', id: 'ev5' });
  });

  it("fails with the API's message and the ref for an event that is not there", async () => {
    await expect(
      describeRef({ source: 'calendar', id: 'nosuch' }, provider, options()),
    ).rejects.toThrow(/calendar:nosuch.*404/s);
  });
});

describe('changedSince', () => {
  it('says nothing changed when the calls and their files stand still', async () => {
    const first = await fetchRoot(root, provider, new Map(), options());

    expect(await changedSince(root, provider, indexOf(first.entries), options())).toEqual([]);
  });

  it('names a new attachment on a call that is already checked out', async () => {
    const first = await fetchRoot(root, provider, new Map(), options());
    const index = indexOf(first.entries);

    const instance = calendar.events.get('ev1')?.instances[1];
    instance?.attachments?.push({ fileId: RECORDING });
    instance?.attachments?.push({ fileId: NOTES_LATER });

    expect(await changedSince(root, provider, index, options())).toEqual([
      `${SECOND}/Contracts review - Notes by Gemini.md`,
    ]);
  });

  it('names a file that is gone from the event', async () => {
    const first = await fetchRoot(root, provider, new Map(), options());
    const index = indexOf(first.entries);

    const instance = calendar.events.get('ev1')?.instances[1];
    if (instance !== undefined) instance.attachments = [];

    expect(await changedSince(root, provider, index, options())).toEqual([`${SECOND}/Brief.pdf`]);
  });
});

describe('pushRoot', () => {
  it('refuses everything, in the read-only words of §7', async () => {
    await expect(
      pushRoot(
        root,
        [{ kind: 'modified', path: `${SECOND}/Brief.pdf`, text: 'x' }],
        provider,
        new Map(),
      ),
    ).rejects.toThrow(
      `${SECOND}/Brief.pdf is under a read-only root (calls/); nothing under it is pushed.`,
    );
  });
});

describe('an attachment whose file cannot be read', () => {
  /** The fake Drive with one file answering the given error instead. */
  function failing(error: Error) {
    return {
      ...drive,
      async getFile(id: string) {
        if (id === PDF) throw error;
        return drive.getFile(id);
      },
    };
  }

  it('is skipped as gone when Drive says 404', async () => {
    const api = failing(new GoogleApiError(404, 'files/file-brief', 'File not found'));
    const result = await fetchRoot(root, provider, new Map(), options({ api }));
    expect(result.skipped.map((one) => [one.id, one.reason])).toContainEqual([PDF, 'gone']);
    expect(result.files.some((one) => one.path === `${SECOND}/Brief.pdf`)).toBe(false);
  });

  it('fails the fetch on any other error, so nothing turns into a deletion', async () => {
    const api = failing(new GoogleApiError(401, 'files/file-brief', 'Invalid Credentials'));
    await expect(fetchRoot(root, provider, new Map(), options({ api }))).rejects.toThrow(
      'Google API 401',
    );
  });
});
