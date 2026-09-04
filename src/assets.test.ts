import { describe, expect, it } from 'vitest';
import {
  assetsDirOf,
  assignAssetNames,
  checksumOf,
  documentOfAssetsDir,
  isAssetPath,
  linkToAsset,
  MEDIA_EXTENSIONS,
  nameHintFor,
  resolveAssetPath,
} from './assets.js';
import type { IndexEntry } from './index-file.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('assetsDirOf', () => {
  it('puts the directory beside the document, named after its stem', () => {
    expect(assetsDirOf('Specs/Auth.md')).toBe('Specs/Auth.assets');
    expect(assetsDirOf('Auth.md')).toBe('Auth.assets');
  });
});

describe('isAssetPath and documentOfAssetsDir', () => {
  it('recognises a path inside an assets directory and names its document', () => {
    expect(isAssetPath('Specs/Auth.assets/photo.png')).toBe(true);
    expect(documentOfAssetsDir('Specs/Auth.assets/photo.png')).toBe('Specs/Auth.md');
  });

  it('says no to the directory itself, to a sibling and to a lookalike', () => {
    expect(isAssetPath('Specs/Auth.md')).toBe(false);
    expect(isAssetPath('Specs/Auth.assets')).toBe(false);
    expect(isAssetPath('Specs/assets/photo.png')).toBe(false);
    expect(documentOfAssetsDir('Specs/Auth.md')).toBeUndefined();
  });

  it('works at the top level of the checkout', () => {
    expect(documentOfAssetsDir('Auth.assets/a.png')).toBe('Auth.md');
  });
});

describe('checksumOf', () => {
  it('is the sha-256 of the bytes, and differs when one byte does', () => {
    expect(checksumOf(bytes('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(checksumOf(bytes('hellp'))).not.toBe(checksumOf(bytes('hello')));
  });
});

describe('nameHintFor', () => {
  it("prefers the source's own file name", () => {
    expect(nameHintFor({ name: 'Spec v2.pdf', url: 'https://x/y/other.pdf' })).toEqual({
      title: 'Spec v2',
      ext: '.pdf',
    });
  });

  it('falls back to the last path segment of the URL, unescaped', () => {
    expect(nameHintFor({ url: 'https://s3/secure/a%20photo.PNG?X-Amz=1' })).toEqual({
      title: 'a photo',
      ext: '.PNG',
    });
  });

  it('names an object with neither by its position and its content type', () => {
    expect(nameHintFor({ contentType: 'image/jpeg', position: 3 })).toEqual({
      title: 'image-3',
      ext: '.jpg',
    });
  });

  it('takes the extension from the content type when the name has none', () => {
    expect(nameHintFor({ name: 'diagram', contentType: 'image/png' })).toEqual({
      title: 'diagram',
      ext: '.png',
    });
  });

  it('leaves a file with no extension anywhere without one', () => {
    expect(nameHintFor({ name: 'README' })).toEqual({ title: 'README', ext: '' });
  });
});

describe('assignAssetNames', () => {
  const previous = (entries: readonly Partial<IndexEntry>[]): IndexEntry[] =>
    entries.map((one) => ({
      path: 'Auth.assets/photo.png',
      src: { source: 'notion', id: 'b1' },
      type: 'asset',
      lastEditedTime: '',
      document: 'Auth.md',
      checksum: 'x',
      ...one,
    })) as IndexEntry[];

  it('names by the source name, made safe by the filename rules', () => {
    const names = assignAssetNames('Auth.md', [{ id: 'b1', name: 'a/b:c.png' }], []);
    expect(names.get('b1')).toBe('Auth.assets/a-b-c.png');
  });

  it('makes a collision unique with a numeric suffix before the extension', () => {
    const names = assignAssetNames(
      'Auth.md',
      [
        { id: 'b1', name: 'photo.png' },
        { id: 'b2', name: 'photo.png' },
      ],
      [],
    );
    expect([...names.values()].sort()).toEqual([
      'Auth.assets/photo (2).png',
      'Auth.assets/photo.png',
    ]);
  });

  it('keeps a name across fetches even when a sibling appeared first', () => {
    const first = assignAssetNames(
      'Auth.md',
      [
        { id: 'b1', name: 'photo.png' },
        { id: 'b2', name: 'photo.png' },
      ],
      [],
    );
    const kept = previous(
      [...first].map(([id, path]) => ({
        path,
        src: { source: 'notion', id },
        document: 'Auth.md',
      })),
    );
    const again = assignAssetNames(
      'Auth.md',
      [
        { id: 'b2', name: 'photo.png' },
        { id: 'b1', name: 'photo.png' },
      ],
      kept,
    );
    expect(again).toEqual(first);
  });

  it('follows the document when it moves', () => {
    const kept = previous([{ path: 'Auth.assets/photo.png' }]);
    const names = assignAssetNames('Specs/Renamed.md', [{ id: 'b1', name: 'photo.png' }], kept);
    expect(names.get('b1')).toBe('Specs/Renamed.assets/photo.png');
  });
});

describe('linkToAsset and resolveAssetPath', () => {
  it('writes the link the way a person would, and reads it back', () => {
    expect(linkToAsset('Specs/Auth.md', 'Specs/Auth.assets/photo.png')).toBe(
      'Auth.assets/photo.png',
    );
    expect(resolveAssetPath('Specs/Auth.md', 'Auth.assets/photo.png')).toBe(
      'Specs/Auth.assets/photo.png',
    );
  });

  it('leaves an absolute URL alone', () => {
    expect(resolveAssetPath('Specs/Auth.md', 'https://example.com/a.png')).toBeUndefined();
  });

  it('escapes a space so that the link parses as one link', () => {
    expect(linkToAsset('Auth.md', 'Auth.assets/a photo.png')).toBe('Auth.assets/a%20photo.png');
    expect(resolveAssetPath('Auth.md', 'Auth.assets/a%20photo.png')).toBe(
      'Auth.assets/a photo.png',
    );
  });
});

describe('MEDIA_EXTENSIONS', () => {
  it('knows a video from a PDF from anything else', () => {
    expect(MEDIA_EXTENSIONS.video.has('.mp4')).toBe(true);
    expect(MEDIA_EXTENSIONS.video.has('.pdf')).toBe(false);
  });
});
