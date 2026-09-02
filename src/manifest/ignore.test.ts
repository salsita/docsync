import { describe, expect, it } from 'vitest';
import { parseSourceRef, type SourceRef } from '../source-ref.js';
import { isIgnored } from './ignore.js';
import type { Root } from './types.js';

const ROOT_REF: SourceRef = { source: 'notion', id: 'dddddddddddddddddddddddddddddddd' };
const ref = (text: string): SourceRef => {
  const parsed = parseSourceRef(text);
  if (!parsed) throw new Error(`bad ref in test: ${text}`);
  return parsed;
};

const root = (...ignore: string[]): Root => ({ src: ROOT_REF, path: 'Specs/', ignore });

describe('isIgnored', () => {
  it('ignores nothing when the list is empty', () => {
    expect(
      isIgnored(root(), 'Archive/deal.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
    ).toBe(false);
  });

  describe('gitignore patterns', () => {
    it('matches a glob', () => {
      expect(
        isIgnored(
          root('Archive/**'),
          'Archive/2023/deal.md',
          ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ),
      ).toBe(true);
      expect(
        isIgnored(
          root('Archive/**'),
          'Current/deal.md',
          ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ),
      ).toBe(false);
    });

    it('matches a directory pattern', () => {
      expect(
        isIgnored(
          root('Archive/'),
          'Archive/deal.md',
          ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ),
      ).toBe(true);
      expect(
        isIgnored(root('Archive/'), 'Archive/', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(true);
    });

    it('matches an extension pattern anywhere', () => {
      expect(
        isIgnored(
          root('*.pdf'),
          'Contracts/2024/deal.pdf',
          ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ),
      ).toBe(true);
      expect(
        isIgnored(
          root('*.pdf'),
          'Contracts/2024/deal.md',
          ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ),
      ).toBe(false);
    });

    it('matches a name with a wildcard', () => {
      const r = root('Meeting notes/2023-*');
      expect(
        isIgnored(r, 'Meeting notes/2023-04-01.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(true);
      expect(
        isIgnored(r, 'Meeting notes/2024-04-01.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(false);
    });

    it('honours negation patterns', () => {
      const r = root('Archive/**', '!Archive/2024/', '!Archive/2024/**');
      expect(
        isIgnored(r, 'Archive/2023/deal.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(true);
      expect(
        isIgnored(r, 'Archive/2024/deal.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(false);
    });

    it('follows git in refusing to re-include from an excluded directory', () => {
      // `Archive/**` excludes the directory `Archive/2024` itself, and git does
      // not look inside an excluded directory. Re-including needs the directory
      // to be re-included first, as in the case above.
      const r = root('Archive/**', '!Archive/2024/**');
      expect(
        isIgnored(r, 'Archive/2024/deal.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(true);
    });

    it('normalises the candidate path to NFC before matching', () => {
      expect(
        isIgnored(root('Café/**'), 'Café/deal.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
      ).toBe(true);
    });
  });

  describe('source-ref patterns', () => {
    it('matches the document by id, whatever its path', () => {
      const r = root('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d');
      expect(
        isIgnored(r, 'Anywhere/at all.md', ref('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d')),
      ).toBe(true);
      expect(
        isIgnored(r, 'Anywhere/at all.md', ref('notion:cccccccccccccccccccccccccccccccc')),
      ).toBe(false);
    });

    it('does not confuse the two sources', () => {
      expect(
        isIgnored(
          root('gdocs:8c1dabcdefghijklmnopqrstuvwxyz01'),
          'a.md',
          ref('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d'),
        ),
      ).toBe(false);
    });

    it('matches every descendant of the ignored object', () => {
      const r = root('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d');
      expect(
        isIgnored(r, 'Deep/child.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), [
          ROOT_REF,
          ref('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d'),
        ]),
      ).toBe(true);
      expect(
        isIgnored(r, 'Deep/child.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), [
          ROOT_REF,
          ref('notion:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        ]),
      ).toBe(false);
    });

    it('is not undone by a negation pattern', () => {
      const r = root('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d', '!**');
      expect(
        isIgnored(r, 'Anywhere/at all.md', ref('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d')),
      ).toBe(true);
    });

    it('is not also treated as a gitignore pattern', () => {
      expect(
        isIgnored(
          root('notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d'),
          'notion:8c1d8c1d8c1d8c1d8c1d8c1d8c1d8c1d',
          ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        ),
      ).toBe(false);
    });
  });

  describe('the root itself', () => {
    it('is never ignored, whatever the patterns say', () => {
      const r = root('**', 'notion:dddddddddddddddddddddddddddddddd');
      expect(isIgnored(r, '', ROOT_REF)).toBe(false);
      expect(isIgnored(r, '.', ROOT_REF)).toBe(false);
    });

    it('is never ignored by its own ref appearing in the list', () => {
      expect(isIgnored(root('notion:dddddddddddddddddddddddddddddddd'), 'Specs.md', ROOT_REF)).toBe(
        false,
      );
    });

    it('does not protect a different document that sits at the root path', () => {
      expect(isIgnored(root('**'), 'Auth.md', ref('notion:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toBe(
        true,
      );
    });
  });
});
