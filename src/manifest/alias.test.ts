import { describe, expect, it } from 'vitest';
import { resolveAlias } from './alias.js';
import type { Kind } from './types.js';

function path(alias: string | undefined, kind: Kind, title = 'Auth', ext?: string): string {
  const result = resolveAlias(alias, ext === undefined ? { title, kind } : { title, kind, ext });
  if (!result.ok) throw new Error(`expected a path, got: ${result.message}`);
  return result.path;
}

function error(alias: string | undefined, kind: Kind, title = 'Auth'): string {
  const result = resolveAlias(alias, { title, kind });
  if (result.ok) throw new Error(`expected an error, got: ${result.path}`);
  return result.message;
}

describe('resolveAlias', () => {
  describe('the table in MANUAL §5', () => {
    it('no alias, leaf', () => {
      expect(path(undefined, 'leaf')).toBe('Auth.md');
    });

    it('no alias, container', () => {
      expect(path(undefined, 'container')).toBe('Auth/');
    });

    it('directory alias, leaf', () => {
      expect(path('specs/', 'leaf')).toBe('specs/Auth.md');
    });

    it('directory alias, container', () => {
      expect(path('specs/', 'container')).toBe('specs/Auth/');
    });

    it('file alias, leaf', () => {
      expect(path('specs/auth.md', 'leaf')).toBe('specs/auth.md');
    });

    it('file alias, container', () => {
      expect(error('specs/auth.md', 'container')).toContain('a container cannot be a file');
    });

    it('extensionless alias, leaf', () => {
      expect(error('specs/auth', 'leaf')).toContain('needs an extension');
    });

    it('extensionless alias, container', () => {
      expect(path('specs/auth', 'container')).toBe('specs/auth/');
    });
  });

  it('treats an empty alias as no alias', () => {
    expect(path('', 'leaf')).toBe('Auth.md');
  });

  it('keeps a non-markdown extension on a file alias', () => {
    expect(path('contracts/2024.pdf', 'leaf')).toBe('contracts/2024.pdf');
  });

  it("uses the object's own extension for a leaf named by title", () => {
    expect(path(undefined, 'leaf', 'Q1 report', '.pdf')).toBe('Q1 report.pdf');
    expect(path('contracts/', 'leaf', 'Q1 report', '.pdf')).toBe('contracts/Q1 report.pdf');
  });

  it('sanitises a title that contains a slash', () => {
    expect(path(undefined, 'leaf', 'A/B')).toBe('A-B.md');
    expect(path('specs/', 'container', 'A/B')).toBe('specs/A-B/');
  });

  it('sanitises a title that is only dots', () => {
    expect(path(undefined, 'leaf', '...')).toBe('untitled.md');
    expect(path(undefined, 'container', '...')).toBe('untitled/');
  });

  it('sanitises a title that is a Windows reserved name', () => {
    expect(path(undefined, 'leaf', 'CON')).toBe('CON-.md');
    expect(path(undefined, 'container', 'NUL')).toBe('NUL-/');
  });

  const badAliases = ['/specs/', '../specs/', './specs/', 'specs//auth.md', 'specs\\auth.md'];
  for (const alias of badAliases) {
    it(`rejects the alias ${JSON.stringify(alias)}`, () => {
      expect(error(alias, 'leaf')).toContain('path');
    });
  }

  it('rejects an alias that is only a slash', () => {
    expect(error('/', 'container')).toContain('relative');
  });
});
