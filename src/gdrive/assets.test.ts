import { describe, expect, it } from 'vitest';
import { checksumOf } from '../assets.js';
import { createFakeCredentialProvider } from '../auth/index.js';
import type { DocumentIndex, IndexEntry } from '../index-file.js';
import type { Root } from '../manifest/types.js';
import type { DocsDocument, GDriveApi } from './api.js';
import { contentUriOf, fetchDocumentAssets, imageObjects, keptAssets } from './assets.js';
import {
  countingApi,
  fixtureApi,
  fixtureAssetBytes,
  fixtureDocument,
  ROOT_ID,
} from './fixtures.mock.js';
import { fetchRoot } from './index.js';

const ELEMENTS = '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4';
const OBJECT = 'kix.655cbf6q1wjw';
const root: Root = { path: 'drive/', src: { source: 'gdocs', id: ROOT_ID }, ignore: [] };
const provider = createFakeCredentialProvider();

describe('imageObjects', () => {
  it('finds the images of the Elements Doc, in document order', () => {
    expect(imageObjects(fixtureDocument(ELEMENTS))).toEqual([OBJECT]);
  });

  it('leaves a drawing and an object with no image properties out', () => {
    const doc: DocsDocument = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { inlineObjectElement: { inlineObjectId: 'a' } },
                { inlineObjectElement: { inlineObjectId: 'b' } },
              ],
            },
          },
        ],
      },
      inlineObjects: {
        a: { inlineObjectProperties: { embeddedObject: { embeddedDrawingProperties: {} } } },
        b: { inlineObjectProperties: { embeddedObject: { imageProperties: {} } } },
      },
    };
    expect(imageObjects(doc)).toEqual(['b']);
  });

  it('looks inside a table cell and inside a footnote', () => {
    const object = (id: string) => ({
      paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: id } }] },
    });
    const doc: DocsDocument = {
      body: {
        content: [{ table: { tableRows: [{ tableCells: [{ content: [object('cell')] }] }] } }],
      },
      footnotes: { f1: { content: [object('note')] } },
      inlineObjects: {
        cell: { inlineObjectProperties: { embeddedObject: { imageProperties: {} } } },
        note: { inlineObjectProperties: { embeddedObject: { imageProperties: {} } } },
      },
    };
    expect(imageObjects(doc)).toEqual(['cell', 'note']);
  });
});

describe('contentUriOf', () => {
  it('answers the URI the Docs API handed us, and nothing for an unknown id', () => {
    expect(contentUriOf(fixtureDocument(ELEMENTS), OBJECT)).toContain('googleusercontent.com');
    expect(contentUriOf(fixtureDocument(ELEMENTS), 'nope')).toBeUndefined();
  });
});

describe('keptAssets', () => {
  it('carries over the files of a document nobody read this time', () => {
    const entry: IndexEntry = {
      path: 'drive/Elements.assets/image-1.png',
      src: { source: 'gdocs', id: OBJECT },
      type: 'asset',
      lastEditedTime: '',
      document: 'drive/Elements.md',
      checksum: 'x',
    };
    const index: DocumentIndex = new Map([[entry.path, entry]]);
    expect(keptAssets(index, 'drive/Elements.md')).toEqual([
      { path: entry.path, entry, changed: false },
    ]);
    expect(keptAssets(index, 'drive/Other.md')).toEqual([]);
  });
});

describe('fetchDocumentAssets', () => {
  it('downloads nothing for a document with no image', async () => {
    const doc: DocsDocument = { body: { content: [] } };
    expect(await fetchDocumentAssets(fixtureApi(), doc, 'drive/x.md', new Map())).toEqual({
      files: [],
      links: new Map(),
    });
  });

  it('names an image by its position and its content type', async () => {
    const api = {
      async downloadUri() {
        return { bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg; charset=binary' };
      },
    } as unknown as GDriveApi;
    const doc: DocsDocument = {
      body: {
        content: [{ paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: 'a' } }] } }],
      },
      inlineObjects: {
        a: {
          inlineObjectProperties: {
            embeddedObject: { imageProperties: { contentUri: 'https://lh7/one' } },
          },
        },
      },
    };
    const result = await fetchDocumentAssets(api, doc, 'drive/Notes.md', new Map());
    expect(result.links.get('a')).toBe('drive/Notes.assets/image-1.jpg');
  });
});

describe('a Drive fetch, over the fixture tree (MANUAL §12 phase 2)', () => {
  const fetch = (previous: DocumentIndex = new Map(), api: GDriveApi = fixtureApi()) =>
    fetchRoot(root, provider, previous, { api });

  it('writes the Elements image and links it with its alt text', async () => {
    const { files } = await fetch();
    const image = files.find((one) => one.path.endsWith('image-1.png'));
    const elements = files.find((one) => one.path === 'drive/Elements.md');

    expect(image?.path).toBe('drive/Elements.assets/image-1.png');
    expect(image?.bytes).toEqual(fixtureAssetBytes(OBJECT));
    // The object carries no alt text, so the link carries none either.
    expect(elements?.body).toContain('![](Elements.assets/image-1.png)');
    expect(elements?.body).not.toContain('docsync:object');
    expect(elements?.body).not.toContain('googleusercontent');
  });

  it('records it as an asset entry with its checksum and no time of its own', async () => {
    const { entries } = await fetch();
    expect(entries.find((one) => one.type === 'asset')).toEqual({
      path: 'drive/Elements.assets/image-1.png',
      src: { source: 'gdocs', id: OBJECT },
      type: 'asset',
      lastEditedTime: '',
      document: 'drive/Elements.md',
      checksum: checksumOf(fixtureAssetBytes(OBJECT)),
    });
  });

  it('downloads nothing at all for a document that did not change', async () => {
    const first = await fetch();
    const previous = new Map(first.entries.map((one): [string, IndexEntry] => [one.path, one]));
    const counted = countingApi();

    const { files } = await fetch(previous, counted.api);

    expect(counted.requests.filter((one) => one.startsWith('downloadUri:'))).toEqual([]);
    expect(counted.requests.filter((one) => one.startsWith('getDocument:'))).toEqual([]);
    const image = files.find((one) => one.path.endsWith('image-1.png'));
    expect(image?.changed).toBe(false);
    expect(image?.bytes).toBeUndefined();
  });

  it('re-reads the image of a changed document but rewrites it only if it differs', async () => {
    const first = await fetch();
    const previous = new Map(
      first.entries.map((one): [string, IndexEntry] => [
        one.path,
        one.type === 'gdoc' ? { ...one, lastEditedTime: '2000-01-01T00:00:00.000Z' } : one,
      ]),
    );
    const counted = countingApi();

    const { files } = await fetch(previous, counted.api);

    // Downloaded, because Docs stamps no time on an object and there is
    // nothing else to compare; not rewritten, because the bytes are the same.
    expect(counted.requests.filter((one) => one.startsWith('downloadUri:'))).toHaveLength(1);
    expect(files.find((one) => one.path.endsWith('image-1.png'))?.changed).toBe(false);
  });

  it('rewrites it when the bytes really did move', async () => {
    const first = await fetch();
    const previous = new Map(
      first.entries.map((one): [string, IndexEntry] => [
        one.path,
        one.type === 'gdoc'
          ? { ...one, lastEditedTime: '2000-01-01T00:00:00.000Z' }
          : { ...one, checksum: 'stale' },
      ]),
    );

    const { files } = await fetch(previous);

    expect(files.find((one) => one.path.endsWith('image-1.png'))?.changed).toBe(true);
  });
});
