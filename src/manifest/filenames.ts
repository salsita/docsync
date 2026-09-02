/** Longest filename docsync will produce, in UTF-8 bytes, extension included. */
const MAX_NAME_BYTES = 200;

// Characters no filename may contain on Windows, plus the control range and DEL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are exactly what we strip.
const FORBIDDEN = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One candidate document in one directory. */
export interface Sibling {
  id: string;
  title: string;
  /** Including the dot, e.g. `.md`. Empty for a name that carries its own. */
  ext: string;
}

/**
 * Derives a safe filename from a source title (MANUAL §6).
 *
 * `ext` is appended verbatim and must already include its dot. Collisions are
 * not this function's business; see `assignNames`.
 */
export function fileNameFor(title: string, ext: string): string {
  let stem = trimEdges(title.normalize('NFC').replace(FORBIDDEN, '-'));

  // A Windows device name is reserved with any extension at all, so the check is
  // on the part before the first dot: both `CON` and `CON.md` need the suffix.
  const head = stem.split('.', 1).join('');
  if (RESERVED.test(head)) stem = `${head}-${stem.slice(head.length)}`;

  if (stem === '') stem = 'untitled';
  stem = trimEdges(truncateToBytes(stem, MAX_NAME_BYTES - byteLength(ext)));
  if (stem === '') stem = 'untitled';

  return `${stem}${ext}`;
}

/**
 * Names every document in one directory, resolving collisions (MANUAL §6).
 *
 * `previous` is the id-to-filename map the last fetch recorded. An id keeps its
 * name as long as its title still derives to it, which is what makes names
 * stable across fetches even when a sibling appears or disappears. Everything
 * else is named in id order so that the result does not depend on the order the
 * source listed the documents in.
 */
export function assignNames(
  siblings: readonly Sibling[],
  previous?: ReadonlyMap<string, string>,
): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const pending: Sibling[] = [];

  for (const sibling of siblings) {
    const kept = previous?.get(sibling.id);
    if (kept !== undefined && !taken.has(kept.toLowerCase()) && derivesTo(kept, sibling)) {
      names.set(sibling.id, kept);
      taken.add(kept.toLowerCase());
    } else {
      pending.push(sibling);
    }
  }

  for (const sibling of [...pending].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (let n = 1; ; n += 1) {
      const candidate = candidateName(sibling, n);
      if (!taken.has(candidate.toLowerCase())) {
        names.set(sibling.id, candidate);
        taken.add(candidate.toLowerCase());
        break;
      }
    }
  }

  return names;
}

/** The nth name a sibling would take: `Notes.md`, `Notes (2).md`, `Notes (3).md`, … */
function candidateName(sibling: Sibling, n: number): string {
  if (n === 1) return fileNameFor(sibling.title, sibling.ext);
  // The suffix goes before the extension and inside the byte budget, so it is
  // passed as part of the extension rather than glued on afterwards.
  return fileNameFor(sibling.title, ` (${n})${sibling.ext}`);
}

/** Whether `name` is one of the names this sibling's title would produce. */
function derivesTo(name: string, sibling: Sibling): boolean {
  if (name === candidateName(sibling, 1)) return true;
  if (sibling.ext !== '' && !name.endsWith(sibling.ext)) return false;
  const core = sibling.ext === '' ? name : name.slice(0, -sibling.ext.length);
  const match = / \((\d+)\)$/.exec(core);
  if (!match?.[1]) return false;
  return name === candidateName(sibling, Number(match[1]));
}

/** Trims whitespace, leading dots (no hidden files) and trailing dots. */
function trimEdges(text: string): string {
  let out = text.trim();
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out.replace(/^\.+/, '').replace(/\.+$/, '').trim();
  }
  return out;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Cuts `text` to at most `limit` bytes, never inside a character. */
function truncateToBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = byteLength(char);
    if (bytes + size > limit) break;
    bytes += size;
    out += char;
  }
  return out;
}
