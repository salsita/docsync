import { describe, expect, it } from 'vitest';
import {
  formatSourceRef,
  isSourceRef,
  isSourceRefError,
  parseSourceRef,
  parseSourceRefOrUrl,
  type SourceRef,
  sourceRefEquals,
} from './source-ref.js';

/** A canonical Notion id, and the same id in the forms people paste. */
const NID = '2f3a9c4b1e11eebe560242ac120002ab';
const NID_DASHED = '2f3a9c4b-1e11-eebe-5602-42ac120002ab';
const NID_UPPER = NID.toUpperCase();
const NID_DASHED_UPPER = NID_DASHED.toUpperCase();
/** A second Notion id, used as a decoy in queries and fragments. */
const OTHER = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

/** A Google id: opaque, 32 characters of the accepted alphabet. */
const GID = '1AbCdEfGhIjKlMnOpQrStUvWxYz-_012';

const notion: SourceRef = { source: 'notion', id: NID };
const gdocs: SourceRef = { source: 'gdocs', id: GID };

/** Literal refs: accepted by `parseSourceRef` and by `parseSourceRefOrUrl`. */
const LITERAL: Array<[string, SourceRef]> = [
  [`notion:${NID}`, notion],
  [`notion:${NID_UPPER}`, notion],
  [`notion:${NID_DASHED}`, notion],
  [`notion:${NID_DASHED_UPPER}`, notion],
  [`  notion:${NID}  `, notion],
  [`gdocs:${GID}`, gdocs],
  [`\tgdocs:${GID}\n`, gdocs],
];

/** URLs: accepted by `parseSourceRefOrUrl` only. */
const URLS: Array<[string, SourceRef]> = [
  // Notion.
  [`https://www.notion.so/${NID}`, notion],
  [`https://www.notion.so/Product-Specs-${NID}`, notion],
  [`https://www.notion.so/salsita/Product-Specs-${NID}`, notion],
  [`https://notion.so/Product-Specs-${NID}`, notion],
  // http is accepted too: it is a Notion URL, not a rejection.
  [`http://www.notion.so/Product-Specs-${NID}`, notion],
  [`https://salsita.notion.site/Product-Specs-${NID}`, notion],
  // The notion.com domain, and the app's own `/p/<workspace>/` shape.
  [`https://www.notion.com/Product-Specs-${NID}`, notion],
  [`https://app.notion.com/p/salsita/Product-Specs-${NID}`, notion],
  [`https://www.notion.so/salsita/Product-Specs-${NID_DASHED}`, notion],
  [`https://www.notion.so/Product-Specs-${NID_UPPER}`, notion],
  // A query is dropped, even when it carries another id.
  [`https://www.notion.so/Product-Specs-${NID}?v=${OTHER}`, notion],
  [`https://www.notion.so/Product-Specs-${NID}?pvs=4`, notion],
  // A #<hex> block anchor is not the page id; the path's id wins.
  [`https://www.notion.so/Product-Specs-${NID}#${OTHER}`, notion],
  // The last 32-hex run in the path wins, whatever precedes it.
  [`https://www.notion.so/${OTHER}/Product-Specs-${NID}`, notion],
  // Google.
  [`https://docs.google.com/document/d/${GID}/edit`, gdocs],
  [`https://docs.google.com/spreadsheets/d/${GID}/edit#gid=0`, gdocs],
  [`https://docs.google.com/presentation/d/${GID}/edit`, gdocs],
  [`https://docs.google.com/drawings/d/${GID}/edit`, gdocs],
  [`https://docs.google.com/document/u/0/d/${GID}/edit`, gdocs],
  [`https://docs.google.com/document/d/${GID}/edit?usp=sharing`, gdocs],
  [`https://docs.google.com/document/d/${GID}/edit#heading=h.abc`, gdocs],
  [`https://drive.google.com/drive/folders/${GID}`, gdocs],
  [`https://drive.google.com/drive/u/2/folders/${GID}`, gdocs],
  [`https://drive.google.com/file/d/${GID}/view`, gdocs],
  [`https://drive.google.com/open?id=${GID}`, gdocs],
  [`https://drive.google.com/open?id=${GID}&usp=sharing`, gdocs],
];

const ACCEPTED = [...LITERAL, ...URLS];

/** Rejected by both parsers. */
const REJECTED: string[] = [
  '',
  '   ',
  '\n',
  'notion',
  'notion:',
  ':2f3a9c',
  // 31 hex is not a Notion id.
  `notion:${NID.slice(1)}`,
  `notion:${NID}ab`,
  'notion:not-hexadecimal-at-all-here-x',
  'gdocs:',
  // Too short to be a Drive id.
  'gdocs:1AbCdE',
  // A ref may not contain a slash: that is what keeps ignore lists unambiguous.
  `gdocs:1AbCdE/${GID}`,
  `notion:${NID}/child`,
  `drive:${GID}`,
  `NOTION:${NID}`,
  `notion:${NID} ${NID}`,
  'Archive/**',
  '*.pdf',
  // A workspace root carries no id.
  'https://www.notion.so/',
  'https://www.notion.so/salsita',
  // The id is in the fragment only, which is dropped.
  `https://www.notion.so/#${NID}`,
  `https://example.com/${NID}`,
  `https://notion.so.example.com/${NID}`,
  `https://mail.google.com/document/d/${GID}/edit`,
  'https://docs.google.com/',
  `https://docs.google.com/document/${GID}/edit`,
  'https://drive.google.com/open',
  'https://drive.google.com/drive/folders/short',
  `ftp://www.notion.so/${NID}`,
  'not a url at all',
];

describe('parseSourceRef', () => {
  for (const [text, expected] of LITERAL) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      expect(parseSourceRef(text)).toEqual(expected);
    });
  }

  for (const text of [...URLS.map(([input]) => input), ...REJECTED]) {
    it(`is undefined for ${JSON.stringify(text)}`, () => {
      expect(parseSourceRef(text)).toBeUndefined();
    });
  }
});

describe('parseSourceRefOrUrl', () => {
  for (const [text, expected] of ACCEPTED) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      expect(parseSourceRefOrUrl(text)).toEqual(expected);
    });
  }

  for (const text of REJECTED) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      const result = parseSourceRefOrUrl(text);
      expect(isSourceRefError(result)).toBe(true);
      expect(isSourceRefError(result) && result.input).toBe(text);
      expect(isSourceRefError(result) && result.message).toContain('Not a source ref');
    });
  }

  it('names the accepted forms when nothing matches', () => {
    expect(parseSourceRefOrUrl('foo')).toEqual({
      input: 'foo',
      message:
        'Not a source ref: "foo". Expected notion:<id>, gdocs:<id>, ' +
        'or a Notion / Google Docs / Drive URL.',
    });
  });

  it('says what a Notion id looks like', () => {
    const result = parseSourceRefOrUrl(`notion:${NID.slice(1)}`);
    expect(isSourceRefError(result) && result.message).toContain('32 hex characters');
  });

  it('says what a Google id looks like', () => {
    const result = parseSourceRefOrUrl('gdocs:1AbCdE');
    expect(isSourceRefError(result) && result.message).toContain('at least 20 characters');
  });

  it('says a Notion URL needs a page id', () => {
    const result = parseSourceRefOrUrl('https://www.notion.so/salsita');
    expect(isSourceRefError(result) && result.message).toContain('Notion URL');
  });

  it('says a Google URL needs a document, file or folder id', () => {
    const result = parseSourceRefOrUrl('https://docs.google.com/');
    expect(isSourceRefError(result) && result.message).toContain('Google URL');
  });
});

describe('round trip', () => {
  for (const [text, expected] of ACCEPTED) {
    it(`normalises ${JSON.stringify(text)} to a stable ref`, () => {
      const once = parseSourceRefOrUrl(text);
      expect(isSourceRefError(once)).toBe(false);
      const canonical = formatSourceRef(once as SourceRef);
      expect(canonical).toBe(`${expected.source}:${expected.id}`);
      // The canonical form is itself a literal ref, and parses back to the same value.
      expect(parseSourceRef(canonical)).toEqual(expected);
      expect(parseSourceRefOrUrl(canonical)).toEqual(expected);
      expect(formatSourceRef(parseSourceRef(canonical) as SourceRef)).toBe(canonical);
      // Ticket 02's ignore lists need a ref entry to be slash-free.
      expect(canonical).not.toContain('/');
    });
  }
});

describe('isSourceRef', () => {
  for (const text of [...ACCEPTED.map(([input]) => input), ...REJECTED]) {
    it(`agrees with parseSourceRef on ${JSON.stringify(text)}`, () => {
      expect(isSourceRef(text)).toBe(parseSourceRef(text) !== undefined);
    });
  }
});

describe('isSourceRefError', () => {
  it('distinguishes a ref from an error', () => {
    expect(isSourceRefError(notion)).toBe(false);
    expect(isSourceRefError({ input: 'x', message: 'y' })).toBe(true);
  });
});

describe('formatSourceRef', () => {
  it('formats a ref built by hand', () => {
    expect(formatSourceRef({ source: 'gdocs', id: GID })).toBe(`gdocs:${GID}`);
  });
});

describe('sourceRefEquals', () => {
  it('compares source and id', () => {
    expect(sourceRefEquals({ source: 'notion', id: NID }, { source: 'notion', id: NID })).toBe(
      true,
    );
    expect(sourceRefEquals({ source: 'notion', id: NID }, { source: 'gdocs', id: NID })).toBe(
      false,
    );
    expect(sourceRefEquals({ source: 'notion', id: NID }, { source: 'notion', id: OTHER })).toBe(
      false,
    );
  });
});
