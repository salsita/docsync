import { describe, expect, it } from 'vitest';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { NotionBlock } from './api.js';
import { MAX_UPLOAD_BYTES } from './assets.js';
import { createFakeApi, type FakeApi } from './fake-api.mock.js';
import { markdownToBlocks } from './from-markdown.js';
import { type FileChange, pushRoot } from './push.js';
import { blocksToMarkdown } from './to-markdown.js';
import { createNotionWriter } from './write.js';

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

/** One plain rich-text run, for a hand-built live page. */
function text(content: string) {
  return {
    type: 'text',
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
    },
    plain_text: content,
    href: null,
  };
}

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

/**
 * Gives a page a body, the way a fetch would have found one, and forgets the
 * calls it took: a patch test is about the calls the *push* makes.
 */
async function given(api: FakeApi, id: string, markdown: string): Promise<string> {
  await createNotionWriter(api).replaceBody(id, markdownToBlocks(markdown));
  api.calls.length = 0;
  api.appends.length = 0;
  return blocksToMarkdown(api.bodyOf(id), {});
}

/** The calls a push made, with the body reading it always begins with dropped. */
function patchCalls(api: FakeApi): string[] {
  return api.calls.filter((call) => !call.startsWith('blockTree:') && !call.startsWith('page:'));
}

/** The block types of a page's body, in order. */
function types(blocks: readonly NotionBlock[]): string[] {
  return blocks.map((block) => block.type);
}

/** A page holding a block the dialect can only write as a placeholder. */
function withBookmark(): FakeApi {
  return createFakeApi({
    pages: [
      {
        id: BLOCKS_ID,
        title: 'Blocks',
        parentId: ROOT_ID,
        blocks: [
          { object: 'block', id: 'x1', type: 'bookmark', bookmark: { url: 'https://x/' } },
          {
            object: 'block',
            id: 'x2',
            type: 'paragraph',
            paragraph: { rich_text: [text('After the bookmark, a paragraph.')], color: 'default' },
          },
        ],
      },
    ],
  });
}

/** One modified file: the base the push starts from, and the new text. */
function edit(id: string, title: string, previous: string, next: string): FileChange {
  return {
    kind: 'modified',
    path: 'notion/Docsync test/Blocks.md',
    text: file(id, title, next),
    previousText: file(id, title, previous),
  };
}

describe('pushRoot', () => {
  it('updates a modified page and says how much it touched', async () => {
    const api = fake();
    const before = await given(
      api,
      BLOCKS_ID,
      'The first paragraph here.\n\nThe second paragraph here.\n\nThe third paragraph here.\n',
    );

    const report = await push(api, [
      edit(
        BLOCKS_ID,
        'Blocks',
        before,
        'The first paragraph here.\n\nThe second paragraph, edited.\n\nThe third paragraph here.\n',
      ),
    ]);

    expect(report).toEqual([
      {
        path: 'notion/Docsync test/Blocks.md',
        title: 'Blocks',
        action: 'updated',
        blocks: { kept: 2, updated: 1, inserted: 0, deleted: 0 },
      },
    ]);
    // One call, on one block, and nothing else at all.
    expect(patchCalls(api)).toEqual([
      'update:b2:{"paragraph":{"rich_text":[{"type":"text","text":{"content":"The second paragraph, edited.","link":null},"annotations":{"bold":false,"italic":false,"strikethrough":false,"underline":false,"code":false,"color":"default"}}],"color":"default"}}',
    ]);
    expect(blocksToMarkdown(api.bodyOf(BLOCKS_ID), {})).toBe(
      'The first paragraph here.\n\nThe second paragraph, edited.\n\nThe third paragraph here.\n',
    );
  });

  it('inserts a block after the one it follows, and nothing else', async () => {
    const api = fake();
    const before = await given(api, BLOCKS_ID, 'One.\n\nTwo.\n');

    await push(api, [edit(BLOCKS_ID, 'Blocks', before, 'One.\n\nNew.\n\nTwo.\n')]);

    expect(patchCalls(api)).toEqual([`append:${BLOCKS_ID}:1:after=b1`]);
    expect(blocksToMarkdown(api.bodyOf(BLOCKS_ID), {})).toBe('One.\n\nNew.\n\nTwo.\n');
  });

  it('writes the first block again to put a block before it', async () => {
    const api = fake();
    const before = await given(api, BLOCKS_ID, 'One.\n\nTwo.\n');

    const report = await push(api, [edit(BLOCKS_ID, 'Blocks', before, 'New.\n\nOne.\n\nTwo.\n')]);

    // Notion appends after a block, never before one, so the block that used to
    // be first is written again behind the new one and the original deleted.
    expect(patchCalls(api)).toEqual([`append:${BLOCKS_ID}:2:after=b1`, 'delete:b1']);
    expect(blocksToMarkdown(api.bodyOf(BLOCKS_ID), {})).toBe('New.\n\nOne.\n\nTwo.\n');
    expect(report[0]?.blocks).toEqual({ kept: 1, updated: 0, inserted: 2, deleted: 1 });
  });

  it('appends into an empty page with no anchor at all', async () => {
    const api = fake();

    await push(api, [edit(BLOCKS_ID, 'Blocks', '', 'Only.\n')]);

    expect(patchCalls(api)).toEqual([`append:${BLOCKS_ID}:1`]);
  });

  it('deletes a block that is gone and leaves its neighbours alone', async () => {
    const api = fake();
    const before = await given(api, BLOCKS_ID, 'One.\n\nTwo.\n\nThree.\n');

    await push(api, [edit(BLOCKS_ID, 'Blocks', before, 'One.\n\nThree.\n')]);

    expect(patchCalls(api)).toEqual(['delete:b2']);
    expect(blocksToMarkdown(api.bodyOf(BLOCKS_ID), {})).toBe('One.\n\nThree.\n');
  });

  it('moves a block by writing it again where it now is', async () => {
    const api = fake();
    const before = await given(api, BLOCKS_ID, 'A.\n\nB.\n\nC.\n');

    await push(api, [edit(BLOCKS_ID, 'Blocks', before, 'B.\n\nC.\n\nA.\n')]);

    expect(patchCalls(api)).toEqual([`append:${BLOCKS_ID}:1:after=b3`, 'delete:b1']);
    expect(blocksToMarkdown(api.bodyOf(BLOCKS_ID), {})).toBe('B.\n\nC.\n\nA.\n');
  });

  it('makes a block whose type changed a delete and an insert', async () => {
    const api = fake();
    const before = await given(api, BLOCKS_ID, 'Title\n\nBody.\n');

    await push(api, [edit(BLOCKS_ID, 'Blocks', before, '# Title\n\nBody.\n')]);

    // The block on its way out is the anchor: it is still there when the new
    // one is appended behind it, and gone by the end.
    expect(patchCalls(api)).toEqual([`append:${BLOCKS_ID}:1:after=b1`, 'delete:b1']);
    expect(types(api.bodyOf(BLOCKS_ID))).toEqual(['heading_1', 'paragraph']);
  });

  it('patches a nested list item without touching its siblings', async () => {
    const api = fake();
    const before = await given(
      api,
      BLOCKS_ID,
      '- one\n  - the deep first item\n  - the deep second item\n- two\n',
    );

    await push(api, [
      edit(
        BLOCKS_ID,
        'Blocks',
        before,
        '- one\n  - the deep first item, edited\n  - the deep second item\n- two\n',
      ),
    ]);

    expect(patchCalls(api).map((call) => call.split(':').slice(0, 2).join(':'))).toEqual([
      'update:b2',
    ]);
  });

  it('keeps a placeholder it was not asked about', async () => {
    const api = withBookmark();
    const before = blocksToMarkdown(api.bodyOf(BLOCKS_ID), {});

    await push(api, [edit(BLOCKS_ID, 'Blocks', before, before.replace('After the', 'Below the'))]);

    expect(patchCalls(api).map((call) => call.split(':')[0])).toEqual(['update']);
    expect(api.bodyOf(BLOCKS_ID)[0]?.type).toBe('bookmark');
  });

  it('refuses an edit to a placeholder, naming the block type', async () => {
    const api = withBookmark();
    const before = blocksToMarkdown(api.bodyOf(BLOCKS_ID), {});

    await expect(
      push(api, [edit(BLOCKS_ID, 'Blocks', before, before.replace('notion:x1', 'notion:x9'))]),
    ).rejects.toThrow(/bookmark block cannot be edited/);
    expect(patchCalls(api)).toEqual([]);
  });

  it('deletes the block a deleted placeholder stood for', async () => {
    const api = withBookmark();
    const before = blocksToMarkdown(api.bodyOf(BLOCKS_ID), {});

    await push(api, [edit(BLOCKS_ID, 'Blocks', before, before.split('\n').slice(2).join('\n'))]);

    expect(patchCalls(api)).toEqual(['delete:x1']);
  });

  it('refuses a page that is not the version the push started from', async () => {
    const api = fake();
    await given(api, BLOCKS_ID, 'What Notion holds.\n');

    await expect(
      push(api, [edit(BLOCKS_ID, 'Blocks', 'Something else.\n', 'And the edit.\n')]),
    ).rejects.toThrow(/the source changed/);
    expect(patchCalls(api)).toEqual([]);
  });

  it('refuses a modified page with no base version to patch from', async () => {
    const api = fake();
    await expect(
      push(api, [
        {
          kind: 'modified',
          path: 'notion/Docsync test/Blocks.md',
          text: file(BLOCKS_ID, 'Blocks', 'Body.\n'),
        },
      ]),
    ).rejects.toThrow(/no base version/);
  });

  it('renames when the frontmatter title is not the page title any more', async () => {
    const api = fake();

    await push(api, [edit(BLOCKS_ID, 'Renamed', '', 'Body.\n')]);

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

  it('a renamed file that also changed is renamed and patched', async () => {
    const api = fake();

    const report = await push(api, [
      {
        kind: 'renamed',
        path: 'notion/Docsync test/Notes.md',
        previousPath: 'notion/Docsync test/Blocks.md',
        text: file(BLOCKS_ID, 'Notes', 'Body.\n'),
        previousText: file(BLOCKS_ID, 'Notes', ''),
      },
    ]);

    expect(api.calls[0]).toBe(`updatePage:${BLOCKS_ID}:{"title":"Notes"}`);
    expect(api.calls).toContain(`append:${BLOCKS_ID}:1`);
    expect(report[0]?.action).toBe('updated');
  });

  it('leaves the title alone when it still matches the page', async () => {
    const api = fake();
    await push(api, [edit(BLOCKS_ID, 'Blocks', '', 'Body.\n')]);
    expect(api.calls.some((call) => call.startsWith('updatePage'))).toBe(false);
  });

  it('does not ask about the title when the file carries none', async () => {
    const api = fake();
    await push(api, [
      {
        kind: 'modified',
        path: 'notion/Docsync test/Blocks.md',
        text: `---\nid: notion:${BLOCKS_ID}\n---\n\nBody.\n`,
        previousText: `---\nid: notion:${BLOCKS_ID}\n---\n`,
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

  describe('attachments (MANUAL §12 phase 2)', () => {
    const PATH = 'notion/Docsync test/Blocks.md';
    const ASSET = 'notion/Docsync test/Blocks.assets/photo.png';
    const PDF = 'notion/Docsync test/Blocks.assets/spec.pdf';
    const bytes = (value: string) => new TextEncoder().encode(value);

    /** The index a fetch of a page with one attachment would have left. */
    function withAsset(blockId: string): DocumentIndex {
      return new Map([
        ...index,
        [
          ASSET,
          {
            path: ASSET,
            src: { source: 'notion', id: blockId },
            type: 'asset',
            lastEditedTime: '',
            document: PATH,
            checksum: 'old',
          } as IndexEntry,
        ],
      ]);
    }

    it('uploads a new image and makes an image block pointing at the upload', async () => {
      const api = fake();
      const base = await given(api, BLOCKS_ID, 'One paragraph.\n');

      const report = await push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(BLOCKS_ID, 'Blocks', `${base}\n![A photo](Blocks.assets/photo.png)\n`),
          previousText: file(BLOCKS_ID, 'Blocks', base),
          assets: new Map([[ASSET, bytes('PNG')]]),
        },
      ]);

      expect(api.calls.filter((call) => call.startsWith('upload:'))).toEqual([
        'upload:fu1:photo.png:3:image/png',
      ]);
      const body = api.appends[0]?.[0] as Record<string, Record<string, unknown>>;
      expect(body.type).toBe('image');
      expect(body.image?.file_upload).toEqual({ id: 'fu1' });
      expect(report[0]?.uploaded).toBe(1);
    });

    it('makes a pdf block from a .pdf link and a file block from anything else', async () => {
      const api = fake();
      const base = await given(api, BLOCKS_ID, 'One paragraph.\n');
      await push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(BLOCKS_ID, 'Blocks', `${base}\n[Spec](Blocks.assets/spec.pdf)\n`),
          previousText: file(BLOCKS_ID, 'Blocks', base),
          assets: new Map([[PDF, bytes('%PDF')]]),
        },
      ]);
      const body = api.appends[0]?.[0] as Record<string, Record<string, unknown>>;
      expect(body.type).toBe('pdf');
      expect(body.pdf?.name).toBe('spec.pdf');
    });

    it('patches the block in place when only the bytes changed', async () => {
      const api = fake();
      await given(api, BLOCKS_ID, 'One paragraph.\n');
      const block = api.bodyOf(BLOCKS_ID)[0];
      if (block === undefined) throw new Error('no block');

      const report = await pushRoot(
        root,
        [{ kind: 'modified', path: ASSET, bytes: bytes('NEWPNG') }],
        provider,
        withAsset(block.id),
        { api },
      );

      expect(api.calls.filter((call) => call.startsWith('upload:'))).toHaveLength(1);
      const update = api.calls.find((call) => call.startsWith(`update:${block.id}`));
      expect(update).toContain('"file_upload":{"id":"fu1"}');
      expect(report).toEqual([{ path: PATH, title: 'Blocks', action: 'updated', uploaded: 1 }]);
    });

    it('refuses a link whose file is not in the checkout, naming the path', async () => {
      const api = fake();
      const base = await given(api, BLOCKS_ID, 'One paragraph.\n');
      await expect(
        push(api, [
          {
            kind: 'modified',
            path: PATH,
            text: file(BLOCKS_ID, 'Blocks', `${base}\n![A photo](Blocks.assets/photo.png)\n`),
            previousText: file(BLOCKS_ID, 'Blocks', base),
          },
        ]),
      ).rejects.toThrow(/Blocks\.assets\/photo\.png: this link points at a file that is not/);
    });

    /** A page holding one image Notion hosts, as a fetch would have found it. */
    function withImage(): FakeApi {
      return createFakeApi({
        pages: [
          {
            id: BLOCKS_ID,
            title: 'Blocks',
            parentId: ROOT_ID,
            blocks: [
              {
                object: 'block',
                id: 'img1',
                type: 'image',
                last_edited_time: '',
                image: {
                  type: 'file',
                  file: { url: 'https://s3/photo.png' },
                  caption: [text('A photo')],
                },
              },
              {
                object: 'block',
                id: 'p1',
                type: 'paragraph',
                paragraph: { rich_text: [text('After.')], color: 'default' },
              },
            ],
          },
        ],
      });
    }

    const IMAGE_BODY = '![A photo](Blocks.assets/photo.png)\n\nAfter.\n';

    it('reads the live page through its attachments, so nothing looks changed', async () => {
      const api = withImage();
      const report = await pushRoot(
        root,
        [
          {
            kind: 'modified',
            path: PATH,
            text: file(BLOCKS_ID, 'Blocks', IMAGE_BODY.replace('After.', 'After, edited.')),
            previousText: file(BLOCKS_ID, 'Blocks', IMAGE_BODY),
          },
        ],
        provider,
        withAsset('img1'),
        { api },
      );
      expect(report[0]?.blocks).toEqual({ kept: 1, updated: 1, inserted: 0, deleted: 0 });
    });

    it('refuses a file deleted while the document still links it', async () => {
      const api = withImage();
      await expect(
        pushRoot(
          root,
          [
            { kind: 'deleted', path: ASSET },
            {
              kind: 'modified',
              path: PATH,
              text: file(BLOCKS_ID, 'Blocks', `${IMAGE_BODY}\nAnd more.\n`),
              previousText: file(BLOCKS_ID, 'Blocks', IMAGE_BODY),
            },
          ],
          provider,
          withAsset('img1'),
          { api },
        ),
      ).rejects.toThrow(/the file is gone but notion\/Docsync test\/Blocks\.md still links it/);
      expect(api.calls).toEqual([]);
    });

    it('lets a file go when the link went with it', async () => {
      const api = withImage();
      const report = await pushRoot(
        root,
        [
          { kind: 'deleted', path: ASSET },
          {
            kind: 'modified',
            path: PATH,
            text: file(BLOCKS_ID, 'Blocks', 'After.\n'),
            previousText: file(BLOCKS_ID, 'Blocks', IMAGE_BODY),
          },
        ],
        provider,
        withAsset('img1'),
        { api },
      );
      expect(report[0]?.blocks?.deleted).toBe(1);
      expect(api.calls).toContain('delete:img1');
      expect(api.calls.filter((call) => call.startsWith('upload:'))).toEqual([]);
    });

    it('reports a file over the limit and uploads nothing for it', async () => {
      const api = fake();
      const base = await given(api, BLOCKS_ID, 'One paragraph.\n');
      const huge = { length: MAX_UPLOAD_BYTES + 1 } as unknown as Uint8Array;

      const report = await push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(BLOCKS_ID, 'Blocks', `${base}\n![A photo](Blocks.assets/photo.png)\n`),
          previousText: file(BLOCKS_ID, 'Blocks', base),
          assets: new Map([[ASSET, huge]]),
        },
      ]);

      expect(api.calls.filter((call) => call.startsWith('upload:'))).toEqual([]);
      expect(report[0]?.skippedFiles?.[0]?.path).toBe(ASSET);
      expect(report[0]?.skippedFiles?.[0]?.reason).toMatch(/limit/);
    });

    it('reports a file the source refused and still writes the rest', async () => {
      const api = fake();
      const base = await given(api, BLOCKS_ID, 'One paragraph.\n');
      api.upload = async () => {
        throw new Error('file size over the plan limit');
      };

      const report = await push(api, [
        {
          kind: 'modified',
          path: PATH,
          text: file(BLOCKS_ID, 'Blocks', `${base}\n![A photo](Blocks.assets/photo.png)\n`),
          previousText: file(BLOCKS_ID, 'Blocks', base),
          assets: new Map([[ASSET, bytes('PNG')]]),
        },
      ]);

      // The block cannot be written without an upload, so the link is refused
      // block-side; what matters is that the push said which file it was.
      expect(report[0]?.skippedFiles?.[0]?.reason).toMatch(/plan limit/);
    });
  });
});

describe('progress (MANUAL §7)', () => {
  const PATH = 'notion/Docsync test/Blocks.md';
  const ASSET = 'notion/Docsync test/Blocks.assets/photo.png';

  it('names each page before its requests go out, and every file it uploads', async () => {
    const api = fake();
    const base = await given(api, BLOCKS_ID, 'One paragraph.\n');
    const lines: string[] = [];
    const calls: number[] = [];
    const progress = (line: string) => {
      lines.push(line);
      calls.push(api.calls.length);
    };

    await pushRoot(
      root,
      [
        {
          kind: 'added',
          path: 'notion/Docsync test/New.md',
          text: file(undefined, 'New', 'Fresh.\n'),
        },
        {
          kind: 'modified',
          path: PATH,
          text: file(BLOCKS_ID, 'Blocks', `${base}\n![A photo](Blocks.assets/photo.png)\n`),
          previousText: file(BLOCKS_ID, 'Blocks', base),
          assets: new Map([[ASSET, new TextEncoder().encode('PNG')]]),
        },
      ],
      provider,
      index,
      { api, progress },
    );

    // Creations come first, so they are numbered first (MANUAL §7).
    expect(lines).toEqual([`1/2 notion/Docsync test/New.md`, `2/2 ${PATH}`, `upload ${ASSET}`]);
    expect(calls[0]).toBe(0);
  });
});
