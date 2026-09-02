import { describe, expect, it } from 'vitest';
import { assignNames, fileNameFor } from './filenames.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('fileNameFor', () => {
  const cases: Array<[string, string, string, string]> = [
    ['appends the extension', 'Auth', '.md', 'Auth.md'],
    ['takes an empty extension', 'diagram.png', '', 'diagram.png'],
    ['trims surrounding whitespace', '  Auth  ', '.md', 'Auth.md'],
    ['replaces reserved characters', 'a/b\\c:d*e?f"g<h>i|j', '.md', 'a-b-c-d-e-f-g-h-i-j.md'],
    ['replaces control characters', 'a\u0000b\u001fc\u007fd', '.md', 'a-b-c-d.md'],
    ['removes leading dots', '...env', '.md', 'env.md'],
    ['trims trailing dots and spaces', 'Notes. . .  ', '.md', 'Notes.md'],
    ['keeps inner dots', 'v1.2 notes', '.md', 'v1.2 notes.md'],
    ['suffixes a Windows reserved name', 'CON', '.md', 'CON-.md'],
    ['suffixes a reserved name whatever its case', 'con', '.md', 'con-.md'],
    ['suffixes COM1', 'COM1', '.md', 'COM1-.md'],
    ['suffixes LPT9', 'LPT9', '.md', 'LPT9-.md'],
    ['suffixes a reserved name that already carries an extension', 'CON.md', '', 'CON-.md'],
    ['leaves a name that merely starts like a reserved one', 'CONS', '.md', 'CONS.md'],
    ['leaves COM10 alone', 'COM10', '.md', 'COM10.md'],
    ['falls back to untitled for an empty title', '', '.md', 'untitled.md'],
    ['falls back to untitled for a title of only dots', '...', '.md', 'untitled.md'],
    ['falls back to untitled for a title of only spaces', '   ', '.md', 'untitled.md'],
    ['keeps emoji', '😀 Release notes', '.md', '😀 Release notes.md'],
  ];

  for (const [name, title, ext, expected] of cases) {
    it(name, () => {
      expect(fileNameFor(title, ext)).toBe(expected);
    });
  }

  it('normalises to NFC', () => {
    expect(fileNameFor('Cafe\u0301', '.md')).toBe('Caf\u00e9.md');
  });

  it('truncates a long ASCII title to 200 bytes including the extension', () => {
    const name = fileNameFor('a'.repeat(300), '.md');
    expect(bytes(name)).toBe(200);
    expect(name).toBe(`${'a'.repeat(197)}.md`);
  });

  it('truncates on a character boundary for multi-byte titles', () => {
    const name = fileNameFor('é'.repeat(300), '.md');
    expect(bytes(name)).toBeLessThanOrEqual(200);
    expect(name).toBe(`${'é'.repeat(98)}.md`);
  });

  it('does not split an astral character', () => {
    const name = fileNameFor('😀'.repeat(100), '.md');
    expect(bytes(name)).toBeLessThanOrEqual(200);
    expect(name).toBe(`${'😀'.repeat(49)}.md`);
    expect(name).not.toContain('�');
  });

  it('re-trims after truncating', () => {
    const name = fileNameFor(`${'a'.repeat(196)} b`, '.md');
    expect(name).toBe(`${'a'.repeat(196)}.md`);
  });

  it('falls back to untitled when truncation empties the stem', () => {
    expect(fileNameFor('abc', '.'.repeat(210))).toBe(`untitled${'.'.repeat(210)}`);
  });
});

describe('assignNames', () => {
  const sib = (id: string, title: string, ext = '.md') => ({ id, title, ext });

  it('names a single document from its title', () => {
    expect(assignNames([sib('a', 'Notes')])).toEqual(new Map([['a', 'Notes.md']]));
  });

  it('suffixes collisions in id order', () => {
    const names = assignNames([sib('b', 'Notes'), sib('a', 'Notes'), sib('c', 'Notes')]);
    expect(names).toEqual(
      new Map([
        ['a', 'Notes.md'],
        ['b', 'Notes (2).md'],
        ['c', 'Notes (3).md'],
      ]),
    );
  });

  it('treats a collision as a collision regardless of case', () => {
    const names = assignNames([sib('a', 'Notes'), sib('b', 'notes')]);
    expect(names).toEqual(
      new Map([
        ['a', 'Notes.md'],
        ['b', 'notes (2).md'],
      ]),
    );
  });

  it('does not collide across extensions', () => {
    const names = assignNames([sib('a', 'Notes'), sib('b', 'Notes', '.pdf')]);
    expect(names).toEqual(
      new Map([
        ['a', 'Notes.md'],
        ['b', 'Notes.pdf'],
      ]),
    );
  });

  it('keeps a previous name, suffix and all, after the other document is gone', () => {
    const previous = new Map([
      ['a', 'Notes.md'],
      ['b', 'Notes (2).md'],
    ]);
    expect(assignNames([sib('b', 'Notes')], previous)).toEqual(new Map([['b', 'Notes (2).md']]));
  });

  it('keeps previous names stable when a new sibling arrives', () => {
    const previous = new Map([['b', 'Notes (2).md']]);
    const names = assignNames([sib('b', 'Notes'), sib('c', 'Notes')], previous);
    expect(names).toEqual(
      new Map([
        ['b', 'Notes (2).md'],
        ['c', 'Notes.md'],
      ]),
    );
  });

  it('drops a previous name when the title no longer derives to it', () => {
    const previous = new Map([['a', 'Notes (2).md']]);
    expect(assignNames([sib('a', 'Minutes')], previous)).toEqual(new Map([['a', 'Minutes.md']]));
  });

  it('keeps an unsuffixed previous name', () => {
    const previous = new Map([['a', 'Notes.md']]);
    expect(assignNames([sib('a', 'Notes')], previous)).toEqual(new Map([['a', 'Notes.md']]));
  });

  it('drops an unsuffixed previous name when the title changed', () => {
    const previous = new Map([['a', 'Notes.md']]);
    expect(assignNames([sib('a', 'Minutes')], previous)).toEqual(new Map([['a', 'Minutes.md']]));
  });

  it('keeps a suffixed previous name for an extensionless document', () => {
    const previous = new Map([['a', 'deal (2)']]);
    expect(assignNames([sib('a', 'deal', '')], previous)).toEqual(new Map([['a', 'deal (2)']]));
  });

  it('puts the suffix before the extension, so callers should split it off', () => {
    // A Drive file's own extension belongs in `ext`, not in `title`: passing
    // "deal.pdf" as the title would suffix to "deal.pdf (2)".
    const names = assignNames([sib('a', 'deal', '.pdf'), sib('b', 'deal', '.pdf')]);
    expect(names.get('b')).toBe('deal (2).pdf');
  });

  it('drops a previous name when the extension changed', () => {
    const previous = new Map([['a', 'Notes.md']]);
    expect(assignNames([sib('a', 'Notes', '.pdf')], previous)).toEqual(
      new Map([['a', 'Notes.pdf']]),
    );
  });

  it('ignores previous entries for documents that are gone', () => {
    const previous = new Map([['gone', 'Notes.md']]);
    expect(assignNames([sib('a', 'Notes')], previous)).toEqual(new Map([['a', 'Notes.md']]));
  });

  it('keeps a suffixed name inside the byte budget', () => {
    const names = assignNames([sib('a', 'a'.repeat(300)), sib('b', 'a'.repeat(300))]);
    for (const name of names.values()) expect(bytes(name)).toBeLessThanOrEqual(200);
    expect(names.get('b')).toBe(`${'a'.repeat(193)} (2).md`);
  });
});
