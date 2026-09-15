/**
 * The Google Calendar adapter: one event in, the files attached to it out
 * (MANUAL §1, §6, ticket 38).
 *
 * A calendar root is a recurring meeting. What it checks out is not the event —
 * there is no Markdown in a calendar — but the Drive files the calls leave
 * behind: the notes Gemini writes and the transcripts Meet saves, one per call,
 * attached to that call's instance of the series. So this module lists
 * (`events.get`, then `events.instances` for a series), decides where each
 * instance's attachments land, and hands the list to the Drive adapter's own
 * conversion (`convertWalk`), which is what makes an attachment a Doc of tabs,
 * an export or a binary exactly as a Drive root's file is. Nothing about
 * Markdown, assets, comments or sidecars lives here.
 *
 * A calendar root is read-only, always: `pushRoot` refuses, and the push planner
 * refuses before it ever gets here (MANUAL §7 step 3).
 */
import type { CredentialProvider } from '../auth/index.js';
import { convertWalk, driveMemory, type GDriveApi, gdriveApi } from '../gdrive/index.js';
import {
  type DriveKind,
  extensionFor,
  kindOf,
  type SkippedObject,
  type WalkedFile,
  walkedFile,
} from '../gdrive/walk.js';
import { GoogleApiError } from '../google-http.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import { assignNames, fileNameFor, isUnderRoot } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import type {
  FetchResult,
  FileChange,
  PushReport,
  SourceDescription,
  FetchOptions as SourceFetchOptions,
} from '../source.js';
import { calendarRef, formatSourceRef, type SourceRef, splitCalendarRef } from '../source-ref.js';
import { type CalendarApi, type CalendarEvent, createCalendarApi } from './api.js';

export interface FetchOptions extends SourceFetchOptions {
  /** The Drive API the attachments are read through. Tests pass a fake one. */
  api?: GDriveApi;
  /** The Calendar API. Tests pass a fake one; a real fetch passes nothing. */
  calendar?: CalendarApi;
  /** Handed to the real APIs when they are built. */
  fetch?: typeof fetch;
  /** Now: the end of the past, and a sidecar's `fetched:`. Default: the clock. */
  now?: () => Date;
}

/**
 * Fetches one calendar root: every past call that left a file behind, as a
 * directory of that call's attachments.
 */
export async function fetchRoot(
  root: Root,
  provider: CredentialProvider,
  previous: ReadonlyMap<string, IndexEntry> = new Map(),
  options: FetchOptions = {},
): Promise<FetchResult> {
  const drive = options.api ?? (await gdriveApi(provider, options.fetch));
  const calendar = options.calendar ?? (await calendarApi(provider, options.fetch));

  // Listing a calendar root is one read of the event, one page of instances per
  // 250 calls, and one `files.get` per attachment; nothing is downloaded yet
  // (MANUAL §7), so it is announced as a whole.
  const progress = options.progress ?? noop;
  progress(`listing ${root.path}`);

  const walked = await walkEvent(calendar, drive, root, previous, now(options));
  return convertWalk(walked, drive, root, previous, options);
}

/**
 * What one calendar root is, from the event's metadata (MANUAL §5).
 *
 * A series is a container — `docsync add` gives it `<series title>/` — and its
 * child count is the past calls that carry an attachment, which is what a
 * person wants to see before adding it. Nothing is downloaded.
 */
export async function describe(
  ref: SourceRef,
  provider: CredentialProvider,
  options: FetchOptions = {},
): Promise<SourceDescription> {
  const calendar = options.calendar ?? (await calendarApi(provider, options.fetch));
  const { event, instances } = await readEvent(calendar, ref, now(options));

  return {
    ref: await canonicalRef(ref, provider),
    title: event.summary ?? 'Untitled',
    kind: 'container',
    childCount: instances.filter((one) => attachmentsOf(one).length > 0).length,
    lastEditedTime: event.updated ?? '',
  };
}

/**
 * The paths under one calendar root whose source metadata has moved (MANUAL §5,
 * `docsync status`).
 *
 * The listing is the walk, as on Drive: instances, their attachments, and one
 * `files.get` each. A call that is new, an attachment that is new, and one that
 * is gone all count as moved; nothing is downloaded.
 */
export async function changedSince(
  root: Root,
  provider: CredentialProvider,
  previous: DocumentIndex,
  options: FetchOptions = {},
): Promise<string[]> {
  const drive = options.api ?? (await gdriveApi(provider, options.fetch));
  const calendar = options.calendar ?? (await calendarApi(provider, options.fetch));
  const walked = await walkEvent(calendar, drive, root, previous, now(options));
  const { before, directories } = driveMemory(previous);

  const changed: string[] = [];
  for (const file of walked.files) {
    const was = before.get(file.id);
    if (
      was === undefined ||
      was.lastEditedTime !== file.modifiedTime ||
      (file.md5Checksum !== undefined && was.md5 !== file.md5Checksum) ||
      // The same file under a new call is a new path, whatever its time says.
      (directories.has(file.id) ? `${file.path}/` : file.path) !== was.path
    ) {
      changed.push(directories.has(file.id) ? `${file.path}/` : file.path);
    }
  }

  const found = new Set(walked.files.map((file) => file.id));
  for (const entry of before.values()) {
    if (!found.has(entry.src.id) && isUnderRoot(root.path, entry.path)) changed.push(entry.path);
  }
  return [...new Set(changed)].sort();
}

/**
 * A calendar root is read-only, always (MANUAL §4, §7 step 3): the notes belong
 * to Gemini and there is nothing meaningful to write back. The push planner
 * refuses every change under such a root before a source is touched, in these
 * same words; this is the guard behind it.
 */
export async function pushRoot(
  root: Root,
  changes: readonly FileChange[],
  _provider: CredentialProvider,
  _index: DocumentIndex = new Map(),
): Promise<PushReport> {
  const path = changes[0]?.previousPath ?? changes[0]?.path ?? root.path;
  if (changes.length === 0) return [];
  throw new Error(
    `${path} is under a read-only root (${root.path}); nothing under it is pushed. ` +
      `Restore it with git checkout -- ${path}`,
  );
}

/** A progress hook that is not there. */
function noop(): void {}

/** The clock a fetch reads: the end of the past. */
function now(options: FetchOptions): Date {
  return options.now?.() ?? new Date();
}

/** The Calendar API a real fetch talks to. The credential is the Google one. */
async function calendarApi(
  provider: CredentialProvider,
  fetchImpl?: typeof fetch,
): Promise<CalendarApi> {
  return createCalendarApi(await provider.accessToken('calendar'), { fetch: fetchImpl });
}

/**
 * The event a ref names and the instances to check out: every occurrence that
 * has already started for a series, and the event itself for one that happens
 * once (ticket 38). Oldest first, so the directories sort by date.
 */
async function readEvent(
  api: CalendarApi,
  ref: SourceRef,
  at: Date,
): Promise<{ event: CalendarEvent; instances: CalendarEvent[] }> {
  const { eventId, calendarId } = splitCalendarRef(ref);
  const event = await withRef(ref, () => api.getEvent(calendarId, eventId));
  if (event.recurrence === undefined || event.recurrence.length === 0) {
    return { event, instances: [event] };
  }
  // Past calls only: the future has no notes (ticket 38).
  const instances = await withRef(ref, () =>
    api.instances(calendarId, eventId, { timeMax: at.toISOString() }),
  );
  return { event, instances: [...instances].sort((a, b) => startsAt(a) - startsAt(b)) };
}

/**
 * The event's attachments as the files of a checkout: one directory per
 * instance that has at least one to pull, and the attachments inside it under
 * their Drive titles (MANUAL §6).
 *
 * Nothing is downloaded — this is the calendar's answer to `walkRoot`, and
 * `convertWalk` does with it exactly what a Drive root's walk gets.
 */
async function walkEvent(
  calendar: CalendarApi,
  drive: GDriveApi,
  root: Root,
  previous: ReadonlyMap<string, IndexEntry>,
  at: Date,
): Promise<{ files: WalkedFile[]; skipped: SkippedObject[] }> {
  const { event, instances } = await readEvent(calendar, root.src, at);
  const { paths, directories } = driveMemory(previous);
  // A file root cannot name a container (MANUAL §4), so the path is a directory
  // whether or not the manifest spells the slash.
  const base = root.path.endsWith('/') ? root.path : `${root.path}/`;

  const files: WalkedFile[] = [];
  const skipped: SkippedObject[] = [];
  const taken = new Set<string>();

  for (const instance of instances) {
    const directory = uniqueName(instanceName(instance, event), taken);
    const attachments = attachmentsOf(instance);
    if (attachments.length === 0) continue;

    // One `files.get` per attachment: the modified time and the mime type are
    // what the Drive conversion decides everything else from.
    const found: { id: string; file: Awaited<ReturnType<GDriveApi['getFile']>> }[] = [];
    for (const attachment of attachments) {
      const id = attachment.fileId ?? '';
      const file = await drive.getFile(id).catch((error: unknown) => {
        // Only a file that is not there is "gone": an expired token or a
        // network failure must fail the fetch, or every attachment would turn
        // into a deletion in the checkout.
        if (error instanceof GoogleApiError && error.status === 404) return undefined;
        throw error;
      });
      if (file === undefined) {
        // The file behind the attachment is gone for good. A deletion in the
        // checkout, said out loud rather than failing the whole fetch.
        skipped.push({
          id,
          title: attachment.title ?? id,
          path: `${base}${directory}/${fileNameFor(attachment.title ?? id, '')}`,
          reason: 'gone',
        });
        continue;
      }
      if (isRecording(file.mimeType) || isRecording(attachment.mimeType)) {
        // Meet recordings are hundreds of megabytes and not text (ticket 38).
        skipped.push({
          id,
          title: file.name,
          path: `${base}${directory}/${fileNameFor(file.name, '')}`,
          reason: 'recording',
        });
        continue;
      }
      found.push({ id, file });
    }

    const kinds = new Map<string, DriveKind | undefined>(
      found.map((one) => [one.id, kindOf(one.file.mimeType)]),
    );
    const names = assignNames(
      found.map((one) => ({
        id: one.id,
        title: one.file.name,
        // A Doc of several tabs is a directory, so it is named like one, as it
        // is under a Drive root (MANUAL §6, ticket 37).
        ext: directories.has(one.id) ? '' : extensionFor(one.file, kinds.get(one.id)),
      })),
      namesIn(paths, `${base}${directory}/`),
    );

    for (const one of found) {
      const path = `${base}${directory}/${names.get(one.id) ?? fileNameFor(one.file.name, '')}`;
      const kind = kinds.get(one.id);
      if (kind === undefined) {
        // A form, a site, a shortcut: nothing to download and nothing to export.
        skipped.push({ id: one.id, title: one.file.name, path, reason: 'unsupported' });
        continue;
      }
      files.push(walkedFile(one.file, kind, path));
    }
  }
  return { files, skipped };
}

/** The attachments of one instance that are Drive files, each one once. */
function attachmentsOf(instance: CalendarEvent): NonNullable<CalendarEvent['attachments']> {
  const seen = new Set<string>();
  return (instance.attachments ?? []).filter((attachment) => {
    const id = attachment.fileId;
    if (id === undefined || id === '' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Whether an attachment is a recording rather than something to read. */
function isRecording(mimeType: string | undefined): boolean {
  return mimeType?.startsWith('video/') === true || mimeType?.startsWith('audio/') === true;
}

/**
 * What one call's directory is called: when it started, in the event's own time
 * zone, and the instance's title (MANUAL §6, ticket 38). The stamp sorts the
 * calls by date; an all-day call has no time to print.
 */
function instanceName(instance: CalendarEvent, event: CalendarEvent): string {
  const title = instance.summary ?? event.summary ?? 'Untitled';
  const start = instance.start ?? {};
  // `dateTime` carries the event's own offset, so its own wall clock is the
  // text itself: `2026-09-01T09:00:00+02:00` is nine in the morning in Prague.
  const stamp =
    start.dateTime !== undefined
      ? `${start.dateTime.slice(0, 10)} ${start.dateTime.slice(11, 16).replace(':', '-')}`
      : (start.date ?? '');
  return fileNameFor(stamp === '' ? title : `${stamp} ${title}`, '');
}

/** When an instance starts, for ordering. */
function startsAt(instance: CalendarEvent): number {
  const at = Date.parse(instance.start?.dateTime ?? instance.start?.date ?? '');
  return Number.isNaN(at) ? 0 : at;
}

/** A directory name no other call of this fetch has taken (MANUAL §6). */
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
  taken.add(name.toLowerCase());
  return name;
}

/** The names the files of one directory had at the last fetch, by file id. */
function namesIn(
  previous: ReadonlyMap<string, string>,
  directory: string,
): Map<string, string> | undefined {
  const names = new Map<string, string>();
  for (const [id, path] of previous) {
    const cut = path.lastIndexOf('/') + 1;
    if (path.slice(0, cut) === directory) names.set(id, path.slice(cut));
  }
  return names.size === 0 ? undefined : names;
}

/**
 * The ref as the source canonicalises it: the calendar is dropped when it is
 * the signed-in identity's own, since that is what `primary` means and what
 * keeps the ref short (ticket 38).
 */
async function canonicalRef(ref: SourceRef, provider: CredentialProvider): Promise<SourceRef> {
  const { eventId, calendarId } = splitCalendarRef(ref);
  const email = await provider.identity('calendar').then(
    (identity) => identity.email,
    () => undefined,
  );
  return calendarRef(eventId, calendarId === email ? 'primary' : calendarId);
}

/** Whatever the API said, with the ref it was asked about (ticket 38). */
async function withRef<T>(ref: SourceRef, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${formatSourceRef(ref)}: ${message}`, { cause: error });
  }
}

export type { CalendarApi, CalendarEvent, EventAttachment } from './api.js';
export { CALENDAR_ENDPOINT, createCalendarApi, SCOPE_REFUSED } from './api.js';
