/**
 * The manual test for ticket 16: a diff-based push against the real Docs API.
 *
 * It never touches the fixture folder "Docsync test", which is READ ONLY. It
 * makes one folder of its own beside it, in the Drive root, and one Doc in
 * that folder, and then checks the four things the fake model cannot prove:
 *
 * 1. a text colour on a paragraph the push did not touch is still there,
 * 2. an inline image in a paragraph the push did not touch is still there,
 * 3. a comment on an untouched paragraph is still there, unresolved, still
 *    quoting the text it was made on, and
 * 4. the document says exactly what the pushed file says.
 *
 * It trashes the Doc and the folder at the end and prints what it left behind.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdocs-patch-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts gdocs`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';
import { createGDriveApi, FOLDER_MIME } from '../dist/gdrive/api.js';
import { pushRoot } from '../dist/gdrive/push.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown, stringifyMarkdown } from '../dist/markdown.js';

const FOLDER = 'Docsync patch test';
const TITLE = 'Patch smoke';
const PATH = 'drive/Patch smoke.md';
const COMMENT = 'docsync smoke: this comment must survive the push';

/** A public image Google itself serves, so that the insert has something to fetch. */
const IMAGE = 'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png';

/** The body the Doc is created with. Every line of it is load-bearing below. */
const BODY = `# Patch smoke

The first paragraph. It is coloured, it carries a comment, and the push must not touch it.

The second paragraph. The push edits one word of this one, and no other.

An image sits at the end of this line.

- a bullet that stays
- a bullet that goes
`;

/** The paragraph the comment and the colour go on. */
const COLOURED = 'The first paragraph.';
/** The paragraph the image goes in. */
const IMAGE_LINE = 'An image sits at the end of this line.';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(10)} ${detail}`);
}

function check(name: string, ok: boolean, detail = ''): boolean {
  say(ok ? 'ok' : 'FAILED', `${name}${detail === '' ? '' : ` — ${detail}`}`);
  return ok;
}

/** Both sides of a comparison through the one pipeline (MANUAL §6). */
function canonical(markdown: string): string {
  return stringifyMarkdown(parseMarkdown(markdown));
}

/** The paragraph whose text starts with `lead`, with the range it covers. */
function paragraphAt(doc, lead) {
  for (const element of doc.body?.content ?? []) {
    const text = (element.paragraph?.elements ?? [])
      .map((one) => one.textRun?.content ?? '')
      .join('');
    if (text.startsWith(lead))
      return { start: element.startIndex ?? 0, end: element.endIndex ?? 0 };
  }
  throw new Error(`no paragraph starting "${lead}"`);
}

/** Every text run of the body, with the style it carries. */
function runs(doc) {
  const out = [];
  for (const element of doc.body?.content ?? []) {
    for (const one of element.paragraph?.elements ?? []) {
      if (one.textRun !== undefined) out.push(one.textRun);
    }
  }
  return out;
}

/** Every inline object the body still points at. */
function objects(doc) {
  const out = [];
  for (const element of doc.body?.content ?? []) {
    for (const one of element.paragraph?.elements ?? []) {
      const id = one.inlineObjectElement?.inlineObjectId;
      if (id !== undefined) out.push(id);
    }
  }
  return out;
}

const provider = createCredentialProvider();
const token = await provider.accessToken('gdocs');
const api = createGDriveApi(token);
const writer = createGDriveWriter(api);

/** The comments endpoint, which the adapter does not wrap until ticket 17. */
async function comments(fileId: string, body?: unknown) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/comments?fields=*`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok) throw new Error(`comments ${response.status}: ${await response.text()}`);
  return response.json();
}

// 1. One folder in the Drive root, beside the fixture folder and never in it.
const folder = await api.createFile({ name: FOLDER, mimeType: FOLDER_MIME, parents: ['root'] });
say('folder', `${folder.name} ${folder.id}`);

let ok = true;
try {
  // 2. The Doc, with its body written the way a `docsync push` writes one.
  const made = await writer.createDoc(folder.id, TITLE, parseMarkdown(BODY));
  say('create', `${made.id} in ${made.batches} batch(es)`);

  // 3. What only Docs can hold: a colour on one paragraph, an image in another.
  const fresh = await api.getDocument(made.id);
  const coloured = paragraphAt(fresh, COLOURED);
  const line = paragraphAt(fresh, IMAGE_LINE);
  await api.batchUpdate(made.id, [
    {
      updateTextStyle: {
        range: { startIndex: coloured.start, endIndex: coloured.end - 1 },
        textStyle: {
          foregroundColor: { color: { rgbColor: { red: 0.8, green: 0.1, blue: 0.1 } } },
        },
        fields: 'foregroundColor',
      },
    },
    { insertInlineImage: { location: { index: line.end - 1 }, uri: IMAGE } },
  ]);
  say('decorate', 'one red paragraph, one inline image');

  // 4. And a comment on the paragraph the push must leave alone.
  const comment = await comments(made.id, {
    content: COMMENT,
    quotedFileContent: { mimeType: 'text/plain', value: COLOURED },
  });
  say('comment', `${comment.id} quoting "${COLOURED}"`);

  const before = await api.getDocument(made.id);
  const base = documentToMarkdown(before);
  const imageIds = objects(before);
  say('base', `${base.split('\n\n').length} blocks, ${imageIds.length} inline object(s)`);

  // 5. One edit of each kind: a word inside a block, a deleted list item, and
  //    a new block at the end. Nothing touches the first paragraph.
  const next = `${base
    .replace('edits one word of this one', 'edits exactly one word of this one')
    .replace('- a bullet that goes\n', '')}\nA paragraph the push appended at the end.\n`;
  if (next === base) {
    console.error('The document did not come back as it was written; nothing to edit.');
    process.exit(1);
  }

  const file = (body: string): string =>
    `---\nid: gdocs:${made.id}\ntitle: ${TITLE}\n---\n\n${body}`;
  const report = await pushRoot(
    { path: 'drive/', src: { source: 'gdocs', id: folder.id }, ignore: [] },
    [{ kind: 'modified', path: PATH, text: file(next), previousText: file(base) }],
    provider,
    new Map([
      [
        PATH,
        { path: PATH, src: { source: 'gdocs', id: made.id }, type: 'gdoc', lastEditedTime: '' },
      ],
    ]),
    { api },
  );
  const counts = report[0]?.blocks;
  say('push', counts === undefined ? 'no counts reported' : JSON.stringify(counts));

  // 6. What the document says now.
  const after = await api.getDocument(made.id);
  ok =
    check(
      'the document says what the file says',
      canonical(documentToMarkdown(after)) === canonical(next),
    ) && ok;

  const red = runs(after).filter((run) => run.textStyle?.foregroundColor !== undefined);
  ok =
    check(
      'the colour on the untouched paragraph survived',
      red.some((run) => (run.content ?? '').startsWith(COLOURED)),
      `${red.length} coloured run(s)`,
    ) && ok;

  const stillThere = objects(after);
  ok =
    check(
      'the inline image survived',
      imageIds.length > 0 && imageIds.every((id) => stillThere.includes(id)),
      `${stillThere.length} inline object(s)`,
    ) && ok;

  const found = await comments(made.id);
  const survived = (found.comments ?? []).filter(
    (one) => (one.content ?? '').includes(COMMENT) && one.deleted !== true,
  );
  ok =
    check(
      'the comment is still on the untouched text',
      survived.length === 1 &&
        survived[0]?.resolved !== true &&
        (survived[0]?.quotedFileContent?.value ?? '').startsWith(COLOURED),
      `${(found.comments ?? []).length} comment(s), quote ${JSON.stringify(
        survived[0]?.quotedFileContent?.value ?? '',
      )}`,
    ) && ok;

  // 7. And the clean-up: the Doc and the folder, both trashed.
  await writer.trash(made.id);
  say('trash', `${made.id} trashed`);
} catch (error) {
  ok = false;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await writer.trash(folder.id);
  say('trash', `${folder.id} trashed`);
}

console.log(
  `\n${ok ? 'All checks passed.' : 'SOME CHECKS FAILED.'}\nLeft behind: the trashed folder "${FOLDER}" (${folder.id}) and the trashed Doc inside it, both recoverable from the Drive trash. The fixture folder was not touched.`,
);
process.exit(ok ? 0 : 1);
