import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { createFakeApi, type FakeApi } from './fake-api.mock.js';
import { type FileChange, pushRoot } from './push.js';

const ROOT_ID = '3cf715cbeb088035b511f0b4f06efbd5';
const BLOCKS_ID = '3cf715cbeb0881168ea0f3f18715e1a4';
const LEAF_ID = '3cf715cbeb08819db888c032d7bb60de';

const root: Root = { path: 'notion/', src: { source: 'notion', id: ROOT_ID }, ignore: [] };

const provider = createFakeCredentialProvider();

/** One index entry, as a fetch would have recorded it. */
function entry(path: string, id: string): IndexEntry {
  return { path, src: { source: 'notion', id }, type: 'notion-page', lastEditedTime: '' };
}

const index: DocumentIndex = new Map([
  ['notion/Docsync test.md', entry('notion/Docsync test.md', ROOT_ID)],
  ['notion/Docsync test/Blocks.md', entry('notion/Docsync test/Blocks.md', BLOCKS_ID)],
  ['notion/Docsync test/Leaf.md', entry('notion/Docsync test/Leaf.md', LEAF_ID)],
]);

/** A file's text, with the frontmatter a fetch would have written. */
function file(id: string | undefined, title: string, body: string): string {
  const frontmatter = id === undefined ? '' : `id: notion:${id}\n`;
  return `---\n${frontmatter}title: ${title}\n---\n\n${body}`;
}

/** A fake holding every page the index names. */
function fake(): FakeApi {
  return createFakeApi({
    pages: [
      { id: ROOT_ID, title: 'Docsync test', blocks: [] },
      { id: BLOCKS_ID, title: 'Blocks', parentId: ROOT_ID, blocks: [] },
      { id: LEAF_ID, title: 'Leaf', parentId: ROOT_ID, blocks: [] },
    ],
  });
}

function push(api: FakeApi, changes: FileChange[]) {
  return pushRoot(root, changes, provider, index, { api });
}

describe('pushRoot', () => {
  it('updates a modified page and says so', async () => {
    const api = fake();

    const report = await push(api, [
      {
        kind: 'modified',
        path: 'notion/Docsync test/Blocks.md',
        text: file(BLOCKS_ID, 'Blocks', 'New body.\n'),
      },
    ]);

    expect(report).toEqual([
      { path: 'notion/Docsync test/Blocks.md', title: 'Blocks', action: 'updated' },
    ]);
    expect(api.bodyOf(BLOCKS_ID).map((block) => block.type)).toEqual(['paragraph']);
  });

  it('renames when the frontmatter title is not the page title any more', async () => {
    const api = fake();

    await push(api, [
      {
        kind: 'modified',
        path: 'notion/Docsync test/Blocks.md',
        text: file(BLOCKS_ID, 'Renamed', 'Body.\n'),
      },
    ]);

    expect(api.calls).toContain(`updatePage:${BLOCKS_ID}:{"title":"Renamed"}`);
  });

  it('a rename with no body change makes exactly one call', async () => {
    const api = fake();

    const report = await push(api, [
      {
        kind: 'renamed',
        path: 'notion/Docsync test/Notes.md',
        previousPath: 'notion/Docsync test/Blocks.md',
        text: undefined,
      },
    ]);

    expect(api.calls).toEqual([`updatePage:${BLOCKS_ID}:{"title":"Notes"}`]);
    expect(report).toEqual([
      { path: 'notion/Docsync test/Notes.md', title: 'Notes', action: 'renamed' },
    ]);
  });

  it('a renamed file that also changed is renamed and rewritten', async () => {
    const api = fake();

    const report = await push(api, [
      {
        kind: 'renamed',
        path: 'notion/Docsync test/Notes.md',
        previousPath: 'notion/Docsync test/Blocks.md',
        text: file(BLOCKS_ID, 'Notes', 'Body.\n'),
      },
    ]);

    expect(api.calls[0]).toBe(`updatePage:${BLOCKS_ID}:{"title":"Notes"}`);
    expect(api.calls).toContain(`append:${BLOCKS_ID}:1`);
    expect(report[0]?.action).toBe('updated');
  });

  it('leaves the title alone when it still matches the page', async () => {
    const api = fake();
    await push(api, [
      {
        kind: 'modified',
        path: 'notion/Docsync test/Blocks.md',
        text: file(BLOCKS_ID, 'Blocks', 'Body.\n'),
      },
    ]);
    expect(api.calls.some((call) => call.startsWith('updatePage'))).toBe(false);
  });

  it('does not ask about the title when the file carries none', async () => {
    const api = fake();
    await push(api, [
      {
        kind: 'modified',
        path: 'notion/Docsync test/Blocks.md',
        text: `---\nid: notion:${BLOCKS_ID}\n---\n\nBody.\n`,
      },
    ]);
    expect(api.calls.some((call) => call.startsWith('page:'))).toBe(false);
  });

  it('trashes a deleted file, and says nothing about one with no id', async () => {
    const api = fake();

    const report = await push(api, [
      { kind: 'deleted', path: 'notion/Docsync test/Leaf.md' },
      { kind: 'deleted', path: 'notion/Docsync test/Never fetched.md' },
    ]);

    expect(api.calls).toEqual([`updatePage:${LEAF_ID}:{"archived":true}`]);
    expect(report).toEqual([
      { path: 'notion/Docsync test/Leaf.md', title: 'Leaf', action: 'trashed' },
    ]);
    expect(api.pages.get(LEAF_ID)?.archived).toBe(true);
  });

  it('creates a new file under the page its path implies', async () => {
    const api = fake();

    const report = await push(api, [
      { kind: 'added', path: 'notion/Docsync test/Blocks/New.md', text: 'Fresh.\n' },
    ]);

    expect(api.calls[0]).toBe(`createPage:${BLOCKS_ID}:New:1`);
    expect(report).toEqual([
      { path: 'notion/Docsync test/Blocks/New.md', title: 'New', action: 'created' },
    ]);
  });

  it('creates under the root when the path implies no page', async () => {
    const api = fake();
    await push(api, [{ kind: 'added', path: 'notion/Loose.md', text: 'Loose.\n' }]);
    expect(api.calls[0]).toBe(`createPage:${ROOT_ID}:Loose:1`);
  });

  it('prefers the frontmatter title of a new file over its filename', async () => {
    const api = fake();
    await push(api, [
      {
        kind: 'added',
        path: 'notion/Docsync test/Odd-name.md',
        text: file(undefined, 'Odd/name', ''),
      },
    ]);
    expect(api.calls[0]).toContain(':Odd/name:');
  });

  it('creates a parent before the child whose path names it', async () => {
    const api = fake();

    await push(api, [
      { kind: 'added', path: 'notion/Docsync test/A/B.md', text: 'B.\n' },
      { kind: 'added', path: 'notion/Docsync test/A.md', text: 'A.\n' },
    ]);

    // Sorted by path, so `A.md` is made first and `B.md` lands under it.
    expect(api.calls[0]).toBe(`createPage:${ROOT_ID}:A:1`);
    expect(api.calls[1]).toBe('createPage:page1:B:1');
  });

  it('rewrites a link from a new page to a page created after it', async () => {
    const api = fake();

    await push(api, [
      { kind: 'added', path: 'notion/Docsync test/A.md', text: 'See [Zed](Zed.md).\n' },
      { kind: 'added', path: 'notion/Docsync test/Zed.md', text: 'Zed.\n' },
    ]);

    // `A.md` is created first, when `Zed.md` has no id yet, so its body is
    // written a second time once it has one.
    const second = api.calls.filter((call) => call.startsWith('append:page1'));
    expect(second).toHaveLength(1);

    const paragraph = api.bodyOf('page1')[0]?.paragraph as { rich_text: { mention?: unknown }[] };
    const runs = paragraph.rich_text;
    expect(runs.filter((one) => one.mention !== undefined).map((one) => one.mention)).toEqual([
      { type: 'page', page: { id: 'page2' } },
    ]);
  });

  it('does not revisit a new page whose links were all resolvable', async () => {
    const api = fake();

    await push(api, [
      { kind: 'added', path: 'notion/Docsync test/A.md', text: 'See [Leaf](Leaf.md).\n' },
      { kind: 'added', path: 'notion/Docsync test/Zed.md', text: 'Zed.\n' },
    ]);

    expect(api.calls.filter((call) => call.startsWith('children:'))).toEqual([]);
  });

  it('ignores a link that is not a relative Markdown path', async () => {
    const api = fake();
    await push(api, [
      {
        kind: 'added',
        path: 'notion/Docsync test/A.md',
        text: 'See [x](https://example.com/y.md) and [y](Zed.png).\n',
      },
      { kind: 'added', path: 'notion/Docsync test/Zed.md', text: 'Zed.\n' },
    ]);
    expect(api.calls.filter((call) => call.startsWith('children:'))).toEqual([]);
  });

  it('asks the credential provider for a token when given no API', async () => {
    await expect(pushRoot(root, [], createFakeCredentialProvider())).rejects.toThrow(
      /docsync auth notion/,
    );
  });
});
