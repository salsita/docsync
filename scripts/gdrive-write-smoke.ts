/**
 * The manual test for ticket 08: every write operation once, against the real
 * Drive and Docs APIs.
 *
 * It never touches the fixture folder "Docsync test", which is READ ONLY. It
 * makes **one** folder, "Docsync write test", in the Drive root, copies the
 * Elements Doc and plain.txt into it, and does everything to the copies. The
 * folder is left in place for the owner to look at.
 *
 *   corepack pnpm build
 *   node --experimental-strip-types scripts/gdrive-write-smoke.ts
 *
 * Sign in first with `node scripts/auth-smoke.ts gdocs`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';
import { createGDriveApi, FOLDER_MIME } from '../dist/gdrive/api.js';
import { documentToMarkdown } from '../dist/gdrive/to-markdown.js';
import { createGDriveWriter } from '../dist/gdrive/write.js';
import { parseMarkdown } from '../dist/markdown.js';

/** The fixture tree. This script reads it and never writes to it. */
const ELEMENTS_ID = '1zmLwMqzDV8cy1B-IZe5C76FNjrdIcZzW5MLVX5prQY4';
const PLAIN_ID = '1oiqaDywxRX2qqjSpAlu2gZjS-0BWcqfr';

const FOLDER = 'Docsync write test';

function say(step: string, detail: string): void {
  console.log(`${step.padEnd(12)} ${detail}`);
}

const api = createGDriveApi(await createCredentialProvider().accessToken('gdocs'));
const writer = createGDriveWriter(api);

// 1. One folder in the Drive root, beside the fixture folder and never inside it.
const folder = await api.createFile({ name: FOLDER, mimeType: FOLDER_MIME, parents: ['root'] });
say('folder', `${folder.name} ${folder.id}`);

// 2. The copies. `files.copy` never writes to the original.
const doc = await api.copyFile(ELEMENTS_ID, { name: 'Elements copy', parents: [folder.id] });
say('copy doc', `${doc.name} ${doc.id}`);
const plain = await api.copyFile(PLAIN_ID, { name: 'plain copy.txt', parents: [folder.id] });
say('copy file', `${plain.name} ${plain.id}`);

// 3. The copy's own Markdown, written back over it: the whole of ticket 08 in
//    three lines, and the one honest measure of what a push loses.
const before = documentToMarkdown(await api.getDocument(doc.id));
const result = await writer.replaceBody(doc.id, parseMarkdown(before));
say('replace', `${result.batches} batch(es), dropped: ${result.dropped.join(', ') || 'nothing'}`);

const after = documentToMarkdown(await api.getDocument(doc.id));
say('round trip', after === before ? 'identical' : 'differs');
if (after !== before) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  for (let line = 0; line < Math.max(beforeLines.length, afterLines.length); line += 1) {
    if (beforeLines[line] !== afterLines[line]) {
      say(
        '  line',
        `${line + 1}: ${JSON.stringify(beforeLines[line])} -> ${JSON.stringify(afterLines[line])}`,
      );
    }
  }
}

// 4. Create, rename, move.
const created = await writer.createDoc(
  folder.id,
  'Created by the smoke test',
  parseMarkdown(
    [
      '<!-- docsync: style=title -->',
      '',
      '# Created',
      '',
      'A paragraph with **bold** and `code`.',
      '',
      '- one',
      '  - nested',
      '',
      '- [ ] a checklist item',
      '',
      '| a | b |',
      '|---|---|',
      '| c | d |',
      '',
      '<!-- docsync:pagebreak -->',
      '',
      'After the break.[^1]',
      '',
      '[^1]: The footnote body.',
      '',
    ].join('\n'),
  ),
);
say('create', `${created.id} in ${created.batches} batch(es)`);

const renamed = await writer.rename(created.id, 'Renamed by the smoke test');
say('rename', `${renamed.name}`);

const sub = await writer.createFolder(folder.id, 'Sub');
say('subfolder', sub);
const moved = await writer.move(created.id, sub, folder.id);
say('move', `${moved.id} now in ${sub}`);

// 5. A new revision of the binary: same id, new bytes.
const bytes = new TextEncoder().encode(
  `Written by the smoke test at ${new Date().toISOString()}\n`,
);
const uploaded = await writer.uploadRevision(plain.id, bytes, 'text/plain');
say('upload', `${uploaded.id} ${uploaded.size ?? '?'} bytes`);

// 6. And the trashing, which is reversible.
const trashed = await writer.trash(created.id);
say('trash', `${trashed.id} trashed`);

say('done', `https://drive.google.com/drive/folders/${folder.id}`);
