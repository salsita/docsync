/**
 * The write operations against a mocked `fetch`, so that the URL, the method,
 * the headers and the body Google would receive are all pinned — `api.ts` and
 * `write.ts` are tested as the one thing they are on the wire.
 */
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../markdown.js';
import {
  createGDriveApi,
  DOCS_ENDPOINT,
  DRIVE_ENDPOINT,
  UPLOAD_BOUNDARY,
  UPLOAD_ENDPOINT,
} from './api.js';
import { createGDriveWriter } from './write.js';

/** The run styling every plain run carries, and the mask it always sets. */
const PLAIN = { bold: false, italic: false, underline: false, strikethrough: false };
const FIELDS = 'bold,italic,underline,strikethrough,weightedFontFamily,link';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A `fetch` that answers each call from `answers` and records what it got. */
function mockFetch(answers: unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let at = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    const body = init.body;
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof body === 'string' ? JSON.parse(body) : body,
    });
    const answer = answers[at] ?? {};
    at += 1;
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function writer(answers: unknown[]) {
  const { fetch, calls } = mockFetch(answers);
  return { writer: createGDriveWriter(createGDriveApi('token', { fetch })), calls };
}

/** The `requests` array of the batch one recorded call carried. */
function batch(call: Call | undefined): unknown[] {
  return (call?.body as { requests?: unknown[] } | undefined)?.requests ?? [];
}

/** A document with a body that ends where `end` says, as `documents.get` answers. */
function existing(end: number) {
  return { documentId: 'doc1', body: { content: [{ endIndex: end }] } };
}

describe('patchBody', () => {
  it('sends the plan as one batch and answers what it dropped', async () => {
    const { writer: write, calls } = writer([{ replies: [] }]);

    const result = await write.patchBody('doc1', {
      requests: [{ deleteContentRange: { range: { startIndex: 3, endIndex: 5 } } }],
      footnotes: [],
      counts: { kept: 1, updated: 1, inserted: 0, deleted: 0 },
      dropped: ['horizontal rule'],
      suggestions: [],
      rewritten: [],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DOCS_ENDPOINT}/documents/doc1:batchUpdate`);
    expect(batch(calls[0])).toEqual([
      { deleteContentRange: { range: { startIndex: 3, endIndex: 5 } } },
    ]);
    expect(result).toEqual({ dropped: ['horizontal rule'], batches: 1 });
  });

  it('writes nothing at all when the diff says nothing changed', async () => {
    const { writer: write, calls } = writer([]);

    const result = await write.patchBody('doc1', {
      requests: [],
      footnotes: [],
      counts: { kept: 4, updated: 0, inserted: 0, deleted: 0 },
      dropped: [],
      suggestions: [],
      rewritten: [],
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({ dropped: [], batches: 0 });
  });

  it('fills a footnote an inserted block made, in a second batch', async () => {
    const { writer: write, calls } = writer([
      { replies: [{ createFootnote: { footnoteId: 'kix.fn1' } }] },
      existing(2),
      { replies: [] },
    ]);

    const result = await write.patchBody('doc1', {
      requests: [{ createFootnote: { location: { index: 7 } } }],
      footnotes: [
        {
          requestIndex: 0,
          requests: (segmentId) => [
            { insertText: { location: { index: 0, segmentId }, text: 'The note.' } },
          ],
        },
      ],
      counts: { kept: 0, updated: 1, inserted: 0, deleted: 0 },
      dropped: [],
      suggestions: [],
      rewritten: [],
    });

    expect(batch(calls[2])).toEqual([
      { insertText: { location: { index: 0, segmentId: 'kix.fn1' }, text: 'The note.' } },
    ]);
    expect(result.batches).toBe(2);
  });
});

describe('replaceBody', () => {
  it('deletes the whole body first, in the same batch', async () => {
    const { writer: write, calls } = writer([existing(42), { replies: [] }]);

    const result = await write.replaceBody('doc1', parseMarkdown('Hello.\n'));

    expect(calls[0]?.url).toBe(
      `${DOCS_ENDPOINT}/documents/doc1?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`,
    );
    expect(calls[1]?.url).toBe(`${DOCS_ENDPOINT}/documents/doc1:batchUpdate`);
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.headers.authorization).toBe('Bearer token');
    const requests = batch(calls[1]);
    expect(requests[0]).toEqual({
      deleteContentRange: { range: { startIndex: 1, endIndex: 41 } },
    });
    expect(requests[1]).toEqual({
      insertText: { location: { index: 1 }, text: 'Hello.\n' },
    });
    expect(result).toEqual({ dropped: [], batches: 1 });
  });

  it('deletes nothing when the body is already one empty paragraph', async () => {
    const { writer: write, calls } = writer([existing(2), { replies: [] }]);

    await write.replaceBody('doc1', parseMarkdown('Hello.\n'));

    const requests = batch(calls[1]);
    expect(requests[0]).toEqual({ insertText: { location: { index: 1 }, text: 'Hello.\n' } });
  });

  it('sends nothing at all for an empty document', async () => {
    const { writer: write, calls } = writer([existing(2)]);

    expect(await write.replaceBody('doc1', parseMarkdown(''))).toEqual({
      dropped: [],
      batches: 0,
    });
    expect(calls).toHaveLength(1);
  });

  it('fills the footnotes in a second batch, by the id the first one answered', async () => {
    const { writer: write, calls } = writer([
      existing(2),
      // One reply per request; the last one is the `createFootnote`.
      { replies: [{}, {}, {}, {}, { createFootnote: { footnoteId: 'kix.fn7' } }] },
      // The document as it stands between the batches: the new footnote holds
      // the space Docs seeds it with.
      { footnotes: { 'kix.fn7': { content: [{ endIndex: 2 }] } } },
      { replies: [] },
    ]);

    const result = await write.replaceBody('doc1', parseMarkdown('A[^1]\n\n[^1]: Note\n'));

    expect(result.batches).toBe(2);
    expect(batch(calls[3])).toEqual([
      { deleteContentRange: { range: { segmentId: 'kix.fn7', startIndex: 0, endIndex: 1 } } },
      { insertText: { location: { index: 0, segmentId: 'kix.fn7' }, text: 'Note\n' } },
      {
        updateParagraphStyle: {
          range: { startIndex: 0, endIndex: 5, segmentId: 'kix.fn7' },
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
          fields: 'namedStyleType',
        },
      },
      {
        deleteParagraphBullets: { range: { startIndex: 0, endIndex: 5, segmentId: 'kix.fn7' } },
      },
      {
        updateTextStyle: {
          range: { startIndex: 0, endIndex: 4, segmentId: 'kix.fn7' },
          textStyle: PLAIN,
          fields: FIELDS,
        },
      },
    ]);
  });

  it('says what it could not write back', async () => {
    const { writer: write } = writer([existing(2), { replies: [] }]);

    expect((await write.replaceBody('doc1', parseMarkdown('a\n\n---\n'))).dropped).toEqual([
      'horizontal rule',
    ]);
  });
});

describe('createDoc', () => {
  it('creates the file under its parent, then styles what it inserted', async () => {
    const { writer: write, calls } = writer([{ id: 'new1' }, { replies: [] }]);

    const created = await write.createDoc('folder1', 'Notes', parseMarkdown('# Title\n'));

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.startsWith(`${DRIVE_ENDPOINT}/files?`)).toBe(true);
    expect(calls[0]?.body).toEqual({
      name: 'Notes',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder1'],
    });
    // A new document is empty, so the batch starts with the insertion.
    const requests = batch(calls[1]);
    expect(requests[0]).toEqual({ insertText: { location: { index: 1 }, text: 'Title\n' } });
    expect(requests[1]).toMatchObject({
      updateParagraphStyle: { paragraphStyle: { namedStyleType: 'HEADING_1' } },
    });
    expect(created.id).toBe('new1');
  });
});

describe('createFolder', () => {
  it('makes a folder under its parent', async () => {
    const { writer: write, calls } = writer([{ id: 'sub1' }]);

    expect(await write.createFolder('root1', 'Sub')).toBe('sub1');
    expect(calls[0]?.body).toEqual({
      name: 'Sub',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root1'],
    });
  });
});

describe('a binary', () => {
  it('uploads a new revision of the same file, with its content type', async () => {
    const { writer: write, calls } = writer([{ id: 'bin1' }]);
    const bytes = new TextEncoder().encode('hello');

    await write.uploadRevision('bin1', bytes, 'text/plain');

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain(`${UPLOAD_ENDPOINT}/files/bin1?`);
    expect(calls[0]?.url).toContain('uploadType=media');
    expect(calls[0]?.headers['content-type']).toBe('text/plain');
    expect(calls[0]?.body).toEqual(bytes);
  });

  it('creates a new file as one multipart request, metadata then bytes', async () => {
    const { writer: write, calls } = writer([{ id: 'bin2' }]);

    expect(await write.createFile('folder1', 'plain.txt', new TextEncoder().encode('hi'))).toBe(
      'bin2',
    );
    expect(calls[0]?.url).toContain('uploadType=multipart');
    expect(calls[0]?.headers['content-type']).toBe(
      `multipart/related; boundary=${UPLOAD_BOUNDARY}`,
    );
    const sent = new TextDecoder().decode(calls[0]?.body as Uint8Array);
    expect(sent).toContain('{"name":"plain.txt","parents":["folder1"]}');
    expect(sent).toContain('content-type: application/octet-stream');
    expect(sent.endsWith(`hi\r\n--${UPLOAD_BOUNDARY}--\r\n`)).toBe(true);
  });
});

describe('rename, move and trash', () => {
  it('renames by the file name, which is the title', async () => {
    const { writer: write, calls } = writer([{ id: 'doc1', name: 'New' }]);

    await write.rename('doc1', 'New');

    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.body).toEqual({ name: 'New' });
  });

  it('moves with addParents and removeParents and no metadata', async () => {
    const { writer: write, calls } = writer([{ id: 'doc1' }]);

    await write.move('doc1', 'to1', 'from1');

    expect(calls[0]?.url).toContain('addParents=to1');
    expect(calls[0]?.url).toContain('removeParents=from1');
    expect(calls[0]?.body).toEqual({});
  });

  it('trashes by setting the flag, which is reversible', async () => {
    const { writer: write, calls } = writer([{ id: 'doc1' }]);

    await write.trash('doc1');

    expect(calls[0]?.body).toEqual({ trashed: true });
  });
});

describe('a failed write', () => {
  it("carries Google's message, and is not retried when it is a 400", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'Invalid requests[0]' } }), {
        status: 400,
      });
    }) as unknown as typeof fetch;
    const write = createGDriveWriter(createGDriveApi('token', { fetch: impl }));

    await expect(write.trash('doc1')).rejects.toThrow('Invalid requests[0]');
    expect(calls).toBe(1);
  });
});
