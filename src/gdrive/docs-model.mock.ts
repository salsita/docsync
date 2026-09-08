/**
 * A Google Doc that lives in memory, for the round trip (ticket 08).
 *
 * `documents.batchUpdate` is the only part of a push that cannot be checked
 * against a recorded fixture: the fixtures say what Google *answers*, not what
 * it does with a request. So this is a small model of the half-dozen request
 * kinds `from-markdown.ts` emits, faithful to the Docs semantics that the
 * generator depends on and to nothing else:
 *
 * - a body is a run of paragraphs and tables, and every index is a UTF-16 code
 *   unit, counted the way `documents.get` reports them (a paragraph's newline
 *   is one, a page break is one, a footnote reference is one, a table costs one
 *   for itself, one per row, one per cell, and one to close);
 * - text inserted at a location **inherits the style and the bullet** of the
 *   paragraph it lands in, which is exactly the trap the generator's explicit
 *   `updateTextStyle` and `deleteParagraphBullets` requests exist to avoid;
 * - `createParagraphBullets` reads the leading tabs of every paragraph in range
 *   as its nesting level and removes them;
 * - deleting a paragraph's newline merges it with the paragraph after it.
 *
 * It is scaffolding, not shipped code, and it is tested on its own in
 * `docs-model.test.ts` so that the round trip is testing the generator rather
 * than two mistakes cancelling out.
 */
import type {
  DocsDocument,
  DocsList,
  NestingLevel,
  Paragraph,
  ParagraphElement,
  StructuralElement,
  TableCell,
  TableRow,
  TextStyle,
} from './api.js';
import type { DocsRequest } from './from-markdown.js';

/** One piece of a paragraph. Exactly the three the generator can create. */
type Item =
  | {
      kind: 'text';
      text: string;
      style: TextStyle;
      /** The suggestion that inserted this text, in suggesting mode (MANUAL §7). */
      insertion?: string;
      /** The suggestions that propose deleting it. The text is still there. */
      deletions?: string[];
    }
  | { kind: 'pageBreak' }
  | { kind: 'footnote'; id: string }
  | { kind: 'image'; id: string; uri: string };

interface Para {
  items: Item[];
  named: string;
  bullet?: { listId: string; nestingLevel: number };
  /**
   * The suggestion whose inserted newline made this paragraph. The body without
   * the suggestions does not have it: `document('preview')` merges it back.
   */
  insertion?: string;
}

/** A cell holds paragraphs, like every other container. */
type Cell = Para[];

type Node = { kind: 'para'; para: Para } | { kind: 'table'; rows: Cell[][] };

/** One reply, in the shape `batchUpdate` answers with. */
export interface BatchReply {
  createFootnote?: { footnoteId?: string };
  /** The suggestion the request became, in suggesting mode (MANUAL §7). */
  suggestionId?: string;
}

/** How a batch is written: over the body, or as suggestions (MANUAL §7). */
export interface ApplyOptions {
  suggest?: boolean;
}

/** What `documents.get` does with pending suggestions (MANUAL §6). */
export type ViewMode = 'preview' | 'inline';

export interface DocsModel {
  /**
   * Applies one batch, in order, and answers one reply per request.
   *
   * With `suggest`, nothing is written to the body: each request becomes one
   * suggestion, which `document('inline')` answers as suggested insertions and
   * deletions and `document('preview')` leaves out entirely — which is what the
   * real API does with `writeControl.writeMode: SUGGEST` (MANUAL §7).
   */
  apply(requests: readonly DocsRequest[], options?: ApplyOptions): BatchReply[];
  /** The document as `documents.get` would answer it. */
  document(mode?: ViewMode): DocsDocument;
  /** The index one past the last character of the body. */
  endIndex(): number;
}

const NORMAL = 'NORMAL_TEXT';

/** The glyphs `documents.get` reports for each preset (ticket 07 Outcome). */
const BULLET_SYMBOLS = ['●', '○', '■'];
const NUMBER_TYPES = ['DECIMAL', 'ALPHA', 'ROMAN'];
const LEVELS = 9;

function emptyPara(named = NORMAL): Para {
  return { items: [], named };
}

/** An empty document: a section break, then one empty paragraph. */
export function createDocsModel(documentId = 'model', title = 'Model'): DocsModel {
  const body: Node[] = [{ kind: 'para', para: emptyPara() }];
  const footnotes = new Map<string, Para[]>();
  const lists = new Map<string, string>();
  let listCount = 0;
  let footnoteCount = 0;
  let imageCount = 0;
  /** How many suggestions this document has been given, for their ids. */
  let suggestionCount = 0;
  /** The URI every inserted image was read from, by object id. */
  const images = new Map<string, string>();

  /* --------------------------------------------------------------- layout */

  function itemLength(item: Item): number {
    return item.kind === 'text' ? item.text.length : 1;
  }

  function paraLength(para: Para): number {
    // The paragraph's own newline is the `+ 1`.
    return para.items.reduce((total, item) => total + itemLength(item), 0) + 1;
  }

  function cellLength(cell: Cell): number {
    return 1 + cell.reduce((total, para) => total + paraLength(para), 0);
  }

  function tableLength(rows: Cell[][]): number {
    let length = 2;
    for (const row of rows) {
      length += 1;
      for (const cell of row) length += cellLength(cell);
    }
    return length;
  }

  /** Every paragraph of one segment, with where it starts and what holds it. */
  interface Slot {
    para: Para;
    start: number;
    /** Puts new paragraphs directly after this one, wherever it lives. */
    insert(paras: readonly Para[]): void;
  }

  function slots(segmentId?: string): Slot[] {
    const out: Slot[] = [];
    if (segmentId !== undefined && segmentId !== '') {
      const content = footnotes.get(segmentId) ?? [];
      let index = 0;
      for (const [at, para] of content.entries()) {
        out.push({ para, start: index, insert: (paras) => content.splice(at + 1, 0, ...paras) });
        index += paraLength(para);
      }
      return out;
    }

    // The body starts at 1: index 0 is the section break.
    let index = 1;
    for (const node of body) {
      if (node.kind === 'para') {
        out.push({ para: node.para, start: index, insert: (paras) => after(node, paras) });
        index += paraLength(node.para);
        continue;
      }
      index += 1;
      for (const row of node.rows) {
        index += 1;
        for (const cell of row) {
          index += 1;
          for (const [at, para] of cell.entries()) {
            out.push({ para, start: index, insert: (paras) => cell.splice(at + 1, 0, ...paras) });
            index += paraLength(para);
          }
        }
      }
      index += 1;
    }
    return out;
  }

  /** Puts paragraphs into the body directly after one of its nodes. */
  function after(node: Node, paras: readonly Para[]): void {
    const at = body.indexOf(node);
    body.splice(at + 1, 0, ...paras.map((para) => ({ kind: 'para' as const, para })));
  }

  function bodyEnd(): number {
    let index = 1;
    for (const node of body) {
      index += node.kind === 'para' ? paraLength(node.para) : tableLength(node.rows);
    }
    return index;
  }

  /** The paragraph an index falls in, and how far into it. */
  function locate(index: number, segmentId?: string): { slot: Slot; offset: number } {
    const all = slots(segmentId);
    let found = all[0];
    for (const slot of all) {
      if (slot.start <= index) found = slot;
    }
    if (found === undefined) throw new Error(`no paragraph at ${index}`);
    const offset = Math.max(0, Math.min(index - found.start, paraLength(found.para) - 1));
    return { slot: found, offset };
  }

  /** The items of a paragraph, cut at `offset`. */
  function split(para: Para, offset: number): [Item[], Item[]] {
    const head: Item[] = [];
    const tail: Item[] = [];
    let seen = 0;
    for (const item of para.items) {
      const length = itemLength(item);
      if (seen + length <= offset) head.push(item);
      else if (seen >= offset) tail.push(item);
      else if (item.kind === 'text') {
        const cut = offset - seen;
        head.push({ ...item, text: item.text.slice(0, cut) });
        tail.push({ ...item, text: item.text.slice(cut) });
      } else tail.push(item);
      seen += length;
    }
    return [head, tail];
  }

  /** The bullet a paragraph carries, for the halves a split leaves behind. */
  function bulletOf(para: Para): { bullet?: { listId: string; nestingLevel: number } } {
    return para.bullet === undefined ? {} : { bullet: { ...para.bullet } };
  }

  /**
   * The style text inserted at `offset` inherits: the run it lands in, and at
   * the very start of a paragraph the run that starts there. This is the trap
   * the generator's explicit `updateTextStyle` per run exists to avoid.
   */
  function styleAt(para: Para, offset: number): TextStyle {
    let seen = 0;
    let style: TextStyle | undefined;
    for (const item of para.items) {
      const length = itemLength(item);
      if (item.kind === 'text' && (style === undefined || seen < offset)) style = item.style;
      seen += length;
    }
    return { ...(style ?? {}) };
  }

  /* ----------------------------------------------------------- operations */

  function insertText(index: number, text: string, segmentId?: string, insertion?: string): void {
    const { slot, offset } = locate(index, segmentId);
    const [head, tail] = split(slot.para, offset);
    const style = styleAt(slot.para, offset);
    const lines = text.split('\n');
    const first = lines[0] ?? '';
    // In suggesting mode the text is inserted and tagged: it is in the document
    // and not in the version the suggestion was made against (MANUAL §7).
    const tag = insertion === undefined ? {} : { insertion };

    slot.para.items = [
      ...head,
      ...(first === '' ? [] : [{ kind: 'text' as const, text: first, style, ...tag }]),
    ];
    const made: Para[] = [];
    for (const line of lines.slice(1)) {
      made.push({
        items: line === '' ? [] : [{ kind: 'text', text: line, style, ...tag }],
        named: slot.para.named,
        ...(slot.para.bullet === undefined ? {} : { bullet: { ...slot.para.bullet } }),
        ...tag,
      });
    }
    const last = made.at(-1);
    if (last === undefined) slot.para.items.push(...tail);
    else last.items.push(...tail);
    slot.insert(made);
  }

  /** Every paragraph a range touches, which is what Docs styles. */
  function inRange(startIndex: number, endIndex: number, segmentId?: string): Para[] {
    return slots(segmentId)
      .filter((slot) => slot.start < endIndex && slot.start + paraLength(slot.para) > startIndex)
      .map((slot) => slot.para);
  }

  function updateParagraphStyle(request: Record<string, unknown>): void {
    const range = request.range as { startIndex: number; endIndex: number; segmentId?: string };
    const style = request.paragraphStyle as { namedStyleType?: string };
    const fields = String(request.fields ?? '');
    if (!fields.includes('namedStyleType') || style.namedStyleType === undefined) return;
    for (const para of inRange(range.startIndex, range.endIndex, range.segmentId)) {
      para.named = style.namedStyleType;
    }
  }

  function updateTextStyle(request: Record<string, unknown>): void {
    const range = request.range as { startIndex: number; endIndex: number; segmentId?: string };
    const style = (request.textStyle ?? {}) as Record<string, unknown>;
    const fields = String(request.fields ?? '').split(',');

    for (const slot of slots(range.segmentId)) {
      let index = slot.start;
      const out: Item[] = [];
      for (const item of slot.para.items) {
        const length = itemLength(item);
        if (item.kind !== 'text') {
          out.push(item);
          index += length;
          continue;
        }
        // The piece of this run that the range covers is styled; the rest of
        // the run stays as it was, which is why a run can be cut in three.
        const from = Math.max(range.startIndex - index, 0);
        const to = Math.min(range.endIndex - index, length);
        if (from >= to) {
          out.push(item);
          index += length;
          continue;
        }
        const styled: TextStyle = { ...item.style };
        for (const field of fields) {
          if (field in style) (styled as Record<string, unknown>)[field] = style[field];
          else delete (styled as Record<string, unknown>)[field];
        }
        if (from > 0) out.push({ kind: 'text', text: item.text.slice(0, from), style: item.style });
        out.push({ kind: 'text', text: item.text.slice(from, to), style: styled });
        if (to < length) out.push({ kind: 'text', text: item.text.slice(to), style: item.style });
        index += length;
      }
      slot.para.items = out;
    }
  }

  function createParagraphBullets(request: Record<string, unknown>): void {
    const range = request.range as { startIndex: number; endIndex: number; segmentId?: string };
    listCount += 1;
    const listId = `kix.list.${listCount}`;
    lists.set(listId, String(request.bulletPreset ?? ''));

    for (const para of inRange(range.startIndex, range.endIndex, range.segmentId)) {
      // The nesting level is the leading tabs, which the request then removes.
      let tabs = 0;
      for (const item of para.items) {
        if (item.kind !== 'text') break;
        const found = /^\t*/.exec(item.text)?.[0].length ?? 0;
        tabs += found;
        item.text = item.text.slice(found);
        if (item.text !== '') break;
      }
      para.items = para.items.filter((item) => item.kind !== 'text' || item.text !== '');
      para.bullet = { listId, nestingLevel: Math.min(tabs, LEVELS - 1) };
    }
  }

  function deleteParagraphBullets(request: Record<string, unknown>): void {
    const range = request.range as { startIndex: number; endIndex: number; segmentId?: string };
    for (const para of inRange(range.startIndex, range.endIndex, range.segmentId)) {
      para.bullet = undefined;
    }
  }

  /**
   * A suggested deletion (MANUAL §7): the text stays exactly where it is and
   * carries the suggestion's id, which is how `documents.get` reports one
   * inline and why a suggested deletion is still part of the base a push diffs
   * from.
   */
  function markDeleted(request: Record<string, unknown>, id: string): void {
    const range = request.range as { startIndex: number; endIndex: number; segmentId?: string };
    for (const slot of slots(range.segmentId)) {
      let index = slot.start;
      const out: Item[] = [];
      for (const item of slot.para.items) {
        const length = itemLength(item);
        const from = Math.max(range.startIndex - index, 0);
        const to = Math.min(range.endIndex - index, length);
        index += length;
        if (item.kind !== 'text' || from >= to) {
          out.push(item);
          continue;
        }
        if (from > 0) out.push({ ...item, text: item.text.slice(0, from) });
        out.push({
          ...item,
          text: item.text.slice(from, to),
          deletions: [...(item.deletions ?? []), id],
        });
        if (to < length) out.push({ ...item, text: item.text.slice(to) });
      }
      slot.para.items = out;
    }
  }

  /** One paragraph without what the pending suggestions did to it. */
  function plainPara(para: Para): Para {
    return {
      items: para.items
        .filter((item) => item.kind !== 'text' || item.insertion === undefined)
        .map((item) =>
          item.kind === 'text'
            ? { kind: 'text' as const, text: item.text, style: item.style }
            : item,
        ),
      named: para.named,
      ...(para.bullet === undefined ? {} : { bullet: { ...para.bullet } }),
    };
  }

  /**
   * A run of paragraphs as the document reads without its suggestions: the
   * inserted text is gone, the text a suggestion would delete is still there,
   * and a paragraph a suggested newline made is merged back into the one before
   * it. This is what `PREVIEW_WITHOUT_SUGGESTIONS` answers (MANUAL §6).
   */
  function plainParas(list: readonly Para[]): Para[] {
    const out: Para[] = [];
    for (const para of list) {
      const plain = plainPara(para);
      const previous = out.at(-1);
      if (para.insertion !== undefined && previous !== undefined) {
        previous.items.push(...plain.items);
        continue;
      }
      out.push(plain);
    }
    return out;
  }

  /** The whole body without its suggestions, tables and all. */
  function plainBody(nodes: readonly Node[]): Node[] {
    const out: Node[] = [];
    for (const node of nodes) {
      if (node.kind === 'table') {
        out.push({
          kind: 'table',
          rows: node.rows.map((row) => row.map((cell) => plainParas(cell))),
        });
        continue;
      }
      const plain = plainPara(node.para);
      const previous = out.at(-1);
      if (node.para.insertion !== undefined && previous?.kind === 'para') {
        previous.para.items.push(...plain.items);
        continue;
      }
      out.push({ kind: 'para', para: plain });
    }
    return out;
  }

  function insertPageBreak(index: number): void {
    const { slot, offset } = locate(index);
    const [head, tail] = split(slot.para, offset);
    slot.para.items = [...head, { kind: 'pageBreak' }];
    // A page break is followed by a newline, so the paragraph is cut in two —
    // and both halves are still the paragraph they were, bullet included.
    slot.insert([{ items: tail, named: slot.para.named, ...bulletOf(slot.para) }]);
  }

  function insertTable(request: Record<string, unknown>): void {
    const location = request.location as { index: number };
    const rows = Number(request.rows ?? 0);
    const columns = Number(request.columns ?? 0);
    const { slot, offset } = locate(location.index);
    const [head, tail] = split(slot.para, offset);
    slot.para.items = head;

    const grid: Cell[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const made: Cell[] = [];
      for (let column = 0; column < columns; column += 1) made.push([emptyPara()]);
      grid.push(made);
    }

    // A newline goes in before the table, which is the paragraph the split left
    // behind; the rest of the original paragraph follows the table.
    const at = body.findIndex((node) => node.kind === 'para' && node.para === slot.para);
    body.splice(
      at + 1,
      0,
      { kind: 'table', rows: grid },
      { kind: 'para', para: { items: tail, named: slot.para.named, ...bulletOf(slot.para) } },
    );
  }

  /** The rows of the table that starts at an index, as `structure` counts. */
  function tableAt(index: number): Cell[][] | undefined {
    let at = 1;
    for (const node of body) {
      if (node.kind === 'para') {
        at += paraLength(node.para);
        continue;
      }
      if (at === index) return node.rows;
      at += tableLength(node.rows);
    }
    return undefined;
  }

  /** A row of empty cells, which is what `insertTableRow` makes. */
  function insertTableRow(request: Record<string, unknown>): void {
    const where = request.tableCellLocation as {
      tableStartLocation: { index: number };
      rowIndex?: number;
    };
    const rows = tableAt(where.tableStartLocation.index);
    if (rows === undefined) throw new Error(`no table at ${where.tableStartLocation.index}`);
    const columns = rows[0]?.length ?? 0;
    const made: Cell[] = [];
    for (let column = 0; column < columns; column += 1) made.push([emptyPara()]);
    const at = (where.rowIndex ?? 0) + (request.insertBelow === true ? 1 : 0);
    rows.splice(at, 0, made);
  }

  function deleteTableRow(request: Record<string, unknown>): void {
    const where = request.tableCellLocation as {
      tableStartLocation: { index: number };
      rowIndex?: number;
    };
    const rows = tableAt(where.tableStartLocation.index);
    if (rows === undefined) throw new Error(`no table at ${where.tableStartLocation.index}`);
    rows.splice(where.rowIndex ?? 0, 1);
  }

  /**
   * `insertInlineImage`: Docs copies the bytes out of the URI into the
   * document and keeps an object of its own, one code unit wide (MANUAL §12
   * phase 2). The URI is remembered so a test can say which file it came from.
   */
  function insertInlineImage(request: Record<string, unknown>): BatchReply {
    const location = request.location as { index: number };
    imageCount += 1;
    const id = `kix.img${imageCount}`;
    images.set(id, String(request.uri ?? ''));
    const { slot, offset } = locate(location.index);
    const [head, tail] = split(slot.para, offset);
    slot.para.items = [...head, { kind: 'image', id, uri: String(request.uri ?? '') }, ...tail];
    return {};
  }

  function createFootnote(request: Record<string, unknown>): BatchReply {
    const location = request.location as { index: number };
    footnoteCount += 1;
    const id = `kix.fn${footnoteCount}`;
    // Docs seeds a new footnote with a space, which is why a body replaces the
    // segment rather than being inserted in front of it (ticket 08 Outcome).
    footnotes.set(id, [{ items: [{ kind: 'text', text: ' ', style: {} }], named: NORMAL }]);

    const { slot, offset } = locate(location.index);
    const [head, tail] = split(slot.para, offset);
    slot.para.items = [...head, { kind: 'footnote', id }, ...tail];
    return { createFootnote: { footnoteId: id } };
  }

  /**
   * One paragraph merged into the one before it, whose own newline a deletion
   * took.
   *
   * The text joins, and the **later** paragraph's style and bullet win: a
   * paragraph's properties hang off its paragraph mark, the deletion took the
   * first paragraph's mark and left the second's standing, so what remains is
   * the second paragraph with the first's text in front of it. The model used
   * to keep the first one's, which is why it said a deleted list item handed
   * its bullet to the paragraph after it and left that paragraph's own nesting
   * behind — a defect the real API does not have (ticket 32).
   */
  function absorb(into: Para, para: Para): void {
    into.items.push(...para.items);
    into.named = para.named;
    into.bullet = para.bullet === undefined ? undefined : { ...para.bullet };
  }

  /** Removes a range, merging the paragraphs whose newline it took. */
  function deleteContentRange(request: Record<string, unknown>): void {
    const range = request.range as { startIndex: number; endIndex: number; segmentId?: string };
    if (range.segmentId !== undefined && range.segmentId !== '') {
      deleteFromSegment(range.segmentId, range.startIndex, range.endIndex);
      return;
    }
    // A range inside one cell is the cell's own business; the body loop below
    // would take the whole table out with it.
    const cell = cellAt(range.startIndex);
    if (cell !== undefined && range.endIndex <= cell.end) {
      const kept = prune(cell.cell, range.startIndex - cell.start, range.endIndex - cell.start);
      cell.cell.length = 0;
      cell.cell.push(...(kept.length === 0 ? [emptyPara()] : kept));
      return;
    }

    const kept: Node[] = [];
    let index = 1;
    let merging: Para | undefined;

    for (const node of body) {
      if (node.kind === 'table') {
        const start = index;
        index += tableLength(node.rows);
        if (start >= range.endIndex || index <= range.startIndex) kept.push(node);
        continue;
      }
      const para = node.para;
      const start = index;
      const end = index + paraLength(para);
      index = end;

      if (range.endIndex <= start || range.startIndex >= end) {
        if (merging === undefined) kept.push(node);
        else {
          absorb(merging, para);
          merging = undefined;
        }
        continue;
      }

      trim(para, range.startIndex - start, range.endIndex - start);
      const newlineGone = range.startIndex <= end - 1 && range.endIndex > end - 1;
      let target = para;
      if (merging === undefined) kept.push(node);
      else {
        absorb(merging, para);
        target = merging;
      }
      merging = newlineGone ? target : undefined;
    }

    body.length = 0;
    body.push(...(kept.length === 0 ? [{ kind: 'para' as const, para: emptyPara() }] : kept));
  }

  /**
   * The same, for a run of paragraphs that is not the body: a footnote
   * segment, or one cell of a table. Kept apart from the body's version
   * because the body also holds tables.
   */
  function prune(content: readonly Para[], startIndex: number, endIndex: number): Para[] {
    const kept: Para[] = [];
    let index = 0;
    let merging: Para | undefined;

    for (const para of content) {
      const start = index;
      const end = index + paraLength(para);
      index = end;
      if (endIndex <= start || startIndex >= end) {
        if (merging === undefined) kept.push(para);
        else {
          absorb(merging, para);
          merging = undefined;
        }
        continue;
      }
      trim(para, startIndex - start, endIndex - start);
      const newlineGone = startIndex <= end - 1 && endIndex > end - 1;
      let target = para;
      if (merging === undefined) kept.push(para);
      else {
        absorb(merging, para);
        target = merging;
      }
      merging = newlineGone ? target : undefined;
    }
    return kept;
  }

  function deleteFromSegment(segmentId: string, startIndex: number, endIndex: number): void {
    const content = footnotes.get(segmentId);
    if (content === undefined) return;
    const kept = prune(content, startIndex, endIndex);
    footnotes.set(segmentId, kept.length === 0 ? [emptyPara()] : kept);
  }

  /** The table cell an index falls in, and where its paragraphs start. */
  function cellAt(index: number): { cell: Cell; start: number; end: number } | undefined {
    let at = 1;
    for (const node of body) {
      if (node.kind === 'para') {
        at += paraLength(node.para);
        continue;
      }
      let inner = at + 1;
      for (const row of node.rows) {
        inner += 1;
        for (const cell of row) {
          const start = inner + 1;
          const length = cell.reduce((total, para) => total + paraLength(para), 0);
          if (index >= start && index < start + length) {
            return { cell, start, end: start + length };
          }
          inner += 1 + length;
        }
      }
      at += tableLength(node.rows);
    }
    return undefined;
  }

  /** Removes the items, and the parts of items, that a range covers. */
  function trim(para: Para, from: number, to: number): void {
    const out: Item[] = [];
    let seen = 0;
    for (const item of para.items) {
      const length = itemLength(item);
      const start = seen;
      seen += length;
      if (start >= to || seen <= from) {
        out.push(item);
        continue;
      }
      if (item.kind !== 'text') continue;
      const head = item.text.slice(0, Math.max(from - start, 0));
      const tail = item.text.slice(Math.min(Math.max(to - start, 0), length));
      if (head + tail !== '') out.push({ ...item, text: head + tail });
    }
    para.items = out;
  }

  /* ---------------------------------------------------------- the document */

  function elements(para: Para, start: number): ParagraphElement[] {
    const out: ParagraphElement[] = [];
    let index = start;
    const numbers = footnoteNumbers();

    for (const item of para.items) {
      const length = itemLength(item);
      const bounds = { startIndex: index, endIndex: index + length };
      if (item.kind === 'text')
        out.push({
          ...bounds,
          textRun: {
            content: item.text,
            textStyle: item.style,
            // Inline, a pending suggestion is reported on the runs it touches
            // (MANUAL §6); `plainPara` is what takes them off again.
            ...(item.insertion === undefined ? {} : { suggestedInsertionIds: [item.insertion] }),
            ...(item.deletions === undefined ? {} : { suggestedDeletionIds: [...item.deletions] }),
          },
        });
      else if (item.kind === 'pageBreak') out.push({ ...bounds, pageBreak: {} });
      else if (item.kind === 'image') {
        out.push({ ...bounds, inlineObjectElement: { inlineObjectId: item.id } });
      } else {
        out.push({
          ...bounds,
          footnoteReference: {
            footnoteId: item.id,
            footnoteNumber: String(numbers.get(item.id) ?? 1),
          },
        });
      }
      index += length;
    }

    // The paragraph's newline is part of its last run, as Docs reports it.
    const last = out.at(-1);
    if (last?.textRun !== undefined) {
      last.textRun.content = `${last.textRun.content ?? ''}\n`;
      last.endIndex = (last.endIndex ?? index) + 1;
    } else {
      out.push({
        startIndex: index,
        endIndex: index + 1,
        textRun: { content: '\n', textStyle: {} },
      });
    }
    return out;
  }

  /** Footnote numbers, which Docs assigns by where the reference stands. */
  function footnoteNumbers(): Map<string, number> {
    const numbers = new Map<string, number>();
    for (const slot of slots()) {
      for (const item of slot.para.items) {
        if (item.kind === 'footnote' && !numbers.has(item.id))
          numbers.set(item.id, numbers.size + 1);
      }
    }
    return numbers;
  }

  function paragraph(para: Para, start: number): StructuralElement {
    const content: Paragraph = {
      elements: elements(para, start),
      paragraphStyle: { namedStyleType: para.named },
      ...(para.bullet === undefined ? {} : { bullet: { ...para.bullet } }),
    };
    return { startIndex: start, endIndex: start + paraLength(para), paragraph: content };
  }

  function structure(nodes: readonly Node[], from: number): StructuralElement[] {
    const out: StructuralElement[] = [];
    let index = from;
    for (const node of nodes) {
      if (node.kind === 'para') {
        out.push(paragraph(node.para, index));
        index += paraLength(node.para);
        continue;
      }
      const start = index;
      index += 1;
      const tableRows: TableRow[] = [];
      for (const row of node.rows) {
        const rowStart = index;
        index += 1;
        const cells: TableCell[] = [];
        for (const cell of row) {
          const cellStart = index;
          index += 1;
          const content = structure(
            cell.map((para) => ({ kind: 'para' as const, para })),
            index,
          );
          index += cell.reduce((total, para) => total + paraLength(para), 0);
          cells.push({ startIndex: cellStart, endIndex: index, content });
        }
        tableRows.push({ startIndex: rowStart, endIndex: index, tableCells: cells });
      }
      index += 1;
      out.push({
        startIndex: start,
        endIndex: index,
        table: { rows: node.rows.length, columns: node.rows[0]?.length ?? 0, tableRows },
      });
    }
    return out;
  }

  /** The nesting levels `documents.get` reports for one preset. */
  function nestingLevels(preset: string): NestingLevel[] {
    const out: NestingLevel[] = [];
    for (let level = 0; level < LEVELS; level += 1) {
      if (preset.startsWith('NUMBERED')) {
        out.push({
          glyphType: NUMBER_TYPES[level % NUMBER_TYPES.length],
          glyphFormat: `%${level}.`,
          startNumber: 1,
        });
      } else if (preset === 'BULLET_CHECKBOX') {
        // A checklist is Docs' odd one out: no symbol, no type, a bare `%n`.
        out.push({ glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphFormat: `%${level}` });
      } else {
        out.push({
          glyphSymbol: BULLET_SYMBOLS[level % BULLET_SYMBOLS.length],
          glyphFormat: `%${level}`,
        });
      }
    }
    return out;
  }

  return {
    apply(requests, options = {}) {
      const replies: BatchReply[] = [];
      for (const request of requests) {
        const [name, value] = Object.entries(request)[0] ?? [];
        const payload = (value ?? {}) as Record<string, unknown>;
        // One suggestion per request, which is what the preview API answers and
        // what the sidecar then shows as one thread each (MANUAL §6, §7).
        if (options.suggest === true) {
          suggestionCount += 1;
          const id = `suggest.s${suggestionCount}`;
          if (name === 'insertText') {
            const location = payload.location as { index: number; segmentId?: string };
            insertText(location.index, String(payload.text ?? ''), location.segmentId, id);
          } else if (name === 'deleteContentRange') {
            markDeleted(payload, id);
          } else if (name === undefined) {
            throw new Error('an empty request');
          }
          // Everything else is a style or a bullet: a suggestion that changes no
          // text, which the sidecar prints as `formatting only` (MANUAL §6).
          replies.push({ suggestionId: id });
          continue;
        }
        switch (name) {
          case 'insertText': {
            const location = payload.location as { index: number; segmentId?: string };
            insertText(location.index, String(payload.text ?? ''), location.segmentId);
            replies.push({});
            break;
          }
          case 'deleteContentRange':
            deleteContentRange(payload);
            replies.push({});
            break;
          case 'updateParagraphStyle':
            updateParagraphStyle(payload);
            replies.push({});
            break;
          case 'updateTextStyle':
            updateTextStyle(payload);
            replies.push({});
            break;
          case 'createParagraphBullets':
            createParagraphBullets(payload);
            replies.push({});
            break;
          case 'deleteParagraphBullets':
            deleteParagraphBullets(payload);
            replies.push({});
            break;
          case 'insertInlineImage':
            replies.push(insertInlineImage(payload));
            break;
          case 'insertPageBreak':
            insertPageBreak((payload.location as { index: number }).index);
            replies.push({});
            break;
          case 'insertTable':
            insertTable(payload);
            replies.push({});
            break;
          case 'insertTableRow':
            insertTableRow(payload);
            replies.push({});
            break;
          case 'deleteTableRow':
            deleteTableRow(payload);
            replies.push({});
            break;
          case 'createFootnote':
            replies.push(createFootnote(payload));
            break;
          default:
            throw new Error(`the model does not know ${name}`);
        }
      }
      return replies;
    },

    endIndex: bodyEnd,

    document(mode = 'inline') {
      // `preview` is the document without its pending suggestions, which is
      // what a fetch reads and what the body on disk is made of (MANUAL §6).
      const nodes = mode === 'preview' ? plainBody(body) : body;
      const listed: Record<string, DocsList> = {};
      for (const [listId, preset] of lists) {
        listed[listId] = { listProperties: { nestingLevels: nestingLevels(preset) } };
      }
      const notes: DocsDocument['footnotes'] = {};
      for (const [id, content] of footnotes) {
        notes[id] = {
          footnoteId: id,
          content: structure(
            (mode === 'preview' ? plainParas(content) : content).map((para) => ({
              kind: 'para' as const,
              para,
            })),
            0,
          ),
        };
      }
      return {
        documentId,
        title,
        body: { content: [{ endIndex: 1, sectionBreak: {} }, ...structure(nodes, 1)] },
        lists: listed,
        footnotes: notes,
        ...(images.size === 0
          ? {}
          : {
              inlineObjects: Object.fromEntries(
                [...images].map(([id, uri]) => [
                  id,
                  {
                    objectId: id,
                    inlineObjectProperties: {
                      embeddedObject: { imageProperties: { contentUri: uri } },
                    },
                  },
                ]),
              ),
            }),
      };
    },
  };
}
