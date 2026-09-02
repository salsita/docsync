/**
 * Create the Google Drive fixture tree for ticket 07, once, with the owner's
 * own token. Refuses to run when a "Docsync test" folder already exists in the
 * Drive root, so it cannot duplicate the tree.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/create-gdrive-fixtures.ts
 */
import { createCredentialProvider } from '../dist/auth/index.js';

const token = await createCredentialProvider().accessToken('gdocs');
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

async function drive(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${body.error?.message}`);
  return body;
}

async function createMeta(meta: Record<string, unknown>) {
  return drive(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(meta),
  });
}

async function upload(meta: Record<string, unknown>, mime: string, content: string | Uint8Array) {
  const boundary = 'docsync-fixture-boundary';
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`,
  );
  const media = typeof content === 'string' ? encoder.encode(content) : content;
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + media.length + tail.length);
  body.set(head, 0);
  body.set(media, head.length);
  body.set(tail, head.length + media.length);
  return drive(UPLOAD, {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

const existing = await drive(
  `${API}?q=${encodeURIComponent("name='Docsync test' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false")}`,
  { method: 'GET' },
);
if (existing.files.length > 0) {
  console.error(`A "Docsync test" folder already exists: ${existing.files[0].id}. Nothing done.`);
  process.exit(1);
}

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';

const root = await createMeta({ name: 'Docsync test', mimeType: FOLDER });
console.log(`folder  Docsync test  ${root.id}`);
const sub = await createMeta({ name: 'Sub', mimeType: FOLDER, parents: [root.id] });
console.log(`folder  Sub           ${sub.id}`);

const elements = `<html><body>
<p class="title">Elements</p>
<p class="subtitle">Every element the dialect handles, and a few it does not</p>
<h1>Heading one</h1>
<p>A plain paragraph with <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, <span style="font-family:'Courier New'">code font</span>, a <a href="https://example.com/">link</a>, <span style="color:#ff0000">red text</span> and <span style="background-color:#ffff00">highlighted text</span>.</p>
<h2>Heading two</h2>
<p style="text-align:center">A centred paragraph.</p>
<p style="font-family:Georgia;font-size:14pt">A paragraph in Georgia at 14 points.</p>
<h3>Heading three</h3>
<h4>Heading four</h4>
<h5>Heading five</h5>
<h6>Heading six</h6>
<ul><li>Bullet one</li><li>Bullet two<ul><li>Nested bullet<ul><li>Deeper bullet</li></ul></li></ul></li><li>Bullet three with <b>bold</b></li></ul>
<ol><li>Numbered one</li><li>Numbered two<ol><li>Nested numbered</li></ol></li><li>Numbered three</li></ol>
<p>Two lines in one paragraph,<br>separated by a soft line break.</p>
<table border="1"><tr><td><b>Name</b></td><td><b>Value</b></td></tr><tr><td>bold cell</td><td>plain cell</td></tr><tr><td>a | pipe</td><td><span style="color:#0000ff">blue</span></td></tr></table>
<hr>
<p>Paragraph before a page break.</p>
<p style="page-break-before:always">Paragraph after a page break.</p>
<p>Characters that need escaping in Markdown: * _ \` # [brackets] &lt;angle&gt; {braces} | ^ ~ \\ and a trailing backslash \\</p>
<p>Final paragraph.</p>
</body></html>`;

const made = [
  await upload({ name: 'Elements', mimeType: DOC, parents: [root.id] }, 'text/html', elements),
  await upload({ name: 'Leaf', mimeType: DOC, parents: [root.id] }, 'text/html', '<p>A document with one paragraph, nothing else.</p>'),
  await upload({ name: 'Nested', mimeType: DOC, parents: [sub.id] }, 'text/html', '<p>A document inside the Sub folder.</p>'),
  await upload({ name: 'Title/With: Illegal*Chars? "Quoted" <Tag> |Pipe|', mimeType: DOC, parents: [root.id] }, 'text/html', '<p>Tests filename derivation from a hostile title.</p>'),
  await upload({ name: '.Hidden leading dot...', mimeType: DOC, parents: [root.id] }, 'text/html', '<p>Tests leading-dot removal.</p>'),
  await upload({ name: 'Notes', mimeType: DOC, parents: [root.id] }, 'text/html', '<p>First of two documents titled Notes.</p>'),
  await upload({ name: 'Notes', mimeType: DOC, parents: [root.id] }, 'text/html', '<p>Second of two documents titled Notes.</p>'),
  await upload({ name: 'Numbers', mimeType: SHEET, parents: [root.id] }, 'text/csv', 'name,value\na,1\nb,2\n'),
  await upload({ name: 'plain.txt', parents: [root.id] }, 'text/plain', 'A plain text file, kept as bytes.\n'),
];
const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 40 Td (docsync fixture) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`;
made.push(await upload({ name: 'dummy.pdf', parents: [root.id] }, 'application/pdf', pdf));
for (const f of made) console.log(`${f.mimeType.padEnd(45)} ${f.name.padEnd(48)} ${f.id}`);
