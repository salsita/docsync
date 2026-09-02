import { describe, expect, it } from 'vitest';
import { parseManifest } from './parse.js';
import { serializeManifest } from './serialize.js';
import type { Manifest } from './types.js';

const WITH_COMMENTS = `# The roots this checkout tracks.
version: 1
roots:
  # The product spec tree.
  - src: notion:2f3a9c
    path: Product Specs/
  - src: gdocs:1AbCdE
    path: Contracts/
    ignore:
      - "Archive/**" # superseded
      - gdocs:9XyZ
`;

function parsed(text: string): Manifest {
  const result = parseManifest(text);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join(', '));
  return result.manifest;
}

describe('serializeManifest', () => {
  it('round-trips a commented file unchanged', () => {
    expect(serializeManifest(parsed(WITH_COMMENTS))).toBe(WITH_COMMENTS);
  });

  it('writes a manifest built from scratch in a stable key order', () => {
    const manifest: Manifest = {
      version: 1,
      roots: [
        {
          src: { source: 'gdocs', id: '1AbCdE' },
          path: 'Contracts/',
          ignore: ['Archive/**'],
        },
        { src: { source: 'notion', id: '2f3a9c' }, path: 'Product Specs/', ignore: [] },
      ],
    };
    expect(serializeManifest(manifest)).toBe(`version: 1
roots:
  - src: gdocs:1AbCdE
    path: Contracts/
    ignore:
      - Archive/**
  - src: notion:2f3a9c
    path: Product Specs/
`);
  });

  it('writes an empty checkout', () => {
    expect(serializeManifest({ version: 1, roots: [] })).toBe('version: 1\nroots: []\n');
  });

  it('keeps the comments of the roots that survive a removal', () => {
    const manifest = parsed(WITH_COMMENTS);
    manifest.roots = manifest.roots.filter((root) => root.src.source === 'notion');
    expect(serializeManifest(manifest)).toBe(`# The roots this checkout tracks.
version: 1
roots:
  # The product spec tree.
  - src: notion:2f3a9c
    path: Product Specs/
`);
  });

  it('appends a new root to a commented file', () => {
    const manifest = parsed(WITH_COMMENTS);
    manifest.roots.push({
      src: { source: 'gdocs', id: '7QrS' },
      path: 'notes/roadmap.md',
      ignore: [],
    });
    expect(serializeManifest(manifest)).toBe(`${WITH_COMMENTS}  - src: gdocs:7QrS
    path: notes/roadmap.md
`);
  });

  it('rewrites a root whose path changed, dropping its now-wrong ignore styling', () => {
    const manifest = parsed(WITH_COMMENTS);
    const root = manifest.roots[1];
    if (!root) throw new Error('missing root');
    root.path = 'Legal/Contracts/';
    root.ignore = ['Archive/**', '!Archive/2024/**'];
    expect(serializeManifest(manifest)).toBe(`# The roots this checkout tracks.
version: 1
roots:
  # The product spec tree.
  - src: notion:2f3a9c
    path: Product Specs/
  - src: gdocs:1AbCdE
    path: Legal/Contracts/
    ignore:
      - Archive/**
      - "!Archive/2024/**"
`);
  });

  it('replaces a roots value that the user left empty', () => {
    const manifest = parsed('version: 1\nroots:\n');
    manifest.roots.push({ src: { source: 'notion', id: 'a' }, path: 'Specs/', ignore: [] });
    expect(serializeManifest(manifest)).toBe(`version: 1
roots:
  - src: notion:a
    path: Specs/
`);
  });

  it('is accepted by parseManifest', () => {
    const text = serializeManifest(parsed(WITH_COMMENTS));
    expect(parsed(text).roots).toEqual(parsed(WITH_COMMENTS).roots);
  });
});
