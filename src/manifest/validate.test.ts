import { describe, expect, it } from 'vitest';
import type { SourceRef } from '../source-ref.js';
import type { Root } from './types.js';
import { isInsideRepository, isUnderRoot, rootOf, validateRoots } from './validate.js';

let counter = 0;
function root(path: string, src?: SourceRef): Root {
  counter += 1;
  return { src: src ?? { source: 'notion', id: `id${counter}` }, path, ignore: [] };
}

function messages(...paths: string[]): string[] {
  return validateRoots(paths.map((path) => root(path))).map((error) => error.message);
}

describe('validateRoots', () => {
  describe('path syntax', () => {
    const accepted = [
      'Product Specs/',
      'notes/roadmap.md',
      'a/b/c/',
      'Contracts/2024 Q1/deal.pdf',
      'a.md',
      'Café/',
      'Café/', // NFD, normalised before checking
    ];
    for (const path of accepted) {
      it(`accepts ${JSON.stringify(path)}`, () => {
        expect(messages(path)).toEqual([]);
      });
    }

    const rejected: Array<[string, string]> = [
      ['', 'must not be empty'],
      ['/', 'must be relative'],
      ['/Specs/', 'must be relative'],
      ['./Specs/', 'must not contain a "." segment'],
      ['Specs/./Auth/', 'must not contain a "." segment'],
      ['../Specs/', 'must not contain a ".." segment'],
      ['Specs/../Auth/', 'must not contain a ".." segment'],
      ['Specs//Auth/', 'must not contain an empty segment'],
      ['Specs\\Auth/', 'must not contain a backslash'],
      ['.hidden/', 'must not start with a dot'],
      ['Specs/.auth.md', 'must not start with a dot'],
      ['Specs/auth', 'file root needs an extension'],
      ['auth', 'file root needs an extension'],
    ];
    for (const [path, fragment] of rejected) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        const errors = messages(path);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(fragment);
      });
    }
  });

  describe('overlap', () => {
    it('rejects the same path twice', () => {
      const errors = messages('Specs/', 'Specs/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('duplicate path');
    });

    it('rejects paths that differ only in case', () => {
      const errors = messages('Specs/', 'specs/');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('differ only in case');
    });

    it('rejects file paths that differ only in case', () => {
      expect(messages('a.md', 'A.md')[0]).toContain('differ only in case');
    });

    it('rejects paths that differ only in Unicode normalisation', () => {
      expect(messages('Café/', 'Café/')[0]).toContain('duplicate path');
    });

    it('rejects a root nested in a directory root, in both orders', () => {
      expect(messages('Specs/', 'Specs/Auth/')[0]).toContain('overlaps');
      expect(messages('Specs/Auth/', 'Specs/')[0]).toContain('overlaps');
    });

    it('rejects a root nested in a directory root regardless of case', () => {
      expect(messages('Specs/', 'specs/auth.md')[0]).toContain('overlaps');
    });

    it("rejects a root inside a file root's sibling directory", () => {
      // specs/auth.md owns specs/auth/ too: that is where its children land.
      expect(messages('specs/auth.md', 'specs/auth/notes.md')[0]).toContain('overlaps');
    });

    it('accepts a directory root beside a file root with the same stem', () => {
      // `a/` and `a.md` are what one Notion page with children produces, so the
      // pair itself is allowed; only a root strictly inside `a/` overlaps.
      expect(messages('a/', 'a.md')).toEqual([]);
      expect(messages('specs/auth.md', 'specs/auth/')).toEqual([]);
    });

    it('accepts paths that share a string prefix but not a segment prefix', () => {
      expect(messages('Specs/', 'Specifications/')).toEqual([]);
      expect(messages('a.md', 'ab.md')).toEqual([]);
    });

    it('accepts unrelated roots', () => {
      expect(messages('Specs/', 'Contracts/', 'notes/roadmap.md')).toEqual([]);
    });

    it('reports every problem, not just the first', () => {
      const errors = validateRoots([root('/bad/'), root('Specs/'), root('Specs/'), root('x')]);
      expect(errors.map((error) => error.rootIndex)).toEqual([0, 2, 3]);
      expect(errors[1]?.path).toBe('Specs/');
    });

    it('does not compare a root against itself', () => {
      expect(messages('Specs/')).toEqual([]);
    });
  });

  describe('isUnderRoot', () => {
    it('claims everything inside a directory root', () => {
      expect(isUnderRoot('Specs/', 'Specs/Auth.md')).toBe(true);
      expect(isUnderRoot('Specs/', 'Specs/Auth/Deep.md')).toBe(true);
      expect(isUnderRoot('Specs/', 'Specifications/Auth.md')).toBe(false);
      expect(isUnderRoot('Specs/', 'Contracts/Auth.md')).toBe(false);
    });

    it('claims a file root and the sibling directory of the same stem', () => {
      expect(isUnderRoot('notes/roadmap.md', 'notes/roadmap.md')).toBe(true);
      expect(isUnderRoot('notes/roadmap.md', 'notes/roadmap/Q1.md')).toBe(true);
      expect(isUnderRoot('notes/roadmap.md', 'notes/other.md')).toBe(false);
    });

    it('compares after NFC normalisation, as every path rule does', () => {
      expect(isUnderRoot('Spe\u0301cs/', 'Sp\u00e9cs/Auth.md')).toBe(true);
    });
  });
  describe('rootOf', () => {
    const roots = [root('Specs/'), root('notes/roadmap.md'), root('Contracts/')];

    it('answers the root a checked-out path belongs to', () => {
      expect(rootOf(roots, 'Specs/Auth.md')?.path).toBe('Specs/');
      expect(rootOf(roots, 'notes/roadmap.md')?.path).toBe('notes/roadmap.md');
      expect(rootOf(roots, 'notes/roadmap/Q1.md')?.path).toBe('notes/roadmap.md');
    });

    it('answers undefined for a path no root claims, which is a local file', () => {
      expect(rootOf(roots, 'README.md')).toBeUndefined();
      expect(rootOf(roots, 'notes/scratch.md')).toBeUndefined();
      expect(rootOf(roots, '.docsync/index.yaml')).toBeUndefined();
      expect(rootOf([], 'anything.md')).toBeUndefined();
    });
  });

  describe('isInsideRepository (MANUAL §4, ticket 35)', () => {
    it('accepts a path that names something in the checkout', () => {
      for (const path of ['Specs/', 'notes/roadmap.md', 'a/b/c.md', 'Caf\u00e9/']) {
        expect(isInsideRepository(path), path).toBe(true);
      }
    });

    it('refuses the repository itself, a path outside it, and docsync’s own directory', () => {
      for (const path of [
        '',
        '.',
        './',
        '/Specs/',
        '/',
        '../Specs/',
        'Specs/../..',
        './Specs/',
        '.docsync/',
        '.docsync/index.yaml',
      ]) {
        expect(isInsideRepository(path), path).toBe(false);
      }
    });
  });
});
