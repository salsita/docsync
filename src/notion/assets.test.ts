import { describe, expect, it } from 'vitest';
import { checksumOf } from '../assets.js';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import { DownloadError, type NotionApi, type NotionBlock } from './api.js';
import { downloadBlockFile, fetchPageAssets, hostedBlocks, hostedUrlOf } from './assets.js';
import { countingApi, fixtureApi, fixtureAssetBytes, ROOT_ID } from './fixtures.mock.js';
import { fetchRoot } from './index.js';

const BLOCKS_PATH = 'notion/Docsync test/Blocks.md';
const IMAGE_BLOCK = '3d1715cbeb0880e18296c296a2a5cc1f';
const FILE_BLOCK = '3d1715cbeb088063bba2e09d06f93290';
const root: Root = { path: 'notion/', src: { source: 'notion', id: ROOT_ID }, ignore: [] };
const provider = createFakeCredentialProvider();

/** A media block with a hosted file, the way the API shapes one. */
function hosted(id: string, type: string, url: string, extra: Record<string, unknown> = {}) {
  return {
    object: 'block',
    id,
    type,
    has_children: false,
    last_edited_time: '2026-09-04T09:00:00.000Z',
    [type]: { type: 'file', file: { url, expiry_time: '' }, caption: [], ...extra },
  } as NotionBlock;
}

describe('hostedUrlOf and hostedBlocks', () => {
  it('finds a file Notion hosts and leaves an external one alone', () => {
    expect(hostedUrlOf(hosted('b1', 'image', 'https://s3/x.png'))).toBe('https://s3/x.png');
    const external = {
      object: 'block',
      id: 'b2',
      type: 'image',
      has_children: false,
      image: { type: 'external', external: { url: 'https://example.com/x.png' } },
    } as NotionBlock;
    expect(hostedUrlOf(external)).toBeUndefined();
    expect(hostedBlocks([hosted('b1', 'image', 'u'), external]).map((one) => one.id)).toEqual([
      'b1',
    ]);
  });

  it('looks inside children but never inside a child page', () => {
    const parent = {
      ...hosted('b1', 'toggle', 'u'),
      type: 'toggle',
      toggle: {},
      children: [hosted('b2', 'file', 'u')],
    } as NotionBlock;
    const page = {
      object: 'block',
      id: 'b3',
      type: 'child_page',
      child_page: { title: 'x' },
      children: [hosted('b4', 'image', 'u')],
    } as NotionBlock;
    expect(hostedBlocks([parent, page]).map((one) => one.id)).toEqual(['b2']);
  });
});

describe('downloadBlockFile', () => {
  const block = hosted('b1', 'image', 'https://s3/old.png');

  it('reads the URL the block carries', async () => {
    const api = {
      async download(url: string) {
        expect(url).toBe('https://s3/old.png');
        return new Uint8Array([1]);
      },
    } as unknown as NotionApi;
    expect([...(await downloadBlockFile(api, block))]).toEqual([1]);
  });

  it('re-reads the block when the signed URL has expired, and tries once more', async () => {
    const seen: string[] = [];
    const api = {
      async download(url: string) {
        seen.push(url);
        if (url === 'https://s3/old.png') throw new DownloadError('403');
        return new Uint8Array([2]);
      },
      async block() {
        return hosted('b1', 'image', 'https://s3/fresh.png');
      },
    } as unknown as NotionApi;

    expect([...(await downloadBlockFile(api, block))]).toEqual([2]);
    expect(seen).toEqual(['https://s3/old.png', 'https://s3/fresh.png']);
  });

  it('gives up when the fresh URL is the same one', async () => {
    const api = {
      async download() {
        throw new DownloadError('403 on it');
      },
      async block() {
        return block;
      },
    } as unknown as NotionApi;
    await expect(downloadBlockFile(api, block)).rejects.toThrow(/403/);
  });
});

describe('fetchPageAssets', () => {
  const page = { path: 'Specs/Auth.md', blocks: [] as NotionBlock[] };

  it('downloads nothing for a page that hosts nothing', async () => {
    const result = await fetchPageAssets(fixtureApi(), page, new Map());
    expect(result).toEqual({ files: [], links: new Map() });
  });
});

describe('a Notion fetch, over the fixture tree (MANUAL §12 phase 2)', () => {
  const fetch = (previous: DocumentIndex = new Map(), api: NotionApi = fixtureApi()) =>
    fetchRoot(root, provider, previous, { api });

  it('writes the hosted image and the hosted file, and links them relatively', async () => {
    const { files } = await fetch();
    const image = files.find((one) => one.path.endsWith('chili.png'));
    const file = files.find((one) => one.path.endsWith('sample-file.bin'));
    const blocks = files.find((one) => one.path === BLOCKS_PATH);

    expect(image?.path).toBe('notion/Docsync test/Blocks.assets/chili.png');
    expect(file?.path).toBe('notion/Docsync test/Blocks.assets/sample-file.bin');
    expect(image?.bytes).toEqual(fixtureAssetBytes(IMAGE_BLOCK));
    expect(file?.bytes).toEqual(fixtureAssetBytes(FILE_BLOCK));
    expect(image?.text).toBeUndefined();

    expect(blocks?.body).toContain('![Uploaded image](Blocks.assets/chili.png)');
    expect(blocks?.body).toContain('[Uploaded file](Blocks.assets/sample-file.bin)');
    // The signed URL is never in the file: it expires within the hour.
    expect(blocks?.body).not.toContain('X-Amz');
  });

  it('records each one as an asset entry naming its block, document and bytes', async () => {
    const { entries } = await fetch();
    const image = entries.find((one) => one.path.endsWith('chili.png'));

    expect(image).toEqual({
      path: 'notion/Docsync test/Blocks.assets/chili.png',
      src: { source: 'notion', id: IMAGE_BLOCK },
      type: 'asset',
      lastEditedTime: '2026-09-04T09:00:00.000Z',
      document: BLOCKS_PATH,
      checksum: checksumOf(fixtureAssetBytes(IMAGE_BLOCK)),
    });
  });

  it('downloads nothing the second time, and links the files all the same', async () => {
    const first = await fetch();
    const previous = new Map(first.entries.map((one) => [one.path, one]));
    const counted = countingApi();

    const { files } = await fetch(previous, counted.api);

    expect(counted.requests.filter((one) => one.startsWith('download:'))).toEqual([]);
    const image = files.find((one) => one.path.endsWith('chili.png'));
    expect(image?.changed).toBe(false);
    expect(image?.bytes).toBeUndefined();
    expect(files.find((one) => one.path === BLOCKS_PATH)?.body).toContain(
      '![Uploaded image](Blocks.assets/chili.png)',
    );
  });

  it('downloads again when the block was edited', async () => {
    const first = await fetch();
    const previous = new Map(
      first.entries.map((one): [string, IndexEntry] => [
        one.path,
        one.type === 'asset' ? { ...one, lastEditedTime: '2000-01-01T00:00:00.000Z' } : one,
      ]),
    );
    const counted = countingApi();

    const { files } = await fetch(previous, counted.api);

    expect(counted.requests.filter((one) => one.startsWith('download:'))).toHaveLength(2);
    expect(files.find((one) => one.path.endsWith('chili.png'))?.changed).toBe(true);
  });

  it('keeps the name when the page is renamed, and moves the file with it', async () => {
    const first = await fetch();
    const previous = new Map(
      first.entries.map((one): [string, IndexEntry] => [
        one.path,
        { ...one, path: one.path.replace('Blocks', 'Renamed') },
      ]),
    );
    const moved = new Map(
      [...previous.values()].map((one): [string, IndexEntry] => [one.path, one]),
    );

    const { files } = await fetch(moved);

    // The page is named from its title again, so the assets come home with it
    // and keep the names they had.
    expect(files.map((one) => one.path)).toContain(
      'notion/Docsync test/Blocks.assets/sample-file.bin',
    );
  });
});
