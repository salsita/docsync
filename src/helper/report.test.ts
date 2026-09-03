import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createReportWriter,
  FETCH_REPORT,
  type FetchReport,
  PUSH_REPORT,
  type PushReportFile,
  REPORT_DIR,
  readFetchReport,
  readPushReport,
  writeFetchReport,
  writePushReport,
} from './report.js';

const made: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docsync-report-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fetchReport: FetchReport = {
  at: '2026-09-03T10:12:00.000Z',
  changed: [
    {
      path: 'Specs/Auth.md',
      lastEditedTime: '2026-09-03T10:00:00.000Z',
      editor: { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' },
    },
    { path: 'Files/logo.png', lastEditedTime: '2026-09-03T09:00:00.000Z' },
  ],
  skipped: [{ id: 'db', title: 'Tasks', path: 'Specs/Tasks', reason: 'database' }],
};

const pushReport: PushReportFile = {
  at: '2026-09-03T10:12:00.000Z',
  documents: [{ path: 'Specs/Auth.md', title: 'Auth', action: 'updated' }],
  skipped: [],
};

describe('the report files', () => {
  it('writes the fetch report where the CLI looks for it', async () => {
    const gitDir = temp();
    await writeFetchReport(gitDir, fetchReport);

    const raw = readFileSync(join(gitDir, REPORT_DIR, FETCH_REPORT), 'utf8');
    expect(JSON.parse(raw)).toEqual(fetchReport);
    expect(raw.endsWith('\n')).toBe(true);
    expect(await readFetchReport(gitDir)).toEqual(fetchReport);
  });

  it('writes the push report beside it', async () => {
    const gitDir = temp();
    await writePushReport(gitDir, pushReport);

    expect(JSON.parse(readFileSync(join(gitDir, REPORT_DIR, PUSH_REPORT), 'utf8'))).toEqual(
      pushReport,
    );
    expect(await readPushReport(gitDir)).toEqual(pushReport);
  });

  it('answers undefined when there is no report yet', async () => {
    const gitDir = temp();

    expect(await readFetchReport(gitDir)).toBeUndefined();
    expect(await readPushReport(gitDir)).toBeUndefined();
  });

  it('answers undefined for a report that is not JSON', async () => {
    const gitDir = temp();
    await writeFetchReport(gitDir, fetchReport);
    writeFileSync(join(gitDir, REPORT_DIR, FETCH_REPORT), 'not json');

    expect(await readFetchReport(gitDir)).toBeUndefined();
  });

  it('never fails a run because a report could not be written', async () => {
    const gitDir = join(temp(), 'file');
    writeFileSync(gitDir, 'not a directory');

    await expect(writeFetchReport(gitDir, fetchReport)).resolves.toBeUndefined();
    expect(await readFetchReport(gitDir)).toBeUndefined();
  });

  it('hands the helper one writer for both reports', async () => {
    const gitDir = temp();
    const writer = createReportWriter(gitDir);
    await writer.fetch(fetchReport);
    await writer.push(pushReport);

    expect(await readFetchReport(gitDir)).toEqual(fetchReport);
    expect(await readPushReport(gitDir)).toEqual(pushReport);
  });
});
