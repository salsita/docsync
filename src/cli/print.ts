/**
 * Everything the CLI prints that is not git's own output (MANUAL §5, §13).
 *
 * Pure functions over the report files the helper leaves behind and over what
 * `describe` and `changedSince` answer: a report shape in, the block of text
 * out. Nothing here reads a file, spawns git or knows what a command is, which
 * is what lets every format be tested as a value.
 */
import type { PushPlan } from '../helper/changes.js';
import type { FetchReport, PushReportFile } from '../helper/report.js';
import type { Root } from '../manifest/types.js';
import type { PushedDocument, SkippedObject, SourceDescription } from '../source.js';
import { formatSourceRef } from '../source-ref.js';

/** MANUAL §13, verbatim: the usage block `docsync --help` prints. */
export const COMMAND_REFERENCE = [
  'docsync init    [<dir>] [<src>[=<path>]...]',
  'docsync add     <src>[=<path>]... [--no-fetch] [--readonly] [--suggest]',
  'docsync remove  <path>...',
  'docsync status',
  'docsync fetch   [--all]',
  'docsync pull    [--all]',
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
          report.changed.map((one) => [
            one.path,
            editorName(one),
            formatTime(one.lastEditedTime),
            // Nobody edited it: the conversion changed and a re-fetch picked
            // it up, so the editor and the time beside it are older news than
            // the change itself (MANUAL §7).
            ...(one.reRendered === true ? ['(re-rendered)'] : []),
          ]),
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

  // A pending suggestion inside an edited paragraph was written over as plain
  // text (MANUAL §7); the ids are what lets someone find it in the Doc's
  // history.
  // A file the source would not take is named, so nobody has to guess which
  // of a document's attachments did not arrive (MANUAL §12 phase 2).
  for (const one of report.documents) {
    for (const file of one.skippedFiles ?? []) {
      lines.push(`  ${file.path}: not uploaded — ${file.reason}`);
    }
  }

  for (const one of rest) {
    if (one.suggestions !== undefined && one.suggestions.length > 0) {
      lines.push(
        `  ${one.path}: wrote over ${plural(one.suggestions.length, 'pending suggestion')} ` +
          `(${one.suggestions.join(', ')})`,
      );
    }
  }

  // Nothing was written to a suggested document, so the file is the source's
  // text again as soon as the post-push fetch lands (MANUAL §7).
  if (rest.some((one) => one.action === 'suggested')) {
    lines.push(
      '  Suggestions are waiting for review in Docs; your files are back to the source text',
      '  until they are accepted.',
    );
  }

  if (trashed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Trashed:', ...trashed.map((one) => `  ${one.path}`));
  }
  return [...lines, ...skippedBlock(report.skipped)].join('\n');
}

/**
 * One document's line. An update that was applied as a patch says how much of
 * the document it touched, which is the proof that the rest was left alone
 * (MANUAL §7).
 */
function actionRow(document: PushedDocument): string[] {
  const blocks = document.blocks;
  // Files the source now hosts itself (MANUAL §12 phase 2).
  const files =
    document.uploaded === undefined || document.uploaded === 0
      ? ''
      : `uploaded ${plural(document.uploaded, 'file')}`;
  if (blocks === undefined) {
    return files === ''
      ? [document.action, document.path]
      : [document.action, document.path, `(${files})`];
  }
  const changed = blocks.updated + blocks.inserted + blocks.deleted;
  const counts = `${plural(changed, 'block')} changed, ${blocks.kept} kept`;
  // A suggesting push wrote nothing to the body, so what it did is counted in
  // suggestions first, when the API said how many, and blocks after (MANUAL §7).
  const made =
    document.action === 'suggested' && (document.suggested ?? 0) > 0
      ? `${plural(document.suggested ?? 0, 'suggestion')}, `
      : '';
  return [document.action, document.path, `(${made}${counts}${files === '' ? '' : `, ${files}`})`];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The `To push:` section of `docsync status`: what `docsync push` would do to
 * real documents, said in the push report's verbs (MANUAL §5, §7 steps 2 to 4).
 *
 * The plan is the one `push` itself computes, over the same diff, so the
 * preview cannot drift from the push. A rename that also carried an edit is
 * both lines, in that order. `uncommitted` is what `git status --porcelain`
 * counted: those changes are not in the list, and saying so is the whole point
 * of the closing line. Nothing at all when there is nothing to say.
 */
export function formatPushPreview(plan: PushPlan, uncommitted: number): string {
  const rows: string[][] = [];
  for (const { root, changes } of plan.roots) {
    // Under a suggest root an edit is sent as suggestions, never written over
    // the document, and the preview says which of the two it is (MANUAL §4).
    const edit = root.suggest === true ? 'suggest' : 'update';
    for (const change of changes) {
      if (change.kind === 'added') rows.push(['create', change.path]);
      else if (change.kind === 'modified') rows.push([edit, change.path]);
      else if (change.kind === 'deleted') rows.push(['trash', change.path]);
      else {
        rows.push(['rename', `${change.previousPath} -> ${change.path}`]);
        // A rename that carried an edit updates the document too (§7 step 5).
        if (change.text !== undefined || change.bytes !== undefined) {
          rows.push([edit, change.path]);
        }
      }
    }
  }
  // Under no root: a local file. The push lands it on `main` and sends nothing
  // to any source (§7 step 3, ticket 35).
  for (const path of plan.local) rows.push(['local', path]);
  for (const one of plan.refusals) rows.push(['refused', `${one.path}: ${one.reason}`]);

  if (rows.length === 0 && uncommitted === 0) return '';
  const lines = columns(rows).map((line) => `  ${line}`);
  if (uncommitted > 0) {
    lines.push(
      `  (${plural(uncommitted, 'uncommitted change')} ${uncommitted === 1 ? 'is' : 'are'} not pushed)`,
    );
  }
  return ['To push:', ...lines].join('\n');
}

/**
 * One root's line under `git status` (MANUAL §5): what it is, where it is,
 * when it was last fetched, and how much of it has moved at the source since.
 * `changed` is undefined when the source could not be asked. A root that pulls
 * comment sidecars says so, since that is what its fetches cost, and a
 * read-only root says so, since that is what a push will refuse (MANUAL §4).
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
    ...(root.comments === true ? ['comments on'] : []),
    ...(root.readOnly === true ? ['read-only'] : []),
    ...(root.suggest === true ? ['suggest'] : []),
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
    ['type', resolved.kind === 'container' ? 'folder' : 'document'],
    ['title', resolved.title],
    ['children', String(resolved.childCount)],
    ...(who === undefined ? [] : [['editor', who]]),
    ['edited', formatTime(resolved.lastEditedTime)],
  ]).join('\n');
}
