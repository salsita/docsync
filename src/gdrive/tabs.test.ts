import { describe, expect, it } from 'vitest';
import type { DocsDocument, Tab } from './api.js';
import { flattenTabs, tabNames, tabPaths } from './tabs.js';

/** One tab, spelled the way `documents.get` answers it. */
function tab(
  tabId: string,
  title: string,
  over: { index?: number; parentTabId?: string; nestingLevel?: number; text?: string } = {},
  ...childTabs: Tab[]
): Tab {
  return {
    tabProperties: {
      tabId,
      title,
      index: over.index ?? 0,
      nestingLevel: over.nestingLevel ?? 0,
      ...(over.parentTabId === undefined ? {} : { parentTabId: over.parentTabId }),
    },
    documentTab: {
      body: {
        content: [
          {
            startIndex: 0,
            endIndex: (over.text ?? title).length + 1,
            paragraph: { elements: [{ textRun: { content: `${over.text ?? title}\n` } }] },
          },
        ],
      },
      lists: { [`list-${tabId}`]: {} },
      inlineObjects: { [`obj-${tabId}`]: {} },
      footnotes: { [`note-${tabId}`]: {} },
    },
    ...(childTabs.length === 0 ? {} : { childTabs }),
  };
}

/** A Gemini notes Doc: three root tabs, one of them with a child. */
const threeTabs: DocsDocument = {
  documentId: 'doc1',
  title: 'Notes',
  tabs: [
    tab('t.0', 'Quick notes', { index: 0 }),
    tab(
      't.1',
      'Full notes',
      { index: 1 },
      tab('t.1a', 'Appendix', { parentTabId: 't.1', nestingLevel: 1 }),
    ),
    tab('t.2', 'Transcript', { index: 2 }),
  ],
};

describe('flattenTabs', () => {
  it('reads a document with no tabs field as the one tab it is', () => {
    // Every recorded fixture predates `includeTabsContent`, and so does every
    // checkout made before this ticket: the body is the document (MANUAL §6).
    const doc: DocsDocument = { documentId: 'd', title: 'Elements', body: { content: [] } };
    const tabs = flattenTabs(doc);

    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBeUndefined();
    expect(tabs[0]?.title).toBe('Elements');
    expect(tabs[0]?.doc).toBe(doc);
    expect(tabs[0]?.hasChildren).toBe(false);
  });

  it('answers one tab per tab, parent before its children, in index order', () => {
    expect(flattenTabs(threeTabs).map((one) => one.id)).toEqual(['t.0', 't.1', 't.1a', 't.2']);
  });

  it('orders siblings by index, not by the order the reply listed them', () => {
    const doc: DocsDocument = {
      tabs: [tab('t.b', 'B', { index: 1 }), tab('t.a', 'A', { index: 0 })],
    };
    expect(flattenTabs(doc).map((one) => one.title)).toEqual(['A', 'B']);
  });

  it('gives each tab a document of its own, which every reader reads', () => {
    const [, full] = flattenTabs(threeTabs);

    // The tab is the unit: its body, its lists, its inline objects and its
    // footnotes, under a documentId that still names the Doc (ticket 37).
    expect(full?.doc.documentId).toBe('doc1');
    expect(full?.doc.title).toBe('Full notes');
    expect(full?.doc.body?.content?.[0]?.paragraph?.elements?.[0]?.textRun?.content).toBe(
      'Full notes\n',
    );
    expect(Object.keys(full?.doc.lists ?? {})).toEqual(['list-t.1']);
    expect(Object.keys(full?.doc.inlineObjects ?? {})).toEqual(['obj-t.1']);
    expect(Object.keys(full?.doc.footnotes ?? {})).toEqual(['note-t.1']);
    // And nothing of the Doc's other tabs comes with it.
    expect(full?.doc.tabs).toBeUndefined();
  });

  it('says which tabs have children and who each one belongs to', () => {
    const tabs = flattenTabs(threeTabs);
    expect(tabs.map((one) => one.hasChildren)).toEqual([false, true, false, false]);
    expect(tabs.map((one) => one.parentId)).toEqual([undefined, undefined, 't.1', undefined]);
    expect(tabs.map((one) => one.nestingLevel)).toEqual([0, 0, 1, 0]);
  });

  it('skips a tab with no id, which is a tab nothing can address', () => {
    const doc: DocsDocument = { tabs: [{ documentTab: { body: { content: [] } } }] };
    expect(flattenTabs(doc)).toEqual([]);
  });
});

describe('tabNames', () => {
  it('names each tab from its title, by the §6 filename rules', () => {
    const names = tabNames(flattenTabs(threeTabs));

    expect(names.get('t.0')).toBe('Quick notes.md');
    expect(names.get('t.1')).toBe('Full notes.md');
    // A child tab is named in its parent's directory, not in the root one.
    expect(names.get('t.1a')).toBe('Appendix.md');
    expect(names.get('t.2')).toBe('Transcript.md');
  });

  it('suffixes a collision and leaves a hostile title safe', () => {
    const doc: DocsDocument = {
      tabs: [
        tab('t.a', 'Notes', { index: 0 }),
        tab('t.b', 'Notes', { index: 1 }),
        tab('t.c', 'a/b:c', { index: 2 }),
        tab('t.d', '', { index: 3 }),
      ],
    };
    const names = tabNames(flattenTabs(doc));

    expect(names.get('t.a')).toBe('Notes.md');
    expect(names.get('t.b')).toBe('Notes (2).md');
    expect(names.get('t.c')).toBe('a-b-c.md');
    expect(names.get('t.d')).toBe('untitled.md');
  });

  it('keeps a name a tab already had, so a suffix does not move (MANUAL §6)', () => {
    const doc: DocsDocument = {
      tabs: [tab('t.a', 'Notes', { index: 0 }), tab('t.b', 'Notes', { index: 1 })],
    };
    // `t.b` was named first last time; it keeps `Notes.md` and `t.a` moves.
    const names = tabNames(flattenTabs(doc), new Map([['t.b', 'Notes.md']]));

    expect(names.get('t.b')).toBe('Notes.md');
    expect(names.get('t.a')).toBe('Notes (2).md');
  });

  it('places a nested tab beside its parent, in its parent directory', () => {
    const tabs = flattenTabs(threeTabs);
    const paths = tabPaths(tabs, tabNames(tabs), 'drive/Notes');

    // A tab with children is a file *and* a directory, the Notion layout (§6).
    expect(paths.get('t.0')).toBe('drive/Notes/Quick notes.md');
    expect(paths.get('t.1')).toBe('drive/Notes/Full notes.md');
    expect(paths.get('t.1a')).toBe('drive/Notes/Full notes/Appendix.md');
    expect(paths.get('t.2')).toBe('drive/Notes/Transcript.md');
  });

  it('names two tabs of the same title in different directories alike', () => {
    const doc: DocsDocument = {
      tabs: [
        tab('t.a', 'Notes', { index: 0 }, tab('t.a1', 'Notes', { parentTabId: 't.a' })),
        tab('t.b', 'Other', { index: 1 }),
      ],
    };
    const names = tabNames(flattenTabs(doc));

    // `Notes/Notes.md` is not a collision: the directory tells them apart.
    expect(names.get('t.a')).toBe('Notes.md');
    expect(names.get('t.a1')).toBe('Notes.md');
  });
});
