import { describe, expect, it } from 'vitest';
import {
  docRefOf,
  formatSourceRef,
  isSourceRef,
  isSourceRefError,
  parseSourceRef,
  parseSourceRefOrUrl,
  type SourceRef,
  sourceRefEquals,
  sourceUrl,
  splitCalendarRef,
  splitGDocsRef,
  tabRef,
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

/** A Docs tab id. Google spells every one of them `t.` and then some. */
const TAB = 't.tnk7m8xbx5t9';

/** A Calendar event id: base32hex, which is lowercase a-v and the digits. */
const EVENT = '0gce3vkvut6cj027fb86qrtc2a';
/** A calendar id, which is an address and therefore holds an `@` of its own. */
const CALENDAR = 'jirist@salsitasoft.com';
/** Calendar's own `eid`: unpadded base64url of `<eventId> <calendarId>`. */
const EID = 'MGdjZTN2a3Z1dDZjajAyN2ZiODZxcnRjMmEgamlyaXN0QHNhbHNpdGFzb2Z0LmNvbQ';

const notion: SourceRef = { source: 'notion', id: NID };
const gdocs: SourceRef = { source: 'gdocs', id: GID };
const gdocsTab: SourceRef = { source: 'gdocs', id: `${GID}#${TAB}` };
const event: SourceRef = { source: 'calendar', id: EVENT };
const elsewhere: SourceRef = { source: 'calendar', id: `${EVENT}@${CALENDAR}` };

/** Literal refs: accepted by `parseSourceRef` and by `parseSourceRefOrUrl`. */
const LITERAL: Array<[string, SourceRef]> = [
  [`notion:${NID}`, notion],
  [`notion:${NID_UPPER}`, notion],
  [`notion:${NID_DASHED}`, notion],
  [`notion:${NID_DASHED_UPPER}`, notion],
  [`  notion:${NID}  `, notion],
  [`gdocs:${GID}`, gdocs],
  [`\tgdocs:${GID}\n`, gdocs],
  // One tab of a Google Doc (MANUAL §6, #37). The id stays one token.
  [`gdocs:${GID}#${TAB}`, gdocsTab],
  // A calendar event, on the user's primary calendar or on another one, split
  // at the first `@` — the rest is an address and carries one (#38).
  [`calendar:${EVENT}`, event],
  [`calendar:${EVENT}@${CALENDAR}`, elsewhere],
  [`calendar:${EVENT}@primary`, event],
  // One instance of a recurring event names the series it belongs to.
  [`calendar:${EVENT}_20260901T070000Z`, event],
  [`calendar:${EVENT}_20260901T070000Z@${CALENDAR}`, elsewhere],
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
  // A tab's own URL names the whole Doc: `docsync add` adds all of it (#37).
  [`https://docs.google.com/document/d/${GID}/edit?tab=${TAB}`, gdocs],
  [`https://drive.google.com/drive/folders/${GID}`, gdocs],
  [`https://drive.google.com/drive/u/2/folders/${GID}`, gdocs],
  [`https://drive.google.com/file/d/${GID}/view`, gdocs],
  [`https://drive.google.com/open?id=${GID}`, gdocs],
  [`https://drive.google.com/open?id=${GID}&usp=sharing`, gdocs],
  // Calendar. The one place the UI shows an event id is the `eid` (#38).
  [`https://calendar.google.com/calendar/u/0/r/eventedit/${EID}`, elsewhere],
  [`https://calendar.google.com/calendar/r/eventedit/${EID}`, elsewhere],
  [`https://calendar.google.com/calendar/event?eid=${EID}`, elsewhere],
  [`https://calendar.google.com/calendar/u/0/r/eventedit/${EID}?pli=1`, elsewhere],
  // The padded spelling of the same token, which some clients produce.
  [`https://calendar.google.com/calendar/event?eid=${EID}%3D%3D`, elsewhere],
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
  // A fragment is a tab and nothing else: every tab id starts with `t.`, which
  // is what keeps `#<n>` (an object anchor) out of an id (#37).
  `gdocs:${GID}#`,
  `gdocs:${GID}#heading`,
  `gdocs:${GID}#3`,
  `gdocs:${GID}#${TAB}#${TAB}`,
  `gdocs:1AbCdE#${TAB}`,
  `notion:${NID}#${TAB}`,
  // A calendar event id is base32hex and at least five characters, and the
  // calendar after the `@` is not empty (#38).
  'calendar:',
  'calendar:abc',
  'calendar:zzzzzz',
  `calendar:${EVENT}@`,
  `calendar:${EVENT.toUpperCase()}`,
  // A Calendar URL whose `eid` is not `<eventId> <calendarId>` in base64url.
  'https://calendar.google.com/calendar/event?eid=***',
  'https://calendar.google.com/calendar/event?eid=bm90YW5ldmVudA',
  'https://calendar.google.com/calendar/r/week/2026/9/1',
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
        'Not a source ref: "foo". Expected notion:<id>, gdocs:<id>, calendar:<eventId>, ' +
        'or a Notion / Google Docs / Drive / Calendar URL.',
    });
  });

  it('says what a calendar event id looks like', () => {
    const result = parseSourceRefOrUrl('calendar:zzzzzz');
    expect(isSourceRefError(result) && result.message).toContain('lowercase a-v');
  });

  it('says a Calendar URL needs an event token', () => {
    const result = parseSourceRefOrUrl('https://calendar.google.com/calendar/r/week');
    expect(isSourceRefError(result) && result.message).toContain('Calendar URL');
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
      // #2's ignore lists need a ref entry to be slash-free.
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

describe('splitGDocsRef', () => {
  it('splits a tab ref into the Doc and the tab (#37)', () => {
    expect(splitGDocsRef(gdocsTab)).toEqual({ docId: GID, tabId: TAB });
  });

  it('answers the Doc alone for a ref that names no tab', () => {
    expect(splitGDocsRef(gdocs)).toEqual({ docId: GID });
  });

  it('answers the Doc of a tab ref, which is what the manifest holds', () => {
    expect(docRefOf(gdocsTab)).toEqual(gdocs);
    expect(docRefOf(gdocs)).toEqual(gdocs);
  });
});

describe('splitCalendarRef', () => {
  it('splits a calendar ref into the event and the calendar (#38)', () => {
    expect(splitCalendarRef(elsewhere)).toEqual({ eventId: EVENT, calendarId: CALENDAR });
  });

  it('answers the primary calendar for a ref that names none', () => {
    expect(splitCalendarRef(event)).toEqual({ eventId: EVENT, calendarId: 'primary' });
  });

  it('cuts an instance id down to its series', () => {
    expect(
      splitCalendarRef({ source: 'calendar', id: `${EVENT}_20260901T070000Z@${CALENDAR}` }),
    ).toEqual({ eventId: EVENT, calendarId: CALENDAR });
  });
});

describe('tabRef', () => {
  it('builds the ref a tab file carries, and round-trips it', () => {
    const ref = tabRef(GID, TAB);
    expect(formatSourceRef(ref)).toBe(`gdocs:${GID}#${TAB}`);
    expect(parseSourceRef(formatSourceRef(ref))).toEqual(ref);
  });

  it('is the plain Doc ref when there is no tab to name', () => {
    expect(tabRef(GID, undefined)).toEqual(gdocs);
    expect(tabRef(GID, '')).toEqual(gdocs);
  });
});

describe('sourceUrl', () => {
  it('a Notion page, without a workspace slug', () => {
    // The slug is decoration: Notion redirects a bare id to the real URL.
    expect(sourceUrl({ source: 'notion', id: NID })).toBe(`https://www.notion.so/${NID}`);
  });

  it('every Google kind, by the mime type Drive reports', () => {
    const url = (mimeType: string) => sourceUrl({ source: 'gdocs', id: GID }, mimeType);
    expect(url('application/vnd.google-apps.document')).toBe(
      `https://docs.google.com/document/d/${GID}/edit`,
    );
    expect(url('application/vnd.google-apps.spreadsheet')).toBe(
      `https://docs.google.com/spreadsheets/d/${GID}/edit`,
    );
    expect(url('application/vnd.google-apps.presentation')).toBe(
      `https://docs.google.com/presentation/d/${GID}/edit`,
    );
    expect(url('application/vnd.google-apps.drawing')).toBe(
      `https://docs.google.com/drawings/d/${GID}/edit`,
    );
    expect(url('application/vnd.google-apps.folder')).toBe(
      `https://drive.google.com/drive/folders/${GID}`,
    );
    // Anything else Drive holds is a file, and an unnamed type is one too.
    expect(url('application/pdf')).toBe(`https://drive.google.com/file/d/${GID}/view`);
    expect(sourceUrl({ source: 'gdocs', id: GID })).toBe(
      `https://drive.google.com/file/d/${GID}/view`,
    );
  });

  it('a Google Doc tab, which opens on that tab (#37)', () => {
    expect(sourceUrl(gdocsTab, 'application/vnd.google-apps.document')).toBe(
      `https://docs.google.com/document/d/${GID}/edit?tab=${TAB}`,
    );
    // The mime type of a Doc is what Drive reports for the file; a tab ref
    // without one is still a Doc, since only a Doc has tabs.
    expect(sourceUrl(gdocsTab)).toBe(`https://docs.google.com/document/d/${GID}/edit?tab=${TAB}`);
    // And that URL names the whole Doc again, as every Docs URL does.
    expect(parseSourceRefOrUrl(sourceUrl(gdocsTab))).toEqual(gdocs);
  });

  it('a calendar event, as the `eid` the UI shows (#38)', () => {
    expect(sourceUrl(elsewhere)).toBe(`https://calendar.google.com/calendar/event?eid=${EID}`);
    // With no calendar in the ref the event is on the primary one, which is
    // what the token has to say, since Calendar reads the pair back out of it.
    expect(sourceUrl(event)).toBe(
      'https://calendar.google.com/calendar/event?eid=MGdjZTN2a3Z1dDZjajAyN2ZiODZxcnRjMmEgcHJpbWFyeQ',
    );
  });

  it('answers a URL that parses back to the ref it came from', () => {
    for (const [ref, mimeType] of [
      [{ source: 'notion', id: NID }, undefined],
      [{ source: 'gdocs', id: GID }, 'application/vnd.google-apps.document'],
      [{ source: 'gdocs', id: GID }, 'application/vnd.google-apps.spreadsheet'],
      [{ source: 'gdocs', id: GID }, 'application/vnd.google-apps.folder'],
      [{ source: 'gdocs', id: GID }, 'application/pdf'],
    ] as [SourceRef, string | undefined][]) {
      expect(parseSourceRefOrUrl(sourceUrl(ref, mimeType))).toEqual(ref);
    }
  });
});
