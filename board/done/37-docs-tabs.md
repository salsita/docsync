# 37 — Google Docs tabs

Phase 1. Manual §6 layout and identity, §7 fetch and push, §8, §10 skill file.

## Problem

A Google Doc can hold several tabs, nested up to three levels, each a full
document body with its own lists, inline objects and footnotes. Gemini
meeting notes always do: "Quick notes", "Full notes", "Transcript". The API
answers the tabs only when asked with `includeTabsContent=true`; asked as
docsync asks today, it answers the first tab as the legacy `body` and says
nothing about the rest, and a write request without a `tabId` lands in the
first tab. So the owner's checkout of a Gemini notes Doc holds "Quick
notes" alone, with no hint that two tabs are missing (ramnex,
`1IL1vcxHB-p8WX0jr5hmsi0ewcOu2el_EkW6Ixb0Yct0`).

The owner's condition: the transitions between one tab and many, in both
directions, are lossless. Nothing in the checkout is lost when a Doc gains
a tab or comes back down to one, and git's history follows the content
across the move.

## Decisions

| Concern | Choice | Why |
|---|---|---|
| Read | `documents.get` always with `includeTabsContent=true`. `DocsDocument` gains `tabs`; a helper flattens the reply into an ordered list of tabs (id, title, parent, body, lists, inlineObjects, footnotes, positionedObjects), and every reader of a body reads one tab | With the flag on, the top-level `body` is absent; the tab is the unit the API patches. |
| One tab | A Doc with exactly one tab and no child tabs is what it is today: `<title>.md`, `id: gdocs:<docId>`, `url` without a tab, one sidecar, one assets directory. Existing checkouts do not change on the next fetch | Nearly every Doc; nothing to migrate. |
| Many tabs | A Doc with more than one tab, children counted, is a directory `<title>/`; each tab is `<tab title>.md` inside it; a tab with child tabs is `<tab title>.md` **and** `<tab title>/` beside it, holding the children (the Notion layout, §6). Tab filenames derive from tab titles by the §6 rules, collisions suffixed and stable by tab id | A tab has its own URL, outline and body: a sub-document. The directory name plays the role the filename plays for a single Doc: it is the title, and its parent is the Drive folder. |
| The directory's name | The Doc's title, by the §6 rules. It collides with a Drive folder of the same title as two files would, and the suffix rule applies | One naming rule. |
| Identity | A tab file's frontmatter: `id: gdocs:<docId>#<tabId>`, `title:` the tab's title, `url:` `https://docs.google.com/document/d/<docId>/edit?tab=<tabId>`. `parseSourceRef` accepts the form, `sourceUrl` renders it, `source-ref.ts` splits it (`docId`, `tabId`). A `gdocs:` ref in the manifest or an ignore list still names a Doc or a folder, never a tab; `docsync add` of a URL with `?tab=` adds the whole Doc, as it does today | The id stays one token. Tab ids always start with `t.`, so the fragment cannot be mistaken for an object anchor's `#<n>`. |
| Index | One entry per tab file: `src: gdocs:<docId>#<tabId>`, `type: gdoc`, `lastEditedTime` the file's (Drive stamps the file, not the tab), `suggested` on the tab whose sidecar carries a suggestion. Plus one entry for the directory itself: `path: <title>/`, `src: gdocs:<docId>`, `type: gdoc`, so a push finds the Doc, its title and its Drive parent without guessing from the paths | A nested tab's depth varies; the paths alone cannot say where the Doc's directory starts. |
| Change detection | Per Doc, as today: the file's modified time. When it moved, every tab is converted again; the ones whose text did not change are carried unchanged | Drive has no per-tab time. |
| Object markers, assets | `<!-- docsync:object gdocs:<docId>#<n> -->` and `gdocs:kix.*` asset ids are read relative to the tab file they sit in, unchanged in spelling. Assets go to `<tab title>.assets/` beside the tab file, `document:` the tab file's path | Object ids and indexes are per tab body. |
| Comments | One sidecar per tab file. A comment thread goes to the first tab, in tab order, whose body holds its quote; a thread placed nowhere goes to the first tab's sidecar. Suggestions are per tab by construction | Drive comments are per file, their anchors opaque and without a tab; docsync already places by quoted text. |
| Push, edits | Every `location` and `range` a push sends carries `tabId`, single-tab Docs included. The live read, the base check and the patch plan are per tab. A tab's assets are staged as a Doc's are | The API's rule: no `tabId` means the first tab. |
| Push, new tab | A new `.md` with frontmatter and no id inside a tabbed Doc's directory is a new tab: `addDocumentTab` (title from `title:` or the filename; `parentTabId` when it sits in a `<tab>/` directory), then its body written into the tab it made. The id arrives with the post-push fetch | The API can make tabs; a file in the directory is the natural way to ask. |
| Push, one → many from the checkout | `git mv X.md X/A.md` plus a new `X/B.md` with frontmatter: A is the Doc's only tab (its id says so, and the live read names the tab), B is a new tab. A directory is a tabbed Doc's when the index says so or when, after the renames of the same push, a file directly in it resolves to that Doc | The transition the owner asked for, from the checkout side. |
| Push, retitle a tab | A changed `title:` in a tab file is `updateDocumentTabProperties` with `fields: title`. The filename follows on the next fetch, as a Doc's does | Same rule as a Doc's title. |
| Push, the directory | Renaming the directory retitles the Doc; moving it moves the Doc between Drive folders; it is never created as a Drive folder. Deleting the whole directory, every tab file gone, trashes the Doc | The directory is the Doc. |
| Push, delete a tab | Deleting some but not all of a Doc's tab files is refused: "`<path>` is a tab of `<directory>`; deleting a tab is permanent, so docsync does not do it. Delete it in Docs, or restore it with `git checkout -- <path>`". Renaming a tab file out of its directory is the same refusal | §8: never permanent. `deleteTab` has no trash. |
| Push, order | Tab order and nesting changes are not pushed; the files' order in the directory is the tab order at the source | Out of scope. |
| Fetch, one → many at the source | `X.md` becomes `X/<first tab title>.md` with its id gaining the tab; `X.comments.md` and `X.assets/` become `X/<first tab title>.comments.md` and `X/<first tab title>.assets/`, bytes unchanged; the new tabs arrive beside it. Git's rename detection pairs the old and new paths, so `git log --follow` crosses the move | Lossless: same content, new path. |
| Fetch, many → one at the source | The reverse: the surviving tab's file, sidecar and assets come back to `X.md`, `X.comments.md`, `X.assets/`, the id loses the tab; the deleted tabs' files go | Same. |
| Suggest roots | Unchanged: a tab file is a document; adding a tab file under a suggest root is refused as an add is | §7. |
| Status, reports | A tab file is reported as a document, by path; a new tab is `created`; a refused tab deletion is a refusal like any other | Nothing new to print. |
| Notion | Untouched | |
| Skill file | One sentence under the Drive rules: a Google Doc with several tabs is a directory holding one `.md` per tab; a new `.md` with frontmatter in it is a new tab; deleting a tab file is refused, delete the tab in Docs | Agents meet Gemini notes first. |

## Module

| File | Purpose |
|---|---|
| `src/gdrive/api.ts` | `includeTabsContent=true` on every get; `tabs` and `DocumentTab` on `DocsDocument`; `tabId` on the location and range types. |
| `src/gdrive/tabs.ts` (new) | Flatten a reply into ordered tabs; the one-tab view a single-tab Doc reads as; tab paths under a Doc's directory. |
| `src/source-ref.ts` | `gdocs:<docId>#<tabId>` parsed, rendered, split; `sourceUrl` with `?tab=`. |
| `src/gdrive/walk.ts`, `src/gdrive/index.ts` | A Doc becomes one file or a directory of tab files, sidecars and assets per tab; the directory entry; the transitions. |
| `src/gdrive/comments.ts` | Threads placed per tab. |
| `src/gdrive/to-markdown.ts`, `from-markdown.ts`, `patch.ts`, `write.ts` | Read one tab; `tabId` on every request; `addDocumentTab`, `updateDocumentTabProperties`. |
| `src/gdrive/push.ts` | Tab files resolved to Doc and tab; the directory as the Doc; new tabs; retitles; the tab-deletion refusal; the whole-directory trash. |
| `src/helper/changes.ts`, `src/helper/fetch.ts` | Whatever the directory entry and the refusal need there. |
| `src/gdrive/docs-model.mock.ts`, `fake-api.mock.ts` | Tabs in the fake: several bodies, `tabId` routing, the three tab requests, a get that answers `tabs`. |
| `skill/SKILL.md` | The sentence (report the wording; Claude applies it). |
| Tests | Ref parsing and URL; a one-tab Doc fetched exactly as before (snapshot of an existing fixture unchanged); a three-tab Doc fetched as a directory, a nested tab as file plus directory; filenames and collisions from tab titles; comments placed per tab, an unplaceable thread in the first sidecar; an image in a second tab in that tab's assets; one → many and many → one fetches produce the moves above with the same bytes; push of an edit to a second tab sends `tabId` on every request and patches that tab only; the base check reads the right tab; a new tab file → `addDocumentTab` and a body; `git mv X.md X/A.md` plus `X/B.md` pushes B as a new tab of the same Doc; a retitle; the deletion refusal; the whole-directory trash; a directory rename retitles the Doc; a suggest root refuses a new tab; the CLI e2e adds a tab to a fake Doc and pulls the transition. |

The Drive fixture folder holds no tabbed Doc and is read-only: the fake Docs
model carries the tests; the live check is the Done-when.

## Done when

`pnpm check` green. In the ramnex checkout, `docsync pull` turns
`contracts review - … - Notes by Gemini.md` into a directory of `Quick
notes.md`, `Full notes.md` (with its image under `Full notes.assets/`) and
`Transcript.md`, git shows the first as a rename of the old file, and an
edit to `Full notes.md` pushed as a suggestion lands in that tab.
