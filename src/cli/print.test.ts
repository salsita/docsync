// Every time in this file is formatted for the terminal's own zone; pinning it
// is what makes the expectations below the same on a laptop and in CI.
process.env.TZ = 'UTC';

import { describe, expect, it } from 'vitest';
import type { PushPlan } from '../helper/changes.js';
import type { FetchReport, PushReportFile } from '../helper/report.js';
import type { Root } from '../manifest/types.js';
import {
  COMMAND_REFERENCE,
  formatFetchReport,
  formatPushPreview,
  formatPushReport,
  formatResolved,
  formatStatusLine,
  formatTime,
} from './print.js';

const ADA = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };

const fetched = (over: Partial<FetchReport> = {}): FetchReport => ({
  at: '2026-09-03T10:12:00Z',
  changed: [],
  skipped: [],
  ...over,
});

const pushed = (over: Partial<PushReportFile> = {}): PushReportFile => ({
  at: '2026-09-03T10:12:00Z',
  documents: [],
  skipped: [],
  ...over,
});

describe('formatTime', () => {
  it('prints a source time to the minute', () => {
    expect(formatTime('2026-09-03T10:12:34.000Z')).toBe('2026-09-03 10:12');
  });

  it('says so when the source gave no usable time', () => {
    expect(formatTime('')).toBe('unknown');
    expect(formatTime('not a time')).toBe('unknown');
  });
});

describe('formatFetchReport', () => {
  it('prints one line per changed document, with who changed it', () => {
    const out = formatFetchReport(
      fetched({
        changed: [
          { path: 'Specs/Auth.md', lastEditedTime: '2026-09-03T10:00:00Z', editor: ADA },
          { path: 'Files/logo.png', lastEditedTime: '2026-09-03T09:30:00Z' },
        ],
      }),
    );

    expect(out).toBe(
      [
        'Specs/Auth.md   by Ada Lovelace  2026-09-03 10:00',
        'Files/logo.png                   2026-09-03 09:30',
      ].join('\n'),
    );
  });

  it('falls back to the editor id when the source gave no name', () => {
    const out = formatFetchReport(
      fetched({
        changed: [{ path: 'a.md', lastEditedTime: '2026-09-03T10:00:00Z', editor: { id: 'u-42' } }],
      }),
    );

    expect(out).toBe('a.md  by u-42  2026-09-03 10:00');
  });

  it('marks a document the converter re-rendered rather than the source (§7)', () => {
    const out = formatFetchReport(
      fetched({
        changed: [
          { path: 'Specs/Auth.md', lastEditedTime: '2026-09-03T10:00:00Z', editor: ADA },
          {
            path: 'Specs/Old.md',
            lastEditedTime: '2025-01-04T08:00:00Z',
            editor: ADA,
            reRendered: true,
          },
        ],
      }),
    );

    expect(out.split('\n')).toEqual([
      'Specs/Auth.md  by Ada Lovelace  2026-09-03 10:00',
      'Specs/Old.md   by Ada Lovelace  2025-01-04 08:00  (re-rendered)',
    ]);
  });

  it('says when nothing moved at the source', () => {
    expect(formatFetchReport(fetched())).toBe('No documents changed at the source.');
  });

  it('lists what the source left out under its own heading', () => {
    const out = formatFetchReport(
      fetched({
        skipped: [
          { id: 'db', title: 'Tasks', path: 'Specs/Tasks', reason: 'database' },
          { id: 'x', title: 'Old', path: 'Specs/Old.md', reason: 'ignored' },
        ],
      }),
    );

    expect(out).toBe(
      [
        'No documents changed at the source.',
        '',
        'Not checked out:',
        '  Specs/Tasks   database',
        '  Specs/Old.md  ignored',
      ].join('\n'),
    );
  });

  it('says nothing at all when there is no report to read', () => {
    expect(formatFetchReport(undefined)).toBe('');
  });
});

describe('formatPushReport', () => {
  it('prints what happened to each document, action first', () => {
    const out = formatPushReport(
      pushed({
        documents: [
          { path: 'Specs/New.md', title: 'New', action: 'created' },
          { path: 'Specs/Auth.md', title: 'Auth', action: 'updated' },
          { path: 'Specs/Moved.md', title: 'Moved', action: 'renamed' },
        ],
      }),
    );

    expect(out).toBe(
      ['created  Specs/New.md', 'updated  Specs/Auth.md', 'renamed  Specs/Moved.md'].join('\n'),
    );
  });

  it('says how much of a patched document the push touched', () => {
    const out = formatPushReport(
      pushed({
        documents: [
          {
            path: 'Specs/Auth.md',
            title: 'Auth',
            action: 'updated',
            blocks: { kept: 41, updated: 2, inserted: 1, deleted: 0 },
          },
          {
            path: 'Specs/One.md',
            title: 'One',
            action: 'updated',
            blocks: { kept: 3, updated: 1, inserted: 0, deleted: 0 },
            suggestions: ['suggest.abc', 'suggest.def'],
          },
        ],
      }),
    );

    expect(out).toBe(
      [
        'updated  Specs/Auth.md  (3 blocks changed, 41 kept)',
        'updated  Specs/One.md   (1 block changed, 3 kept)',
        '  Specs/One.md: wrote over 2 pending suggestions (suggest.abc, suggest.def)',
      ].join('\n'),
    );
  });

  it('puts the trashed documents last, under a heading of their own', () => {
    const out = formatPushReport(
      pushed({
        documents: [
          { path: 'Files/logo.png', title: 'logo.png', action: 'trashed' },
          { path: 'Specs/Auth.md', title: 'Auth', action: 'updated' },
        ],
      }),
    );

    expect(out).toBe(['updated  Specs/Auth.md', '', 'Trashed:', '  Files/logo.png'].join('\n'));
  });

  it('prints a push that only trashed documents', () => {
    const out = formatPushReport(
      pushed({
        documents: [
          { path: 'a.md', title: 'a', action: 'trashed' },
          { path: 'b.md', title: 'b', action: 'trashed' },
        ],
      }),
    );

    expect(out).toBe(['Trashed:', '  a.md', '  b.md'].join('\n'));
  });

  it('prints an empty push', () => {
    expect(formatPushReport(pushed())).toBe('No documents changed at the source.');
    expect(formatPushReport(undefined)).toBe('');
  });

  it('lists what the post-push fetch left out', () => {
    const out = formatPushReport(
      pushed({
        documents: [{ path: 'a.md', title: 'a', action: 'updated' }],
        skipped: [{ id: 'db', title: 'Tasks', path: 'Specs/Tasks', reason: 'database' }],
      }),
    );

    expect(out).toBe(
      ['updated  a.md', '', 'Not checked out:', '  Specs/Tasks  database'].join('\n'),
    );
  });
});

describe('formatStatusLine', () => {
  const root: Root = {
    src: { source: 'notion', id: '2f3a9c00000000000000000000000000' },
    path: 'Product Specs/',
    ignore: [],
  };

  it('prints the root, its path, the last fetch and what moved since', () => {
    expect(formatStatusLine(root, '2026-09-03T10:12:00Z', 3)).toBe(
      'notion:2f3a…  Product Specs/  fetched 2026-09-03 10:12  3 changed at source',
    );
  });

  it('counts one document in the singular', () => {
    expect(formatStatusLine(root, '2026-09-03T10:12:00Z', 1)).toContain('1 changed at source');
  });

  it('says a root is up to date rather than counting to zero', () => {
    expect(formatStatusLine(root, '2026-09-03T10:12:00Z', 0)).toBe(
      'notion:2f3a…  Product Specs/  fetched 2026-09-03 10:12  up to date',
    );
  });

  it('says `comments on` for a root that pulls the sidecars (MANUAL §4)', () => {
    expect(formatStatusLine({ ...root, comments: true }, '2026-09-03T10:12:00Z', 0)).toBe(
      'notion:2f3a…  Product Specs/  fetched 2026-09-03 10:12  up to date  comments on',
    );
  });

  it('says nothing about comments on a root that leaves them off', () => {
    expect(formatStatusLine({ ...root, comments: false }, '2026-09-03T10:12:00Z', 0)).not.toContain(
      'comments',
    );
  });

  it('says `read-only` for a root a push may not touch (MANUAL §4)', () => {
    expect(formatStatusLine({ ...root, readOnly: true }, '2026-09-03T10:12:00Z', 0)).toBe(
      'notion:2f3a…  Product Specs/  fetched 2026-09-03 10:12  up to date  read-only',
    );
    expect(
      formatStatusLine({ ...root, comments: true, readOnly: true }, '2026-09-03T10:12:00Z', 0),
    ).toBe(
      'notion:2f3a…  Product Specs/  fetched 2026-09-03 10:12  up to date  comments on  read-only',
    );
  });

  it('says nothing about read-only on a root that is pushed to', () => {
    expect(formatStatusLine({ ...root, readOnly: false }, '2026-09-03T10:12:00Z', 0)).not.toContain(
      'read-only',
    );
  });

  it('says when the source could not be reached', () => {
    expect(formatStatusLine(root, undefined, undefined)).toBe(
      'notion:2f3a…  Product Specs/  fetched unknown  not checked',
    );
  });
});

describe('formatPushPreview', () => {
  const root: Root = {
    src: { source: 'notion', id: '2f3a9c00000000000000000000000000' },
    path: 'Specs/',
    ignore: [],
  };
  const preview = (over: Partial<PushPlan> = {}): PushPlan => ({
    roots: [],
    refusals: [],
    ignored: [],
    ...over,
  });

  it('names every file with the push report’s verbs (MANUAL §7 step 5)', () => {
    const plan = preview({
      roots: [
        {
          root,
          changes: [
            { kind: 'added', path: 'Specs/New.md', text: 'new\n' },
            { kind: 'modified', path: 'Specs/Auth.md', text: 'edited\n' },
            { kind: 'renamed', path: 'Specs/Login.md', previousPath: 'Specs/Old.md' },
            { kind: 'renamed', path: 'Specs/Two.md', previousPath: 'Specs/One.md', text: 'x\n' },
            { kind: 'deleted', path: 'Specs/Gone.md' },
          ],
        },
      ],
    });
    expect(formatPushPreview(plan, 0)).toBe(
      [
        'To push:',
        '  create  Specs/New.md',
        '  update  Specs/Auth.md',
        '  rename  Specs/Old.md -> Specs/Login.md',
        // A rename that also carried an edit is both (MANUAL §7 step 5).
        '  rename  Specs/One.md -> Specs/Two.md',
        '  update  Specs/Two.md',
        '  trash   Specs/Gone.md',
      ].join('\n'),
    );
  });

  it('lists what the push would ignore and every path it would refuse', () => {
    const plan = preview({
      ignored: ['README.md'],
      refusals: [
        {
          path: 'Inputs/Brief.md',
          reason: 'under read-only root Inputs/',
          message: 'Inputs/Brief.md is under a read-only root (Inputs/); …',
        },
        {
          path: 'Specs/Auth.comments.md',
          reason: 'read-only; comments are only pulled in this version',
          message: 'Specs/Auth.comments.md is read-only; …',
        },
      ],
    });
    expect(formatPushPreview(plan, 0)).toBe(
      [
        'To push:',
        '  ignored  README.md',
        '  refused  Inputs/Brief.md: under read-only root Inputs/',
        '  refused  Specs/Auth.comments.md: read-only; comments are only pulled in this version',
      ].join('\n'),
    );
  });

  it('closes with the uncommitted changes it did not list (the owner’s question)', () => {
    const plan = preview({ ignored: ['README.md'] });
    expect(formatPushPreview(plan, 2)).toContain('(2 uncommitted changes are not pushed)');
    expect(formatPushPreview(plan, 1)).toContain('(1 uncommitted change is not pushed)');
  });

  it('says nothing at all when there is nothing to push', () => {
    expect(formatPushPreview(preview(), 0)).toBe('');
  });
});

describe('formatResolved', () => {
  it('prints the description as a short table', () => {
    const out = formatResolved({
      ref: { source: 'notion', id: '2f3a9c00000000000000000000000000' },
      title: 'Product Specs',
      kind: 'leaf',
      childCount: 3,
      editor: ADA,
      lastEditedTime: '2026-09-03T10:12:00Z',
    });

    expect(out).toBe(
      [
        'ref       notion:2f3a9c00000000000000000000000000',
        'type      document',
        'title     Product Specs',
        'children  3',
        'editor    Ada Lovelace <ada@example.com>',
        'edited    2026-09-03 10:12',
      ].join('\n'),
    );
  });

  it('leaves out the editor when the source named none', () => {
    const out = formatResolved({
      ref: { source: 'gdocs', id: '1AbCdE' },
      title: 'Roadmap',
      kind: 'leaf',
      childCount: 0,
      ext: '.md',
      lastEditedTime: '2026-09-03T10:12:00Z',
    });

    expect(out.split('\n')).toEqual([
      'ref       gdocs:1AbCdE',
      'type      document',
      'title     Roadmap',
      'children  0',
      'edited    2026-09-03 10:12',
    ]);
  });
});

describe('COMMAND_REFERENCE', () => {
  it('is the block of MANUAL §13, which is what --help prints', () => {
    expect(COMMAND_REFERENCE).toBe(
      [
        'docsync init    [<dir>] [<src>[=<path>]...]',
        'docsync add     <src>[=<path>]... [--no-fetch]',
        'docsync remove  <path>...',
        'docsync status',
        'docsync fetch   [--all]',
        'docsync pull    [--all]',
        'docsync push',
        'docsync resolve <src>',
        'docsync auth    <source> [--logout]',
        'docsync --version',
      ].join('\n'),
    );
  });
});
