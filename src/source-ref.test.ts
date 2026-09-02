import { describe, expect, it } from 'vitest';
import { formatSourceRef, parseSourceRef, sourceRefEquals } from './source-ref.js';

describe('parseSourceRef', () => {
  const accepted: Array<[string, { source: string; id: string }]> = [
    ['notion:2f3a9c', { source: 'notion', id: '2f3a9c' }],
    ['gdocs:1AbCdE', { source: 'gdocs', id: '1AbCdE' }],
    [
      'notion:2f3a9c-4b1e-11ee-be56-0242ac120002',
      {
        source: 'notion',
        id: '2f3a9c-4b1e-11ee-be56-0242ac120002',
      },
    ],
    ['gdocs:1a_B-c.d', { source: 'gdocs', id: '1a_B-c.d' }],
  ];

  for (const [text, expected] of accepted) {
    it(`accepts ${text}`, () => {
      expect(parseSourceRef(text)).toEqual(expected);
    });
  }

  const rejected = [
    '',
    'notion:',
    ':2f3a9c',
    'notion',
    'drive:1AbCdE',
    'NOTION:2f3a9c',
    'notion:2f3a 9c',
    'Archive/**',
    'notion:a/b',
    '*.pdf',
    'https://notion.so/2f3a9c',
    ' notion:2f3a9c',
  ];

  for (const text of rejected) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseSourceRef(text)).toBeUndefined();
    });
  }
});

describe('formatSourceRef', () => {
  it('round-trips a parsed ref', () => {
    const ref = parseSourceRef('notion:2f3a9c');
    expect(ref).toBeDefined();
    expect(formatSourceRef(ref as { source: 'notion'; id: string })).toBe('notion:2f3a9c');
  });

  it('formats a ref built by hand', () => {
    expect(formatSourceRef({ source: 'gdocs', id: '1AbCdE' })).toBe('gdocs:1AbCdE');
  });
});

describe('sourceRefEquals', () => {
  it('compares source and id', () => {
    expect(sourceRefEquals({ source: 'notion', id: 'a' }, { source: 'notion', id: 'a' })).toBe(
      true,
    );
    expect(sourceRefEquals({ source: 'notion', id: 'a' }, { source: 'gdocs', id: 'a' })).toBe(
      false,
    );
    expect(sourceRefEquals({ source: 'notion', id: 'a' }, { source: 'notion', id: 'b' })).toBe(
      false,
    );
  });
});
