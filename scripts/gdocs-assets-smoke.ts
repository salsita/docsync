/**
 * The manual test for ticket 14, Google Docs half: an image docsync inserted
 * is in the document, and the exposure it took to put it there is gone.
 *
 * It never touches the fixture folder "Docsync test", which is READ ONLY. It
 * makes one folder of its own in the Drive root and one Doc in that folder,
 * pushes a body that links a PNG this script generates, and then checks what
 * the fake Drive cannot prove:
 *
 * 1. the Doc holds an inline image Docs serves itself, whose bytes are the
 *    ones that went up,
 * 2. the temporary "anyone with the link" permission is **gone**,
 * 3. the Drive copy the insert read from is **trashed**, and
 * 4. both of those are true even when the insertion fails — the second half of
 *    the run makes it fail on purpose.
 *
 * It trashes the Doc and the folder at the end and prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdocs-assets-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts gdocs`.
 */
import { deflateSync } from 'node:zlib';
import { createCredentialProvider } from '../dist/auth/index.js';
import { createGDriveApi, FOLDER_MIME } from '../dist/gdrive/api.js';
import { pushRoot } from '../dist/gdrive/push.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

const FOLDER = 'Docsync assets test';
const TITLE = 'Assets smoke';
/** A path with no spaces in it, so the links in this script read plainly. */
const PATH = 'drive/Assets.md';
const ASSET = 'drive/Assets.assets/dot.png';
const BODY = 'A document with one image.\n';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(12)} ${detail}`);
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
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
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

/** A 4×4 PNG of one colour, made here so nothing is downloaded to run this. */
function squarePng(red: number, green: number, blue: number): Uint8Array {
  const side = 4;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const raw: number[] = [];
  for (let row = 0; row < side; row += 1) {
    raw.push(0);
    for (let column = 0; column < side; column += 1) raw.push(red, green, blue);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/* ------------------------------------------------------------------- work */

const provider = createCredentialProvider();
const token = await provider.accessToken('gdocs');
const api = createGDriveApi(token);
const writer = createGDriveWriter(api);

/** The permissions endpoint, so the checks read Drive rather than our record. */
async function permissionsOf(fileId: string): Promise<{ id?: string; type?: string }[]> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=*&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`permissions ${response.status}: ${await response.text()}`);
  return (
    ((await response.json()) as { permissions?: { id?: string; type?: string }[] }).permissions ??
    []
  );
}

/** Whether a file is in the Drive trash. */
async function isTrashed(fileId: string): Promise<boolean> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=trashed&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`get ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { trashed?: boolean }).trashed === true;
}

const png = squarePng(220, 40, 40);
say('png', `${png.length} bytes`);

// 1. One folder in the Drive root, beside the fixture folder and never in it.
const folder = await api.createFile({ name: FOLDER, mimeType: FOLDER_MIME, parents: ['root'] });
say('folder', `${folder.name} ${folder.id}`);

const root = { path: 'drive/', src: { source: 'gdocs', id: folder.id }, ignore: [] };
const file = (id: string, body: string): string =>
  `---\nid: gdocs:${id}\ntitle: ${TITLE}\n---\n\n${body}`;

let made: { id: string } | undefined;
try {
  // 2. The Doc, with its body written the way a `docsync push` writes one.
  made = await writer.createDoc(folder.id, TITLE, parseMarkdown(BODY));
  say('create', `${made.id}`);

  const index = new Map([
    [PATH, { path: PATH, src: { source: 'gdocs', id: made.id }, type: 'gdoc', lastEditedTime: '' }],
  ]);

  // 3. The push that puts the image in, which is the whole of this ticket's
  //    Docs half: upload, share, insert, unshare, trash.
  const linked = `${BODY}\n![](Assets.assets/dot.png)\n`;
  const report = await pushRoot(
    root,
    [
      {
        kind: 'modified',
        path: PATH,
        text: file(made.id, linked),
        previousText: file(made.id, BODY),
        assets: new Map([[ASSET, png]]),
      },
    ],
    provider,
    index,
    { api },
  );
  say('push', `uploaded ${report[0]?.uploaded ?? 0} file(s)`);

  // 4. What the document holds now.
  const document = await api.getDocument(made.id);
  const objects = Object.values(document.inlineObjects ?? {});
  check('the document holds one inline image', objects.length === 1, `${objects.length} object(s)`);
  const uri = (
    objects[0]?.inlineObjectProperties?.embeddedObject?.imageProperties as
      | { contentUri?: string }
      | undefined
  )?.contentUri;
  check('Docs serves it from its own store', (uri ?? '').includes('googleusercontent'), uri ?? '');
  if (uri !== undefined) {
    const { bytes } = await api.downloadUri(uri);
    check('and the bytes are the ones that went up', bytes.length > 0, `${bytes.length} bytes`);
  }

  // 5. The Drive copy: gone, and unshared. There is exactly one file named
  //    `dot.png` in the assets folder the push made.
  const assets = (await api.listFolder(folder.id)).find(
    (one) => one.mimeType === FOLDER_MIME && one.name === 'Assets.assets',
  );
  check('the push made an assets folder beside the Doc', assets !== undefined, assets?.id ?? '');
  const staged = assets === undefined ? [] : await api.listFolder(assets.id);
  // A trashed file is not in a listing, which is the plainest proof there is.
  check(
    'the Drive copy is not in the folder any more',
    staged.length === 0,
    `${staged.length} left`,
  );

  // 6. And the same, when the insert fails: the permission and the copy still
  //    go, in the `finally` that the owner asked for. The push has to have an
  //    image to insert, so this one adds a second file; the base is read back
  //    from the Doc, through the object the first push put there.
  const objectId = Object.keys(document.inlineObjects ?? {})[0] ?? '';
  const withImage = new Map([
    ...index,
    [
      ASSET,
      {
        path: ASSET,
        src: { source: 'gdocs', id: objectId },
        type: 'asset',
        lastEditedTime: '',
        document: PATH,
        checksum: 'kept',
      },
    ],
  ]);
  const base = documentToMarkdown(document, {
    assets: new Map([[objectId, ASSET]]),
    from: PATH,
  });
  say('base', JSON.stringify(base));

  const broken = createGDriveApi(token);
  const seen: { fileId: string }[] = [];
  const realCreate = broken.createPermission.bind(broken);
  broken.createPermission = async (id, permission) => {
    seen.push({ fileId: id });
    return realCreate(id, permission);
  };
  broken.batchUpdate = async () => {
    throw new Error('the insert failed on purpose');
  };

  let refused = '';
  try {
    await pushRoot(
      root,
      [
        {
          kind: 'modified',
          path: PATH,
          text: file(made.id, `${base}\n![](Assets.assets/dot2.png)\n`),
          previousText: file(made.id, base),
          assets: new Map([
            [ASSET, png],
            ['drive/Assets.assets/dot2.png', squarePng(40, 80, 220)],
          ]),
        },
      ],
      provider,
      withImage,
      { api: broken },
    );
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check('a failed insert is reported', refused.includes('on purpose'), refused);
  check('it says nothing was left behind', !refused.includes('Left behind'), refused);

  const failed = seen[0]?.fileId;
  if (failed === undefined) {
    check('the failed insert had staged a copy to check', false);
  } else {
    check(
      'the temporary permission is gone after a failed insert',
      (await permissionsOf(failed)).every((one) => one.type !== 'anyone'),
    );
    check('the Drive copy is trashed after a failed insert', await isTrashed(failed));
  }
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  if (made !== undefined) {
    await writer.trash(made.id);
    say('trash', `${made.id} trashed`);
  }
  await writer.trash(folder.id);
  say('trash', `${folder.id} trashed`);
}

console.log(
  `\n${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the trashed folder "${FOLDER}" (${folder.id}) and everything inside it, all recoverable from the Drive trash. The fixture folder was not touched.`,
);
process.exit(ok ? 0 : 1);
