/**
 * Prove that an adapter can reach a real API knowing nothing but
 * `createCredentialProvider()` — the "ten-line sketch adapter" of ticket 04's
 * Done-when. Plain `fetch`, no SDKs.
 *
 *   corepack pnpm build
 *   node scripts/api-smoke.ts notion
 *   node scripts/api-smoke.ts gdocs
 *
 * Sign in first with `node scripts/auth-smoke.ts <source>`.
 */
import { createCredentialProvider } from '../dist/auth/index.js';

const ALIASES = { google: 'gdocs', notion: 'notion', gdocs: 'gdocs' };

const [rawSource] = process.argv.slice(2);
const source = ALIASES[rawSource as keyof typeof ALIASES];
if (!source) {
  console.error(`${rawSource ? `Unknown source "${rawSource}".` : 'Which source?'}
Usage: node scripts/api-smoke.ts <notion|gdocs>`);
  process.exit(2);
}

/** A rich-text array flattened to its plain text. */
function plain(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((part) => String((part as { plain_text?: string }).plain_text ?? '')).join('');
}

/** Notion buries a page title under whichever property happens to be the title. */
function notionTitle(result: Record<string, unknown>): string {
  const direct = plain(result.title);
  if (direct !== undefined) return direct || '(untitled)';
  const properties = (result.properties ?? {}) as Record<
    string,
    { type?: string; title?: unknown }
  >;
  for (const property of Object.values(properties)) {
    if (property?.type === 'title') return plain(property.title) || '(untitled)';
  }
  return '(untitled)';
}

const provider = createCredentialProvider();

try {
  const token = await provider.accessToken(source);

  if (source === 'notion') {
    const response = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': '2022-06-28',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Notion answered ${response.status}: ${body.message}`);
    console.log(`${body.results.length} object(s) shared with this token:`);
    for (const result of body.results) {
      console.log(`  ${result.object.padEnd(8)} ${notionTitle(result)}`);
    }
  } else {
    const response = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=5', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`Google answered ${response.status}: ${body.error?.message}`);
    console.log(`${body.files.length} file(s) in the Drive root:`);
    for (const file of body.files) {
      console.log(`  ${file.mimeType.padEnd(45)} ${file.name}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
