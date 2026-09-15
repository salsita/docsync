import { describe, expect, it } from 'vitest';
import * as calendar from './calendar/index.js';
import * as gdrive from './gdrive/index.js';
import * as notion from './notion/index.js';
import { sourceNames, sources } from './source.js';

describe('sources', () => {
  it('holds one entry per source name', () => {
    expect(Object.keys(sources).sort()).toEqual(['calendar', 'gdocs', 'notion']);
    expect(sourceNames).toEqual(['calendar', 'gdocs', 'notion']);
  });

  it('routes each name at that adapter', () => {
    expect(sources.notion.fetchRoot).toBe(notion.fetchRoot);
    expect(sources.notion.pushRoot).toBe(notion.pushRoot);
    expect(sources.gdocs.fetchRoot).toBe(gdrive.fetchRoot);
    expect(sources.gdocs.pushRoot).toBe(gdrive.pushRoot);
    expect(sources.calendar.fetchRoot).toBe(calendar.fetchRoot);
    expect(sources.calendar.pushRoot).toBe(calendar.pushRoot);
  });

  it('routes the two calls the CLI makes without a fetch', () => {
    expect(sources.notion.describe).toBe(notion.describe);
    expect(sources.notion.changedSince).toBe(notion.changedSince);
    expect(sources.gdocs.describe).toBe(gdrive.describe);
    expect(sources.gdocs.changedSince).toBe(gdrive.changedSince);
    expect(sources.calendar.describe).toBe(calendar.describe);
    expect(sources.calendar.changedSince).toBe(calendar.changedSince);
  });
});
