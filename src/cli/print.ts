/**
 * Everything the CLI prints that is not git's own output (MANUAL §5, §13).
 *
 * Pure functions over the report files the helper leaves behind and over what
 * `describe` and `changedSince` answer: a report shape in, the block of text
 * out. Nothing here reads a file, spawns git or knows what a command is, which
 * is what lets every format be tested as a value.
 */
import type { FetchReport, PushReportFile } from '../helper/report.js';
import type { Root } from '../manifest/types.js';
import type { PushedDocument, SkippedObject, SourceDescription } from '../source.js';
import { formatSourceRef } from '../source-ref.js';

/** MANUAL §13, verbatim: the usage block `docsync --help` prints. */
export const COMMAND_REFERENCE = [
  'docsync init    [<dir>] [<src>[=<path>]...]',
  'docsync add     <src>[=<path>]... [--no-fetch]',
  'docsync remove  <path>...',
  'docsync status',
  'docsync fetch',
  'docsync pull',
  'docsync push',
  'docsync resolve <src>',
  'docsync auth    <source> [--logout]',
  'docsync --version',
].join('\n');

const NOTHING = 'No documents changed at the source.';

/** A source time as the terminal shows it: to the minute, in the local zone. */
export function formatTime(iso: string | undefined): string {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const when = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** Rows as columns, every column but the last padded to its widest cell. */
function columns(rows: readonly (readonly string[])[], gap = '  '): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, at) => {
      // The last cell of a row never sets a width: nothing follows it to align.
      if (at === row.length - 1) return;
      widths[at] = Math.max(widths[at] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, at) => (at === row.length - 1 ? cell : cell.padEnd(widths[at] ?? 0)))
      .join(gap)
      .trimEnd(),
  );
}

/** Who edited a document, as one cell. */
function editorName(document: { editor?: { id: string; name?: string } }): string {
  const editor = document.editor;
  return editor === undefined ? '' : `by ${editor.name ?? editor.id}`;
}

/** The `Not checked out:` block, or nothing when the source left nothing out. */
function skippedBlock(skipped: readonly SkippedObject[]): string[] {
  if (skipped.length === 0) return [];
  return [
    '',
    'Not checked out:',
    ...columns(skipped.map((one) => [one.path, one.reason])).map((line) => `  ${line}`),
  ];
}

/**
 * What `docsync fetch` and `docsync pull` print: one line per changed
 * document, and what the source left out (MANUAL §5).
 */
export function formatFetchReport(report: FetchReport | undefined): string {
  if (report === undefined) return '';
  const changed =
    report.changed.length === 0
      ? [NOTHING]
      : columns(
          report.changed.map((one) => [one.path, editorName(one), formatTime(one.lastEditedTime)]),
        );
  return [...changed, ...skippedBlock(report.skipped)].join('\n');
}

/**
 * What `docsync push` prints: what happened to each document, with the trashed
 * ones last under their own heading, because a deletion at the source is the
 * one thing a review should not scroll past (MANUAL §8).
 */
export function formatPushReport(report: PushReportFile | undefined): string {
  if (report === undefined) return '';
  const trashed = report.documents.filter((one) => one.action === 'trashed');
  const rest = report.documents.filter((one) => one.action !== 'trashed');

  const lines: string[] = [];
  if (rest.length > 0) lines.push(...columns(rest.map(actionRow)));
  else if (trashed.length === 0) lines.push(NOTHING);

  if (trashed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Trashed:', ...trashed.map((one) => `  ${one.path}`));
  }
  return [...lines, ...skippedBlock(report.skipped)].join('\n');
}

function actionRow(document: PushedDocument): string[] {
  return [document.action, document.path];
}

/**
 * One root's line under `git status` (MANUAL §5): what it is, where it is,
 * when it was last fetched, and how much of it has moved at the source since.
 * `changed` is undefined when the source could not be asked.
 */
export function formatStatusLine(
  root: Root,
  fetchedAt: string | undefined,
  changed: number | undefined,
): string {
  const moved =
    changed === undefined
      ? 'not checked'
      : changed === 0
        ? 'up to date'
        : `${changed} changed at source`;
  return [
    `${root.src.source}:${root.src.id.slice(0, 4)}…`,
    root.path,
    `fetched ${formatTime(fetchedAt)}`,
    moved,
  ].join('  ');
}

/** What `docsync resolve` prints: the description as a short table (MANUAL §5). */
export function formatResolved(resolved: SourceDescription): string {
  const editor = resolved.editor;
  const who =
    editor === undefined
      ? undefined
      : editor.email === undefined
        ? (editor.name ?? editor.id)
        : `${editor.name ?? editor.id} <${editor.email}>`;

  return columns([
    ['ref', formatSourceRef(resolved.ref)],
    ['type', resolved.kind],
    ['title', resolved.title],
    ['children', String(resolved.childCount)],
    ...(who === undefined ? [] : [['editor', who]]),
    ['edited', formatTime(resolved.lastEditedTime)],
  ]).join('\n');
}
