import { describe, expect, it } from 'vitest';
import type { NotionComment } from './api.js';
import { commentableBlocks, pageThreads } from './comments.js';
import { fixtureApi, fixtureBlocks, fixtureComments } from './fixtures.mock.js';
import { blocksToMarkdown } from './to-markdown.js';

const BLOCKS = '3cf715cbeb0881168ea0f3f18715e1a4';
const ROOT = '3cf715cbeb088035b511f0b4f06efbd5';

const blocks = fixtureBlocks(BLOCKS);
const body = blocksToMarkdown(blocks, {});
const api = fixtureApi();

describe('commentableBlocks', () => {
  it('lists every block of the page, nested ones included', () => {
    expect(commentableBlocks(blocks).length).toBeGreaterThan(blocks.length);
  });

  it('leaves out a child page, whose comments belong to its own sidecar', () => {
    const child = fixtureBlocks(ROOT).find((block) => block.type === 'child_page');

    expect(child).toBeDefined();
    expect(commentableBlocks(fixtureBlocks(ROOT))).not.toContain(child?.id);
  });
});

describe('pageThreads', () => {
  it('answers one thread per discussion, in block order', async () => {
    const threads = await pageThreads(api, BLOCKS, blocks, body);

    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.entries[0]?.text)).toEqual([
      'This is an inline comment.',
      'Comment on the whole block.',
    ]);
    expect(threads.map((thread) => thread.kind)).toEqual(['comment', 'comment']);
  });

  it('names the thread by its discussion, in the bare form docsync uses', async () => {
    const [first] = await pageThreads(api, BLOCKS, blocks, body);

    expect(first?.id).toBe('3d0715cbeb0880e8a289001cb897f5e5');
  });

  it('quotes the whole block, without marks, under its nearest heading', async () => {
    const threads = await pageThreads(api, BLOCKS, blocks, body);

    expect(threads[1]?.quote).toBe('- Bullet one');
    expect(threads[1]?.mark).toBeUndefined();
    expect(threads[1]?.heading).toBe('Heading three');
  });

  it('reads a discussion of two comments as two entries, in creation order', async () => {
    const threads = await pageThreads(api, BLOCKS, blocks, body);

    expect(threads[1]?.entries).toEqual([
      {
        author: 'Jiří Staniševský',
        time: '2026-09-03T16:22:00.000Z',
        text: 'Comment on the whole block.',
      },
      {
        author: 'Jiří Staniševský',
        time: '2026-09-03T16:22:00.000Z',
        text: 'Not sure it’s any different from an inline block.',
      },
    ]);
  });

  it('asks the page and every block of it exactly once', async () => {
    const asked: string[] = [];
    const counting = {
      ...api,
      async comments(id: string): Promise<NotionComment[]> {
        asked.push(id);
        return api.comments(id);
      },
    };

    await pageThreads(counting, BLOCKS, blocks, body);

    expect(asked[0]).toBe(BLOCKS);
    expect(asked).toHaveLength(commentableBlocks(blocks).length + 1);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it('answers nothing for a page nobody has commented on', async () => {
    const other = fixtureBlocks(ROOT);

    expect(await pageThreads(api, ROOT, other, blocksToMarkdown(other, {}))).toEqual([]);
  });

  it('has a recorded comment for two blocks of the Blocks page and no other', () => {
    const recorded = Object.entries(fixtureComments(BLOCKS)).filter(([, on]) => on.length > 0);

    expect(recorded).toHaveLength(2);
  });
});
