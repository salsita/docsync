import { describe, expect, it } from 'vitest';
import * as gdrive from './gdrive/index.js';
import * as notion from './notion/index.js';
import { sourceNames, sources } from './source.js';

describe('sources', () => {
  it('holds one entry per source name', () => {
    expect(Object.keys(sources).sort()).toEqual(['gdocs', 'notion']);
    expect(sourceNames).toEqual(['gdocs', 'notion']);
  });

  it('routes each name at that adapter', () => {
    expect(sources.notion.fetchRoot).toBe(notion.fetchRoot);
    expect(sources.notion.pushRoot).toBe(notion.pushRoot);
    expect(sources.gdocs.fetchRoot).toBe(gdrive.fetchRoot);
    expect(sources.gdocs.pushRoot).toBe(gdrive.pushRoot);
  });

  it('routes the two calls the CLI makes without a fetch', () => {
    expect(sources.notion.describe).toBe(notion.describe);
    expect(sources.notion.changedSince).toBe(notion.changedSince);
    expect(sources.gdocs.describe).toBe(gdrive.describe);
    expect(sources.gdocs.changedSince).toBe(gdrive.changedSince);
  });
});
