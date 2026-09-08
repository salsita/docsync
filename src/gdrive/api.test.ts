import { describe, expect, it } from 'vitest';
import { createGDriveApi, DOCS_ENDPOINT, DRIVE_ENDPOINT } from './api.js';

/** One canned response, in the order the fake hands them out. */
interface Canned {
  status?: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

function fakeFetch(responses: Canned[]) {
  const calls: string[] = [];
  const queue = [...responses];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = queue.shift();
    if (next === undefined) throw new Error(`no canned response for ${input}`);
    const body = next.bytes ?? JSON.stringify(next.body ?? {});
    return new Response(body, { status: next.status ?? 200, headers: next.headers ?? {} });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** An API whose retries do not wait, with the sleeps it performed recorded. */
function apiWith(responses: Canned[]) {
  const { impl, calls } = fakeFetch(responses);
  const sleeps: number[] = [];
  const api = createGDriveApi('token-123', {
    fetch: impl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { api, calls, sleeps };
}

describe('listFolder', () => {
  it('pages through two pages of results', async () => {
    const { api, calls } = apiWith([
      { body: { files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }], nextPageToken: 'p2' } },
      { body: { files: [{ id: 'b', name: 'B', mimeType: 'text/plain' }] } },
    ]);

    const files = await api.listFolder('folder');

    expect(files.map((file) => file.id)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`${DRIVE_ENDPOINT}/files?`);
    expect(new URL(calls[0] ?? '').searchParams.get('q')).toBe(
      "'folder' in parents and trashed=false",
    );
    expect(calls[0]).toContain('supportsAllDrives=true');
    expect(calls[0]).toContain('includeItemsFromAllDrives=true');
    expect(calls[0]).not.toContain('pageToken');
    expect(calls[1]).toContain('pageToken=p2');
  });

  it('answers an empty list when the folder has no files field', async () => {
    const { api } = apiWith([{ body: {} }]);
    expect(await api.listFolder('folder')).toEqual([]);
  });

  it('sends the bearer token', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const api = createGDriveApi('token-123', {
      fetch: (async (_input: string, init?: RequestInit) => {
        seen.push(init);
        return new Response('{}');
      }) as unknown as typeof fetch,
    });

    await api.listFolder('folder');

    expect((seen[0]?.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer token-123',
    );
  });
});

describe('getFile', () => {
  it('asks for the fields the walk needs', async () => {
    const { api, calls } = apiWith([{ body: { id: 'a', name: 'A', mimeType: 'text/plain' } }]);

    expect(await api.getFile('a')).toEqual({ id: 'a', name: 'A', mimeType: 'text/plain' });
    expect(calls[0]).toContain(`${DRIVE_ENDPOINT}/files/a?`);
    expect(calls[0]).toContain('modifiedTime');
    expect(calls[0]).toContain('md5Checksum');
  });
});

describe('getDocument', () => {
  it('reads the document without suggestions', async () => {
    const { api, calls } = apiWith([{ body: { documentId: 'd', title: 'Doc' } }]);

    expect(await api.getDocument('d')).toEqual({ documentId: 'd', title: 'Doc' });
    expect(calls[0]).toBe(
      `${DOCS_ENDPOINT}/documents/d?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`,
    );
  });

  it('reads it with the suggestions inline when a push asks', async () => {
    const { api, calls } = apiWith([{ body: { documentId: 'd' } }]);

    await api.getDocument('d', 'inline');
    expect(calls[0]).toBe(`${DOCS_ENDPOINT}/documents/d?suggestionsViewMode=SUGGESTIONS_INLINE`);
  });
});

describe('batchUpdate', () => {
  /** The API, with the request bodies it was given, parsed (MANUAL §7). */
  function sending(responses: Canned[]) {
    const sent: Record<string, unknown>[] = [];
    const { impl, calls } = fakeFetch(responses);
    const api = createGDriveApi('token-123', {
      fetch: (async (input: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return (impl as (i: string, n?: RequestInit) => Promise<Response>)(input, init);
      }) as unknown as typeof fetch,
    });
    return { api, calls, sent };
  }

  const requests = [{ insertText: { location: { index: 1 }, text: 'Hi' } }];

  it('writes over the body when nothing asks for suggestions', async () => {
    const { api, calls, sent } = sending([{ body: { replies: [{}] } }]);

    const result = await api.batchUpdate('d', requests);

    expect(calls[0]).toBe(`${DOCS_ENDPOINT}/documents/d:batchUpdate`);
    expect(sent[0]).toEqual({ requests });
    expect(sent[0]?.writeControl).toBeUndefined();
    expect(result.suggestionIds).toEqual([]);
  });

  it('carries `writeControl.writeMode: SUGGEST` for a suggest root (MANUAL §7)', async () => {
    const { api, sent } = sending([
      {
        body: {
          replies: [{ suggestionId: 'suggest.a' }, { suggestionId: 'suggest.a' }],
          commentUpdateState: { state: 'SUCCESS' },
        },
      },
    ]);

    const result = await api.batchUpdate('d', requests, { suggest: true });

    expect(sent[0]).toEqual({ requests, writeControl: { writeMode: 'SUGGEST' } });
    // One id per suggestion, however many replies name it.
    expect(result.suggestionIds).toEqual(['suggest.a']);
    expect(result.commentUpdateState).toEqual({ state: 'SUCCESS' });
  });

  it('leaves `writeControl` off again when the option is false', async () => {
    const { api, sent } = sending([{ body: {} }]);

    const result = await api.batchUpdate('d', requests, { suggest: false });

    expect(sent[0]?.writeControl).toBeUndefined();
    expect(result.replies).toEqual([]);
    expect(result.commentUpdateState).toBeUndefined();
  });
});

describe('comments', () => {
  it('asks for every field, leaves the deleted out, and pages', async () => {
    const { api, calls } = apiWith([
      { body: { comments: [{ id: 'c1' }], nextPageToken: 'p2' } },
      { body: { comments: [{ id: 'c2' }] } },
    ]);

    expect((await api.comments('d')).map((comment) => comment.id)).toEqual(['c1', 'c2']);
    expect(calls[0]).toContain(`${DRIVE_ENDPOINT}/files/d/comments?`);
    const query = new URL(calls[0] ?? '').searchParams;
    expect(query.get('fields')).toBe('*');
    expect(query.get('includeDeleted')).toBe('false');
    expect(calls[1]).toContain('pageToken=p2');
  });

  it('answers an empty list for a file with no comments', async () => {
    const { api } = apiWith([{ body: {} }]);
    expect(await api.comments('d')).toEqual([]);
  });
});

describe('download and export', () => {
  it('downloads bytes as they are', async () => {
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const { api, calls } = apiWith([{ bytes }]);

    expect(await api.download('f')).toEqual(bytes);
    expect(calls[0]).toContain('alt=media');
  });

  it('exports with the mime type asked for', async () => {
    const { api, calls } = apiWith([{ bytes: new Uint8Array([80, 75]) }]);

    expect(await api.export('s', 'text/csv')).toEqual(new Uint8Array([80, 75]));
    expect(calls[0]).toBe(`${DRIVE_ENDPOINT}/files/s/export?mimeType=text%2Fcsv`);
  });
});

describe('retry', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const { api, sleeps } = apiWith([
      { status: 429, headers: { 'retry-after': '2' } },
      { body: { files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }] } },
    ]);

    expect(await api.listFolder('folder')).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
  });

  it('retries a 5xx with backoff and then succeeds', async () => {
    const { api, sleeps } = apiWith([
      { status: 500 },
      { status: 503 },
      { body: { documentId: 'd' } },
    ]);

    expect(await api.getDocument('d')).toEqual({ documentId: 'd' });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('ignores an unreadable Retry-After', async () => {
    const { api, sleeps } = apiWith([
      { status: 429, headers: { 'retry-after': 'soon' } },
      { body: {} },
    ]);

    await api.listFolder('folder');
    expect(sleeps).toEqual([1000]);
  });

  it('gives up after three retries', async () => {
    const { api, sleeps } = apiWith([
      { status: 503, body: { error: { message: 'backend error' } } },
      { status: 503, body: { error: { message: 'backend error' } } },
      { status: 503, body: { error: { message: 'backend error' } } },
      { status: 503, body: { error: { message: 'backend error' } } },
    ]);

    await expect(api.download('f')).rejects.toThrow(/503/);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it('does not retry a 404', async () => {
    const { api, sleeps } = apiWith([{ status: 404, body: { error: { message: 'not found' } } }]);

    await expect(api.getFile('gone')).rejects.toThrow(/not found/);
    expect(sleeps).toEqual([]);
  });

  it('reports a status even when the body is not JSON', async () => {
    const { api } = apiWith([{ status: 403, bytes: new Uint8Array([60, 33]) }]);

    await expect(api.getFile('secret')).rejects.toThrow(/403/);
  });

  it('waits for real when no sleep is injected', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { body: { files: [] } },
    ]);

    await createGDriveApi('token', { fetch: impl }).listFolder('folder');

    expect(calls).toHaveLength(2);
  });
});

describe('copyFile', () => {
  it('copies a file with the metadata the copy is to have', async () => {
    const { api, calls } = apiWith([{ body: { id: 'copy1', name: 'Elements copy' } }]);

    const copy = await api.copyFile('doc1', { name: 'Elements copy', parents: ['folder1'] });

    expect(copy.id).toBe('copy1');
    expect(calls[0]?.startsWith(`${DRIVE_ENDPOINT}/files/doc1/copy?`)).toBe(true);
  });
});
