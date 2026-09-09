/**
 * The manual test for ticket 14, Notion half: a file docsync uploaded is a
 * file Notion hosts, and the next fetch reads it back byte for byte.
 *
 * It never touches the fixture pages. It makes **one** new page, "Docsync
 * assets test", as a child of `Docsync test`, pushes a body that links a PNG
 * this script generates, and then checks the four things the fake API cannot
 * prove:
 *
 * 1. the block Notion made is an `image` block Notion itself hosts,
 * 2. downloading it gives back exactly the bytes that went up,
 * 3. a second push that changes only the bytes patches the same block — same
 *    id, new file — rather than making a new one, and
 * 4. a link to a file that is not in the checkout is refused.
 *
 * It archives the page at the end and prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/notion-assets-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts notion`.
 */
import { deflateSync } from 'node:zlib';
import { createCredentialProvider } from '../dist/auth/index.js';
import { createNotionApi, createNotionClient } from '../dist/notion/api.js';
import { markdownToBlocks } from '../dist/notion/from-markdown.js';
import { pushRoot } from '../dist/notion/push.js';
import { createNotionWriter } from '../dist/notion/write.js';

/** The fixture tree, which this script reads and never writes. */
const PARENT_ID = '3cf715cbeb088035b511f0b4f06efbd5';

const TITLE = 'Docsync assets test';
/** A path with no spaces in it, so the links in this script read plainly. */
const PATH = 'notion/Assets.md';
const ASSET = 'notion/Assets.assets/dot.png';
const BODY = 'A page with one attachment.\n';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(10)} ${detail}`);
}

let ok = true;
function check(name: string, passed: boolean, detail = ''): void {
  if (!passed) ok = false;
  say(passed ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
}

/* ------------------------------------------------------------------ a PNG */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  const body = new Uint8Array(name.length + data.length);
  body.set(name, 0);
  body.set(data, name.length);
  const out = new Uint8Array(body.length + 8);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(body, 4);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(body));
  return out;
}

/** A 1×1 PNG of one colour, made here so nothing is downloaded to run this. */
function onePixelPng(red: number, green: number, blue: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const idat = deflateSync(Buffer.from([0, red, green, blue]));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/* ------------------------------------------------------------------- work */

const provider = createCredentialProvider();
const api = createNotionApi(createNotionClient(await provider.accessToken('notion')));
const writer = createNotionWriter(api);

const first = onePixelPng(220, 40, 40);
const second = onePixelPng(40, 80, 220);
say('png', `${first.length} bytes red, ${second.length} bytes blue`);

const root = { path: 'notion/', src: { source: 'notion', id: PARENT_ID }, ignore: [] };
const file = (body: string): string => `---\nid: notion:{id}\ntitle: ${TITLE}\n---\n\n${body}`;

let pageId: string;
try {
  pageId = await writer.createPage(PARENT_ID, TITLE, markdownToBlocks(BODY));
} catch (error) {
  console.error(
    `Could not create a page under "Docsync test": ${
      error instanceof Error ? error.message : String(error)
    }\nThe integration needs insert access on that page. Stopping; nothing was changed.`,
  );
  process.exit(1);
}
say('create', `${pageId}`);

const index = new Map([
  [
    PATH,
    { path: PATH, src: { source: 'notion', id: pageId }, type: 'notion-page', lastEditedTime: '' },
  ],
]);
const withBody = (body: string): string => file(body).replace('{id}', pageId);

try {
  // 1. One push that adds the link and uploads the file behind it.
  const linked = `${BODY}\n![A red dot](Assets.assets/dot.png)\n`;
  const report = await pushRoot(
    root,
    [
      {
        kind: 'modified',
        path: PATH,
        text: withBody(linked),
        previousText: withBody(BODY),
        assets: new Map([[ASSET, first]]),
      },
    ],
    provider,
    index,
    { api },
  );
  say('push', `uploaded ${report[0]?.uploaded ?? 0} file(s)`);

  const blocks = await api.blockTree(pageId);
  const image = blocks.find((block) => block.type === 'image');
  const body = (image?.image ?? {}) as { type?: string; file?: { url?: string } };
  check('the block is an image Notion hosts itself', body.type === 'file', `type=${body.type}`);

  const downloaded = await api.download(body.file?.url ?? '');
  check(
    'the bytes come back exactly as they went up',
    Buffer.from(downloaded).equals(Buffer.from(first)),
    `${downloaded.length} bytes`,
  );

  // 2. A second push that changes only the bytes: the same block, patched.
  const assetIndex = new Map([
    ...index,
    [
      ASSET,
      {
        path: ASSET,
        // Undashed, which is how a fetch records every Notion id.
        src: { source: 'notion', id: (image?.id ?? '').replaceAll('-', '') },
        type: 'asset',
        lastEditedTime: String(image?.last_edited_time ?? ''),
        document: PATH,
        checksum: 'old',
      },
    ],
  ]);
  await pushRoot(root, [{ kind: 'modified', path: ASSET, bytes: second }], provider, assetIndex, {
    api,
  });

  const after = await api.blockTree(pageId);
  const patched = after.find((block) => block.type === 'image');
  check('the same block was patched, not replaced', patched?.id === image?.id, `${patched?.id}`);
  const again = await api.download(
    ((patched?.image ?? {}) as { file?: { url?: string } }).file?.url ?? '',
  );
  check(
    'and it now serves the new bytes',
    Buffer.from(again).equals(Buffer.from(second)),
    `${again.length} bytes`,
  );

  // 3. A link with no file behind it is refused, before anything is written.
  let refused = '';
  try {
    await pushRoot(
      root,
      [
        {
          kind: 'modified',
          path: PATH,
          text: withBody(`${linked}\n![Missing](Assets.assets/gone.png)\n`),
          previousText: withBody(linked),
          assets: new Map([[ASSET, second]]),
        },
      ],
      provider,
      assetIndex,
      { api },
    );
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check('a link to a file that is not there is refused', refused.includes('gone.png'), refused);
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.archivePage(pageId);
  say('archive', `${pageId} archived`);
}

console.log(
  `\n${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the archived page "${TITLE}" (${pageId}), recoverable from the Notion trash, and the file uploads inside it. The fixture pages were not touched.`,
);
process.exit(ok ? 0 : 1);
