/**
 * An in-memory document store that speaks `Source`, for the helper's tests.
 *
 * It holds pages, Docs, files and exports as one flat table of objects with a
 * parent each, lays them out under a root the way the real adapters do
 * (MANUAL §6: a document is `<title>.md`, a file keeps its name, children go
 * in a directory named after their parent), reports `changed` against the
 * previous index by id, and records every `pushRoot` call verbatim so that a
 * test can assert on exactly what reached the adapter.
 *
 * State lives behind a `FakeStore`: a `Map` for in-process tests, a JSON file
 * for the end-to-end ones, where the helper runs in a process git spawned and
 * the test wants to seed and inspect the same store from outside.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { CredentialProvider } from '../auth/index.js';
import { sidecarPathOf } from '../comments/format.js';
import { parseDocument, serializeDocument } from '../frontmatter.js';
import type { DocumentIndex, Editor, IndexEntry } from '../index-file.js';
import { isUnderRoot } from '../manifest/index.js';
import type { Root } from '../manifest/types.js';
import { stringifyMarkdown } from '../markdown.js';
import { PushError } from '../push-types.js';
import type {
  FetchedFile,
  FetchResult,
  FileChange,
  ProgressOptions,
  PushReport,
  Source,
  SourceDescription,
  SourceName,
  SourceRegistry,
} from '../source.js';
import type { SourceRef } from '../source-ref.js';

export type FakeKind = 'page' | 'doc' | 'folder' | 'file' | 'export';

export interface FakeObject {
  id: string;
  source: SourceName;
  kind: FakeKind;
  /** A document's title; a file's or export's full name, extension included. */
  title: string;
  /** The id of the page or folder this sits in. Absent for a top-level object. */
  parent?: string;
  /** A page's or Doc's Markdown body, canonical. */
  body?: string;
  /** A file's or export's bytes, base64. */
  bytes?: string;
  lastEditedTime: string;
  editor?: Editor;
  trashed?: boolean;
  /**
   * The comment sidecar this document owes, as its whole text (MANUAL §6).
   * Absent when it has no open thread, which is when there is no file at all.
   * A comment moves no last-edit time, so this is answered on every fetch
   * whether the document changed or not — and only on a root whose `comments`
   * is on (MANUAL §4).
   */
  comments?: string;
}

/** One `pushRoot` call, as the fake received it. Bytes are base64. */
export interface RecordedPush {
  root: string;
  changes: {
    kind: FileChange['kind'];
    path: string;
    previousPath?: string;
    text?: string;
    bytes?: string;
  }[];
}

export interface FakeState {
  objects: Record<string, FakeObject>;
  pushes: RecordedPush[];
  /** Ticks, so that every write gets a later `lastEditedTime` than the last. */
  clock: number;
}

export interface FakeStore {
  load(): FakeState;
  save(state: FakeState): void;
}

/** Who the fake credits with every push. */
export const PUSHER: Editor = { id: 'pusher', name: 'Push Er', email: 'pusher@example.com' };

const EPOCH = Date.parse('2026-03-01T12:00:00Z');

export const emptyState = (): FakeState => ({ objects: {}, pushes: [], clock: 0 });

/** The time `clock` ticks stand for. */
export function timeAt(clock: number): string {
  return new Date(EPOCH + clock * 60_000).toISOString();
}

export function createMemoryStore(initial: FakeState = emptyState()): FakeStore {
  let state = structuredClone(initial);
  return {
    load: () => structuredClone(state),
    save: (next) => {
      state = structuredClone(next);
    },
  };
}

/** A store in one JSON file, made on first save. */
export function createFileStore(path: string): FakeStore {
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as FakeState;
      } catch {
        return emptyState();
      }
    },
    save: (state) => writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`),
  };
}

/** A well-formed id for either source, from a small number. */
export function fakeId(source: SourceName, n: number): string {
  return source === 'notion'
    ? n.toString(16).padStart(32, '0')
    : `1Fake${n.toString().padStart(20, '0')}`;
}

/** Adds an object to a state in place, filling in the time. */
export function addObject(
  state: FakeState,
  object: Omit<FakeObject, 'lastEditedTime'> & { lastEditedTime?: string },
): FakeObject {
  state.clock += 1;
  const full: FakeObject = { lastEditedTime: timeAt(state.clock), ...object };
  state.objects[full.id] = full;
  return full;
}

/** Changes a document's body in place, as an edit at the source would. */
export function editObject(state: FakeState, id: string, patch: Partial<FakeObject>): void {
  const object = state.objects[id];
  if (object === undefined) throw new Error(`no fake object ${id}`);
  state.clock += 1;
  Object.assign(object, patch, { lastEditedTime: timeAt(state.clock) });
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

function fileName(object: FakeObject): string {
  return object.kind === 'page' || object.kind === 'doc' ? `${object.title}.md` : object.title;
}

function stem(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function typeOf(object: FakeObject): IndexEntry['type'] {
  if (object.kind === 'page') return 'notion-page';
  if (object.kind === 'doc') return 'gdoc';
  return 'drive-file';
}

/**
 * Every object laid out under a root: path → object.
 *
 * The rule is the adapters' own (MANUAL §6), at every level including the top:
 * a document is a file, and whatever sits inside it goes in the sibling
 * directory of the same stem. So a directory root holds the root document as
 * `<dir>/<title>.md` with its children in `<dir>/<title>/`, and a file root
 * holds it at the path itself with the children in `<stem>/` beside it. Only a
 * folder root puts its contents directly in the root's directory.
 */
function layout(state: FakeState, root: Root): Map<string, FakeObject> {
  const out = new Map<string, FakeObject>();
  const rootObject = state.objects[root.src.id];
  if (rootObject === undefined || rootObject.trashed === true) return out;

  const children = (parent: string, under: string): void => {
    for (const object of Object.values(state.objects)) {
      if (object.parent !== parent || object.trashed === true) continue;
      if (object.kind !== 'folder') out.set(`${under}${fileName(object)}`, object);
      children(object.id, `${under}${stem(fileName(object))}/`);
    }
  };

  if (rootObject.kind === 'folder') {
    children(rootObject.id, root.path);
    return out;
  }

  const path = root.path.endsWith('/') ? `${root.path}${fileName(rootObject)}` : root.path;
  out.set(path, rootObject);
  children(rootObject.id, `${stem(path)}/`);
  return out;
}

export function createFakeSource(store: FakeStore): Source {
  async function fetchRoot(
    root: Root,
    provider: CredentialProvider,
    previous: DocumentIndex,
    options: ProgressOptions = {},
  ): Promise<FetchResult> {
    await provider.accessToken(root.src.source);
    const state = store.load();
    const known = new Map([...previous.values()].map((entry) => [entry.src.id, entry]));

    // The same lines the real adapters emit, in the same two shapes: Drive
    // knows the total once the walk is done, Notion does not (MANUAL §7).
    const progress = options.progress ?? (() => {});
    progress(`listing ${root.path}`);
    const laid = [...layout(state, root)];
    const moved = ([, object]: [string, FakeObject]): boolean => {
      const before = known.get(object.id);
      const bytes = object.bytes === undefined ? undefined : Buffer.from(object.bytes, 'base64');
      return (
        before === undefined ||
        before.lastEditedTime !== object.lastEditedTime ||
        before.md5 !== (bytes === undefined ? undefined : md5(bytes))
      );
    };
    const total = laid.filter(moved).length;
    let done = 0;

    const files: FetchedFile[] = [];
    for (const one of laid) {
      const [path, object] = one;
      const changed = moved(one);
      if (changed) {
        progress(root.src.source === 'notion' ? `${++done} ${path}` : `${++done}/${total} ${path}`);
      }
      const ref: SourceRef = { source: object.source, id: object.id };
      const bytes = object.bytes === undefined ? undefined : Buffer.from(object.bytes, 'base64');
      const entry: IndexEntry = {
        path,
        src: ref,
        type: typeOf(object),
        lastEditedTime: object.lastEditedTime,
        ...(object.kind === 'export' ? { readOnly: true } : {}),
        ...(bytes === undefined ? {} : { md5: md5(bytes) }),
      };
      const file: FetchedFile = {
        path,
        entry,
        changed,
        ...(object.editor === undefined ? {} : { editor: object.editor }),
      };
      if (changed) {
        if (bytes !== undefined) file.bytes = bytes;
        else {
          file.body = object.body ?? '';
          file.text = serializeDocument({ id: ref, title: object.title }, file.body);
        }
      }
      files.push(file);
      // Sidecars only on a root that asked for them (MANUAL §4).
      if (object.comments !== undefined && root.comments === true) {
        // A sidecar carries text and no entry: it is a file of the commit and
        // not a document of the checkout (MANUAL §6).
        files.push({
          path: sidecarPathOf(path),
          text: object.comments,
          changed: true,
        });
      }
    }
    return {
      files,
      entries: files.flatMap((file) => (file.entry === undefined ? [] : [file.entry])),
      skipped: [],
    };
  }

  async function pushRoot(
    root: Root,
    changes: readonly FileChange[],
    provider: CredentialProvider,
    index: DocumentIndex,
    options: ProgressOptions = {},
  ): Promise<PushReport> {
    await provider.accessToken(root.src.source);
    const progress = options.progress ?? (() => {});
    const state = store.load();
    state.pushes.push({
      root: root.path,
      changes: changes.map((change) => ({
        kind: change.kind,
        path: change.path,
        ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
        ...(change.text === undefined ? {} : { text: change.text }),
        ...(change.bytes === undefined
          ? {}
          : { bytes: Buffer.from(change.bytes).toString('base64') }),
      })),
    });

    const report: PushReport = [];
    const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
    const touch = (object: FakeObject): void => {
      state.clock += 1;
      object.lastEditedTime = timeAt(state.clock);
      object.editor = PUSHER;
    };
    const parentOf = (path: string): string => {
      // The object whose directory the path sits in, or the root.
      const directory = path.slice(0, path.lastIndexOf('/'));
      for (const [at, object] of layout(state, root)) {
        if (stem(at) === directory && (object.kind === 'page' || object.kind === 'folder')) {
          return object.id;
        }
      }
      return root.src.id;
    };

    let written = 0;
    for (const change of changes) {
      // One line per document, before its writes go out (MANUAL §7).
      progress(`${++written}/${changes.length} ${change.path}`);
      if (change.kind === 'added') {
        const document = change.text === undefined ? undefined : parseDocument(change.text);
        if (document === undefined && root.src.source === 'notion') {
          throw new PushError('Notion holds no files', change.path);
        }
        const next = Object.keys(state.objects).length + 1;
        const id = fakeId(root.src.source, 1000 + next);
        const title = document?.frontmatter?.title ?? stem(name(change.path));
        const object = addObject(state, {
          id,
          source: root.src.source,
          kind: document === undefined ? 'file' : root.src.source === 'notion' ? 'page' : 'doc',
          title: document === undefined ? name(change.path) : title,
          parent: parentOf(change.path),
          ...(document === undefined
            ? { bytes: Buffer.from(change.bytes ?? new Uint8Array()).toString('base64') }
            : { body: stringifyMarkdown(document.body) }),
        });
        object.editor = PUSHER;
        report.push({ path: change.path, title: object.title, action: 'created' });
        continue;
      }

      const before = index.get(change.previousPath ?? change.path);
      const object = before === undefined ? undefined : state.objects[before.src.id];
      if (object === undefined) continue;

      if (change.kind === 'deleted') {
        object.trashed = true;
        touch(object);
        report.push({ path: change.path, title: object.title, action: 'trashed' });
        continue;
      }

      const document = change.text === undefined ? undefined : parseDocument(change.text);
      const isDocument = object.kind === 'page' || object.kind === 'doc';
      if (change.kind === 'renamed') {
        object.title =
          document?.frontmatter?.title ??
          (isDocument ? stem(name(change.path)) : name(change.path));
      } else if (document?.frontmatter?.title !== undefined && isDocument) {
        object.title = document.frontmatter.title;
      }
      if (document !== undefined && isDocument) object.body = stringifyMarkdown(document.body);
      if (change.bytes !== undefined && !isDocument) {
        object.bytes = Buffer.from(change.bytes).toString('base64');
      }
      touch(object);
      report.push({
        path: change.path,
        title: object.title,
        action: change.kind === 'renamed' ? 'renamed' : 'updated',
      });
    }

    store.save(state);
    return report;
  }

  /** What one object is, as `docsync resolve` and `docsync add` ask (ticket 10). */
  async function describe(
    ref: SourceRef,
    provider: CredentialProvider,
  ): Promise<SourceDescription> {
    await provider.accessToken(ref.source);
    const state = store.load();
    const object = state.objects[ref.id];
    if (object === undefined || object.trashed === true) {
      throw new Error(`${ref.source}:${ref.id} is not accessible`);
    }
    const children = Object.values(state.objects).filter(
      (one) => one.parent === ref.id && one.trashed !== true,
    );
    const name = fileName(object);
    return {
      ref,
      title: object.title,
      // Only a Drive folder is a container; a page with children is a document
      // that owns the directory beside it (MANUAL §6).
      kind: object.kind === 'folder' ? 'container' : 'leaf',
      childCount: children.length,
      ...(object.kind === 'folder' ? {} : { ext: name.slice(stem(name).length) || '.md' }),
      ...(object.editor === undefined ? {} : { editor: object.editor }),
      lastEditedTime: object.lastEditedTime,
    };
  }

  /** The paths under a root whose metadata moved since the last fetch. */
  async function changedSince(
    root: Root,
    provider: CredentialProvider,
    previous: DocumentIndex,
  ): Promise<string[]> {
    await provider.accessToken(root.src.source);
    const state = store.load();
    const known = new Map([...previous.values()].map((entry) => [entry.src.id, entry]));

    const changed: string[] = [];
    const found = new Set<string>();
    for (const [path, object] of layout(state, root)) {
      found.add(object.id);
      const before = known.get(object.id);
      const bytes = object.bytes === undefined ? undefined : Buffer.from(object.bytes, 'base64');
      if (
        before === undefined ||
        before.lastEditedTime !== object.lastEditedTime ||
        before.md5 !== (bytes === undefined ? undefined : md5(bytes))
      ) {
        changed.push(path);
      }
    }
    for (const entry of previous.values()) {
      if (!found.has(entry.src.id) && isUnderRoot(root.path, entry.path)) changed.push(entry.path);
    }
    return [...new Set(changed)].sort();
  }

  return { fetchRoot, pushRoot, describe, changedSince };
}

/** Both source names served by one fake, over one store. */
export function createFakeRegistry(store: FakeStore): SourceRegistry {
  const fake = createFakeSource(store);
  return { notion: fake, gdocs: fake };
}
