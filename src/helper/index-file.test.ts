import { describe, expect, it } from 'vitest';
import type { IndexEntry } from './index-file.js';
import { INDEX_PATH, parseIndex, serializeIndex } from './index-file.js';

const PAGE: IndexEntry = {
  path: 'Specs/Auth.md',
  src: { source: 'notion', id: 'a'.repeat(32) },
  type: 'notion-page',
  lastEditedTime: '2026-01-02T03:04:05.000Z',
};
const SHEET: IndexEntry = {
  path: 'Contracts/Rates.xlsx',
  src: { source: 'gdocs', id: '1AbCdEfGhIjKlMnOpQrStUv' },
  type: 'drive-file',
  lastEditedTime: '2026-01-01T00:00:00.000Z',
  readOnly: true,
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
};

describe('serializeIndex', () => {
  it('writes one mapping per entry, sorted by path, fields in a fixed order', () => {
    expect(serializeIndex([PAGE, SHEET])).toBe(
      [
        '- path: Contracts/Rates.xlsx',
        '  src: gdocs:1AbCdEfGhIjKlMnOpQrStUv',
        '  type: drive-file',
        '  lastEditedTime: 2026-01-01T00:00:00.000Z',
        '  readOnly: true',
        "  md5: 'd41d8cd98f00b204e9800998ecf8427e'",
        '- path: Specs/Auth.md',
        `  src: notion:${'a'.repeat(32)}`,
        '  type: notion-page',
        '  lastEditedTime: 2026-01-02T03:04:05.000Z',
        '',
      ].join('\n'),
    );
  });

  it('quotes an MD5 so that an all-digit one stays a string', () => {
    const digits = { ...SHEET, md5: '1'.repeat(32) };
    expect(parseIndex(serializeIndex([digits])).get(SHEET.path)?.md5).toBe('1'.repeat(32));
  });

  it('is stable: the same entries in any order give the same text', () => {
    expect(serializeIndex([SHEET, PAGE])).toBe(serializeIndex([PAGE, SHEET]));
  });

  it('writes an empty list for no entries', () => {
    expect(serializeIndex([])).toBe('[]\n');
  });

  it('names the file the helper writes', () => {
    expect(INDEX_PATH).toBe('.docsync/index.yaml');
  });
});

describe('parseIndex', () => {
  it('round-trips what serializeIndex wrote, keyed by path', () => {
    const parsed = parseIndex(serializeIndex([PAGE, SHEET]));
    expect([...parsed.keys()]).toEqual(['Contracts/Rates.xlsx', 'Specs/Auth.md']);
    expect(parsed.get('Specs/Auth.md')).toEqual(PAGE);
    expect(parsed.get('Contracts/Rates.xlsx')).toEqual(SHEET);
  });

  it('reads an empty file and an empty list as no entries', () => {
    expect(parseIndex('').size).toBe(0);
    expect(parseIndex('[]\n').size).toBe(0);
  });

  it('refuses anything that is not a list of well-formed entries', () => {
    expect(() => parseIndex('path: x\n')).toThrow(/\.docsync\/index\.yaml/);
    expect(() => parseIndex('- 3\n')).toThrow(/entry 1/);
    expect(() =>
      parseIndex('- path: a.md\n  src: nonsense\n  type: gdoc\n  lastEditedTime: t\n'),
    ).toThrow(/entry 1.*src/);
    expect(() =>
      parseIndex(
        '- path: a.md\n  src: gdocs:1AbCdEfGhIjKlMnOpQrStUv\n  type: nope\n  lastEditedTime: t\n',
      ),
    ).toThrow(/entry 1.*type/);
    expect(() =>
      parseIndex('- path: a.md\n  src: gdocs:1AbCdEfGhIjKlMnOpQrStUv\n  type: gdoc\n'),
    ).toThrow(/entry 1.*lastEditedTime/);
    expect(() =>
      parseIndex('- src: gdocs:1AbCdEfGhIjKlMnOpQrStUv\n  type: gdoc\n  lastEditedTime: t\n'),
    ).toThrow(/entry 1.*path/);
    expect(() =>
      parseIndex(
        '- path: a.md\n  src: gdocs:1AbCdEfGhIjKlMnOpQrStUv\n  type: gdoc\n  lastEditedTime: t\n  readOnly: yes please\n',
      ),
    ).toThrow(/entry 1.*readOnly/);
    expect(() =>
      parseIndex(
        '- path: a.md\n  src: gdocs:1AbCdEfGhIjKlMnOpQrStUv\n  type: gdoc\n  lastEditedTime: t\n  md5: 5\n',
      ),
    ).toThrow(/entry 1.*md5/);
  });
});
