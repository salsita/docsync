import { describe, expect, it } from 'vitest';
import { parseManifest } from './parse.js';

function errorsOf(text: string): Array<{ line: number; message: string }> {
  const result = parseManifest(text);
  if (result.ok) throw new Error(`expected errors, got a manifest:\n${text}`);
  return result.errors.map((error) => ({ line: error.line, message: error.message }));
}

function manifestOf(text: string) {
  const result = parseManifest(text);
  if (!result.ok) {
    throw new Error(`expected a manifest, got: ${result.errors.map((e) => e.message).join(', ')}`);
  }
  return result.manifest;
}

describe('parseManifest', () => {
  it('parses the manual example', () => {
    const manifest = manifestOf(`version: 1
roots:
  - src: notion:2f3a9c4b1e11eebe560242ac120002ab
    path: Product Specs/
  - src: gdocs:1AbCdEfGhIjKlMnOpQrStUvWxYz-_012
    path: Contracts/
    ignore:
      - "Archive/**"
      - "gdocs:9XyZabcdefghijklmnopqrstuvwxyz01"
  - src: gdocs:7QrSabcdefghijklmnopqrstuvwxyz01
    path: notes/roadmap.md
`);
    expect(manifest.version).toBe(1);
    expect(manifest.roots).toEqual([
      {
        src: { source: 'notion', id: '2f3a9c4b1e11eebe560242ac120002ab' },
        path: 'Product Specs/',
        ignore: [],
      },
      {
        src: { source: 'gdocs', id: '1AbCdEfGhIjKlMnOpQrStUvWxYz-_012' },
        path: 'Contracts/',
        ignore: ['Archive/**', 'gdocs:9XyZabcdefghijklmnopqrstuvwxyz01'],
      },
      {
        src: { source: 'gdocs', id: '7QrSabcdefghijklmnopqrstuvwxyz01' },
        path: 'notes/roadmap.md',
        ignore: [],
      },
    ]);
  });

  it('accepts an empty roots list', () => {
    const manifest = manifestOf('version: 1\nroots: []\n');
    expect(manifest.roots).toEqual([]);
  });

  it('accepts a null roots value as empty', () => {
    const manifest = manifestOf('version: 1\nroots:\n');
    expect(manifest.roots).toEqual([]);
  });

  it('reads `comments: true` on a root (MANUAL §4)', () => {
    const manifest = manifestOf(
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n    comments: true\n',
    );
    expect(manifest.roots[0]?.comments).toBe(true);
  });

  it('keeps an explicit `comments: false`', () => {
    const manifest = manifestOf(
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n    comments: false\n',
    );
    expect(manifest.roots[0]?.comments).toBe(false);
  });

  it('leaves `comments` absent on a root that does not mention it, which is off', () => {
    const manifest = manifestOf(
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n',
    );
    expect(manifest.roots[0]?.comments).toBeUndefined();
  });

  it('normalises paths to NFC', () => {
    // "Cafe" + combining acute (NFD) comes back precomposed.
    const manifest = manifestOf(
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Cafe\u0301/\n',
    );
    expect(manifest.roots[0]?.path).toBe('Caf\u00e9/');
  });

  const cases: Array<[string, string, string, number]> = [
    // The unterminated flow sequence is only detectable at end of input, so
    // the parser's position is the last line, not the line it opened on.
    ['invalid YAML', 'version: 1\nroots:\n  - [unclosed\n', 'YAML', 4],
    ['a non-map document', '- one\n- two\n', 'must be a mapping', 1],
    ['an empty document', '', 'must be a mapping', 1],
    ['a missing version', 'roots: []\n', 'missing "version"', 1],
    ['an unknown version', 'version: 2\nroots: []\n', 'unknown version', 1],
    ['a non-numeric version', 'version: one\nroots: []\n', 'unknown version', 1],
    ['missing roots', 'version: 1\n', 'missing "roots"', 1],
    ['roots that are not a list', 'version: 1\nroots:\n  a: b\n', '"roots" must be a list', 3],
    ['an unknown top-level key', 'version: 1\nroots: []\nextra: 1\n', 'unknown key "extra"', 3],
    ['a root that is not a mapping', 'version: 1\nroots:\n  - hello\n', 'must be a mapping', 3],
    ['a root without src', 'version: 1\nroots:\n  - path: Specs/\n', 'root is missing "src"', 3],
    [
      'a root without path',
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      'root is missing "path"',
      3,
    ],
    [
      'a src that is not a source ref',
      'version: 1\nroots:\n  - src: notion\n    path: Specs/\n',
      'not a source ref',
      3,
    ],
    [
      'a non-string src',
      'version: 1\nroots:\n  - src: 12\n    path: Specs/\n',
      'not a source ref',
      3,
    ],
    [
      'a non-string path',
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: 12\n',
      '"path" must be a string',
      4,
    ],
    [
      'an unknown root key',
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n    depth: 2\n',
      'unknown key "depth"',
      5,
    ],
    [
      'a comments value that is not a boolean',
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n    comments: yes please\n',
      '"comments" must be true or false',
      5,
    ],
    [
      'an ignore that is not a list',
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n    ignore: "Archive/**"\n',
      '"ignore" must be a list of strings',
      5,
    ],
    [
      'an ignore entry that is not a string',
      'version: 1\nroots:\n  - src: notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n    path: Specs/\n    ignore:\n      - 12\n',
      '"ignore" must be a list of strings',
      6,
    ],
  ];

  for (const [name, text, fragment, line] of cases) {
    it(`reports ${name}`, () => {
      const errors = errorsOf(text);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(fragment);
      expect(errors[0]?.line).toBe(line);
    });
  }

  it('reports every error, not just the first', () => {
    const errors = errorsOf(`version: 3
roots:
  - path: Specs/
  - src: notion:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
`);
    expect(errors.map((error) => error.line)).toEqual([1, 3, 4]);
  });
});
