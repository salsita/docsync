/**
 * A Google Doc's tabs, flattened (MANUAL §6, ticket 37).
 *
 * A Doc can hold several tabs, nested up to three levels, and each one is a
 * full document body with its own lists, inline objects and footnotes — Gemini
 * meeting notes always are: "Quick notes", "Full notes", "Transcript". The API
 * only says so when asked with `includeTabsContent=true`, and the reply is then
 * a tree under `tabs` with no top-level `body` at all.
 *
 * Everything above this module reads *one tab*. So a tab is handed out as a
 * `DocsDocument` of its own — the tab's body, lists, inline objects and
 * footnotes under the Doc's id — and `to-markdown.ts`, `comments.ts`,
 * `assets.ts` and `ranges.ts` go on reading a document, unchanged. A document
 * with no `tabs` field is one tab whose id is nothing: that is every recorded
 * fixture, and it is also what the API answered before the flag.
 *
 * Pure: recorded JSON in, tabs out. No requests.
 */
import { assignNames } from '../manifest/filenames.js';
import type { DocsDocument, Tab } from './api.js';

/** The extension a tab file takes, as a document does (MANUAL §6). */
const MD = '.md';

/** One tab of a Doc, ready to be read as a document. */
export interface DocTab {
  /**
   * The tab's immutable id, or `undefined` for a document that has no tabs
   * field — the legacy body, which is the whole document and names no tab.
   */
  id?: string;
  /** The tab's own title, which is what its file is named after. */
  title: string;
  /** The tab this one is nested in. Absent at the root level. */
  parentId?: string;
  /** 0 at the root level. */
  nestingLevel: number;
  /** Whether the tab has child tabs, which is what makes it a directory too. */
  hasChildren: boolean;
  /** The tab as a document: its body, lists, inline objects and footnotes. */
  doc: DocsDocument;
}

/**
 * Every tab of a document, in the order Docs shows them: a parent before its
 * children, siblings by `index`.
 *
 * A tab with no id is skipped: nothing could address it, and every request a
 * push sends names a tab by id.
 */
export function flattenTabs(doc: DocsDocument): DocTab[] {
  if (doc.tabs === undefined) {
    return [{ title: doc.title ?? '', nestingLevel: 0, hasChildren: false, doc }];
  }

  const out: DocTab[] = [];
  const visit = (tabs: readonly Tab[], parentId: string | undefined, depth: number): void => {
    const ordered = [...tabs].sort(
      (a, b) => (a.tabProperties?.index ?? 0) - (b.tabProperties?.index ?? 0),
    );
    for (const tab of ordered) {
      const properties = tab.tabProperties;
      const id = properties?.tabId;
      const children = tab.childTabs ?? [];
      if (id === undefined || id === '') continue;
      out.push({
        id,
        title: properties?.title ?? '',
        ...(parentId === undefined ? {} : { parentId }),
        nestingLevel: properties?.nestingLevel ?? depth,
        hasChildren: children.length > 0,
        doc: viewOf(doc, tab),
      });
      visit(children, id, depth + 1);
    }
  };
  visit(doc.tabs, undefined, 0);
  return out;
}

/**
 * One tab as a document. `documentId` still names the Doc, since that is what
 * every request and every `url:` is addressed to; `title` is the tab's, since
 * that is what the tab is called.
 */
function viewOf(doc: DocsDocument, tab: Tab): DocsDocument {
  const content = tab.documentTab ?? {};
  return {
    ...(doc.documentId === undefined ? {} : { documentId: doc.documentId }),
    title: tab.tabProperties?.title ?? '',
    ...(content.body === undefined ? {} : { body: content.body }),
    ...(content.lists === undefined ? {} : { lists: content.lists }),
    ...(content.footnotes === undefined ? {} : { footnotes: content.footnotes }),
    ...(content.inlineObjects === undefined ? {} : { inlineObjects: content.inlineObjects }),
  };
}

/**
 * One tab of a document, as a document (MANUAL §6, ticket 37).
 *
 * `undefined` is the whole document, which is what a Doc of one tab is; an id
 * no tab has answers the document too, rather than nothing, so that a read of
 * a Doc that has just lost a tab still has a body to compare against.
 */
export function tabOf(doc: DocsDocument, tabId: string | undefined): DocsDocument {
  if (tabId === undefined) return doc;
  return flattenTabs(doc).find((tab) => tab.id === tabId)?.doc ?? doc;
}

/**
 * The filename of every tab, by tab id (MANUAL §6).
 *
 * Names are assigned per directory — the root tabs together, then each parent's
 * children among themselves — so two tabs of the same title in different
 * directories are not a collision. `previous` is the name each tab id had at
 * the last fetch, which is what keeps a `(2)` suffix attached to the same tab.
 */
export function tabNames(
  tabs: readonly DocTab[],
  previous?: ReadonlyMap<string, string>,
): Map<string, string> {
  const byParent = new Map<string, DocTab[]>();
  for (const tab of tabs) {
    const key = tab.parentId ?? '';
    byParent.set(key, [...(byParent.get(key) ?? []), tab]);
  }

  const names = new Map<string, string>();
  for (const siblings of byParent.values()) {
    const assigned = assignNames(
      siblings.map((tab) => ({ id: tab.id ?? '', title: tab.title, ext: MD })),
      previous,
    );
    for (const [id, name] of assigned) names.set(id, name);
  }
  return names;
}

/**
 * Where each tab's file goes under a Doc's directory (MANUAL §6).
 *
 * `directory` is the Doc's own directory, without a trailing slash. A tab with
 * children is `<tab title>.md` *and* `<tab title>/` beside it, holding them —
 * the layout a Notion page with child pages already has.
 */
export function tabPaths(
  tabs: readonly DocTab[],
  names: ReadonlyMap<string, string>,
  directory: string,
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const tab of tabs) {
    const id = tab.id ?? '';
    const name = names.get(id) ?? '';
    const parent = tab.parentId === undefined ? undefined : paths.get(tab.parentId);
    const base = parent === undefined ? directory : parent.slice(0, -MD.length);
    paths.set(id, `${base}/${name}`);
  }
  return paths;
}
