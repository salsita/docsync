import { describe, expect, it } from 'vitest';
import { CALENDAR_ENDPOINT, createCalendarApi, SCOPE_REFUSED } from './api.js';

/** One canned response, in the order the fake hands them out. */
interface Canned {
  status?: number;
  body?: unknown;
}

function apiWith(responses: Canned[]) {
  const calls: string[] = [];
  const queue = [...responses];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = queue.shift();
    if (next === undefined) throw new Error(`no canned response for ${input}`);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  const api = createCalendarApi('token-123', {
    fetch: impl,
    sleep: async () => {},
  });
  return { api, calls };
}

describe('getEvent', () => {
  it('reads one event off the calendar named', async () => {
    const { api, calls } = apiWith([{ body: { id: 'ev1', summary: 'Contracts review' } }]);

    expect(await api.getEvent('jirist@salsitasoft.com', 'ev1')).toMatchObject({
      summary: 'Contracts review',
    });
    // The calendar id is an address, so it goes through the path encoder.
    expect(calls[0]).toBe(
      `${CALENDAR_ENDPOINT}/calendars/jirist%40salsitasoft.com/events/ev1?maxAttendees=1`,
    );
  });

  it('sends the bearer token', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const api = createCalendarApi('token-123', {
      fetch: (async (_input: string, init?: RequestInit) => {
        seen.push(init);
        return new Response('{}');
      }) as unknown as typeof fetch,
    });

    await api.getEvent('primary', 'ev1');

    expect((seen[0]?.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer token-123',
    );
  });
});

describe('instances', () => {
  it('pages through the instances up to timeMax, 250 at a time', async () => {
    const { api, calls } = apiWith([
      { body: { items: [{ id: 'ev1_1' }], nextPageToken: 'p2' } },
      { body: { items: [{ id: 'ev1_2' }] } },
    ]);

    const instances = await api.instances('primary', 'ev1', { timeMax: '2026-09-15T00:00:00Z' });

    expect(instances.map((one) => one.id)).toEqual(['ev1_1', 'ev1_2']);
    const first = new URL(calls[0] ?? '');
    expect(first.pathname).toBe('/calendar/v3/calendars/primary/events/ev1/instances');
    expect(first.searchParams.get('timeMax')).toBe('2026-09-15T00:00:00Z');
    expect(first.searchParams.get('maxResults')).toBe('250');
    expect(first.searchParams.get('showDeleted')).toBe('false');
    expect(first.searchParams.has('pageToken')).toBe(false);
    expect(calls[1]).toContain('pageToken=p2');
  });

  it('answers an empty list when the reply has no items', async () => {
    const { api } = apiWith([{ body: {} }]);
    expect(await api.instances('primary', 'ev1', {})).toEqual([]);
  });
});

describe('a token that predates calendar support', () => {
  it('says which command to run (#38)', async () => {
    const { api } = apiWith([
      {
        status: 403,
        body: { error: { message: 'Request had insufficient authentication scopes.' } },
      },
    ]);

    await expect(api.getEvent('primary', 'ev1')).rejects.toThrow(SCOPE_REFUSED);
  });

  it("leaves every other refusal in Google's own words", async () => {
    const { api } = apiWith([
      { status: 404, body: { error: { message: 'Not Found' } } },
      { status: 403, body: { error: { message: 'You need to have reader access.' } } },
    ]);

    await expect(api.getEvent('primary', 'gone')).rejects.toThrow(/Google API 404 .*Not Found/);
    await expect(api.getEvent('other@example.test', 'ev1')).rejects.toThrow(
      /Google API 403 .*reader access/,
    );
  });
});
