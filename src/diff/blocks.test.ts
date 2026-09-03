import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../markdown.js';
import { type BlockOp, countOps, diffBlocks, flattenBlocks } from './blocks.js';

/** The ops of one diff, as `op type: text`, children indented under theirs. */
function shape(ops: readonly BlockOp[], indent = ''): string[] {
  return ops.flatMap((op) => {
    const block = op.op === 'delete' ? op.base : op.next;
    const line = `${indent}${op.op} ${block.type}: ${block.text}`;
    const children = op.op === 'keep' || op.op === 'update' ? op.children : [];
    return [line, ...shape(children, `${indent}  `)];
  });
}

const diff = (base: string, next: string): BlockOp[] =>
  diffBlocks(parseMarkdown(base), parseMarkdown(next));

describe('flattenBlocks', () => {
  it('is one block per source block, not one per mdast node', () => {
    const blocks = flattenBlocks(parseMarkdown('- one\n- two\n\nAfter.\n'));
    expect(blocks.map((block) => `${block.type}: ${block.text}`)).toEqual([
      'listItem:bullet: one',
      'listItem:bullet: two',
      'paragraph: After.',
    ]);
  });

  it('hangs a nested list, a toggle’s body and a table’s rows off their block', () => {
    const nested = flattenBlocks(parseMarkdown('- one\n  - deep\n'));
    expect(nested).toHaveLength(1);
    expect(nested[0]?.children.map((child) => child.text)).toEqual(['deep']);

    const toggle = flattenBlocks(
      parseMarkdown('<details>\n<summary>T</summary>\n\nIn.\n\n</details>\n'),
    );
    expect(toggle[0]?.type).toBe('toggle');
    expect(toggle[0]?.children.map((child) => child.text)).toEqual(['In.']);

    const table = flattenBlocks(parseMarkdown('| a | b |\n| --- | --- |\n| c | d |\n'));
    expect(table[0]?.type).toBe('table');
    expect(table[0]?.children.map((row) => row.text)).toEqual(['a\tb', 'c\td']);
  });

  it('keeps an attribute comment with the block it belongs to', () => {
    const blocks = flattenBlocks(parseMarkdown('<!-- docsync: color=red -->\n\nText.\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.markdown).toContain('color=red');
  });

  it('makes a placeholder a block of its own', () => {
    const blocks = flattenBlocks(parseMarkdown('<!-- docsync:block notion:abc type=embed -->\n'));
    expect(blocks.map((block) => block.type)).toEqual(['placeholder:embed']);
  });

  it('tells a callout from a quote and a heading from a paragraph', () => {
    expect(flattenBlocks(parseMarkdown('> [!CALLOUT] 💡\n> Body.\n'))[0]?.type).toBe('callout');
    expect(flattenBlocks(parseMarkdown('> Quoted.\n'))[0]?.type).toBe('quote');
    expect(flattenBlocks(parseMarkdown('## Two\n'))[0]?.type).toBe('heading:2');
  });
});

describe('diffBlocks', () => {
  it('keeps every block of an unchanged document', () => {
    const ops = diff('One.\n\nTwo.\n', 'One.\n\nTwo.\n');
    expect(shape(ops)).toEqual(['keep paragraph: One.', 'keep paragraph: Two.']);
    expect(countOps(ops)).toEqual({ kept: 2, updated: 0, inserted: 0, deleted: 0 });
  });

  it('updates the one paragraph that was edited', () => {
    const ops = diff(
      'One.\n\nThe second paragraph, as written.\n\nThree.\n',
      'One.\n\nThe second paragraph, as edited.\n\nThree.\n',
    );
    expect(shape(ops)).toEqual([
      'keep paragraph: One.',
      'update paragraph: The second paragraph, as edited.',
      'keep paragraph: Three.',
    ]);
    expect(countOps(ops)).toEqual({ kept: 2, updated: 1, inserted: 0, deleted: 0 });
  });

  it('inserts at the start, in the middle and at the end', () => {
    expect(shape(diff('One.\n\nTwo.\n', 'New.\n\nOne.\n\nTwo.\n'))).toEqual([
      'insert paragraph: New.',
      'keep paragraph: One.',
      'keep paragraph: Two.',
    ]);
    expect(shape(diff('One.\n\nTwo.\n', 'One.\n\nNew.\n\nTwo.\n'))).toEqual([
      'keep paragraph: One.',
      'insert paragraph: New.',
      'keep paragraph: Two.',
    ]);
    expect(shape(diff('One.\n\nTwo.\n', 'One.\n\nTwo.\n\nNew.\n'))).toEqual([
      'keep paragraph: One.',
      'keep paragraph: Two.',
      'insert paragraph: New.',
    ]);
  });

  it('deletes a block that is gone', () => {
    const ops = diff('One.\n\nTwo.\n\nThree.\n', 'One.\n\nThree.\n');
    expect(shape(ops)).toEqual([
      'keep paragraph: One.',
      'delete paragraph: Two.',
      'keep paragraph: Three.',
    ]);
    expect(countOps(ops)).toEqual({ kept: 2, updated: 0, inserted: 0, deleted: 1 });
  });

  it('sees a block that changed places as a move', () => {
    const ops = diff('A.\n\nB.\n\nC.\n', 'B.\n\nC.\n\nA.\n');
    expect(shape(ops)).toEqual(['keep paragraph: B.', 'keep paragraph: C.', 'move paragraph: A.']);
    // A move is a deletion and an insertion at both sources (MANUAL §7).
    expect(countOps(ops)).toEqual({ kept: 2, updated: 0, inserted: 1, deleted: 1 });
  });

  it('updates two adjacent blocks rather than replacing the pair', () => {
    const ops = diff(
      'The first paragraph here.\n\nThe second paragraph here.\n',
      'The first paragraph now.\n\nThe second paragraph now.\n',
    );
    expect(shape(ops)).toEqual([
      'update paragraph: The first paragraph now.',
      'update paragraph: The second paragraph now.',
    ]);
  });

  it('makes a heading that became a paragraph a delete and an insert', () => {
    const ops = diff('# Title\n\nBody.\n', 'Title\n\nBody.\n');
    expect(shape(ops)).toEqual([
      'delete heading:1: Title',
      'insert paragraph: Title',
      'keep paragraph: Body.',
    ]);
  });

  it('edits a nested list item without touching its siblings', () => {
    const ops = diff(
      '- one\n  - deep one\n  - deep two\n- two\n',
      '- one\n  - deep one edited\n  - deep two\n- two\n',
    );
    expect(shape(ops)).toEqual([
      'keep listItem:bullet: one',
      '  update listItem:bullet: deep one edited',
      '  keep listItem:bullet: deep two',
      'keep listItem:bullet: two',
    ]);
    expect(countOps(ops)).toEqual({ kept: 3, updated: 1, inserted: 0, deleted: 0 });
  });

  it('edits a table cell as an update of its row', () => {
    const ops = diff(
      '| a | b |\n| --- | --- |\n| c | the original cell text |\n',
      '| a | b |\n| --- | --- |\n| c | the changed cell text |\n',
    );
    expect(shape(ops)).toEqual([
      'keep table: ',
      '  keep tableRow: a\tb',
      '  update tableRow: c\tthe changed cell text',
    ]);
  });

  it('pairs a hunk’s candidates by similarity, not by position', () => {
    const ops = diff(
      'Keep me.\n\nThe quick brown fox jumps over the dog.\n',
      'Keep me.\n\nSomething else entirely, unrelated.\n\nThe quick brown fox leaps over the dog.\n',
    );
    expect(shape(ops)).toEqual([
      'keep paragraph: Keep me.',
      'insert paragraph: Something else entirely, unrelated.',
      'update paragraph: The quick brown fox leaps over the dog.',
    ]);
  });

  it('updates a short block edited past half its text', () => {
    // Git's measure calls these two 33% alike, which is not what a reader
    // means: one paragraph was replaced by one paragraph, in the same place.
    const ops = diff('One.\n\nTwo.\n\nThree.\n', 'One.\n\nTwo, edited.\n\nThree.\n');
    expect(shape(ops)).toEqual([
      'keep paragraph: One.',
      'update paragraph: Two, edited.',
      'keep paragraph: Three.',
    ]);
    expect(countOps(ops)).toEqual({ kept: 2, updated: 1, inserted: 0, deleted: 0 });
  });

  it('does not fall back when a hunk holds more than one candidate either way', () => {
    // Two removed and one inserted: nothing here says which of the two the
    // insertion is, so only the similar pair is an update.
    const ops = diff(
      'One.\n\nTwo.\n\nThe quick brown fox jumps over the dog.\n\nEnd.\n',
      'One.\n\nThe quick brown fox leaps over the dog.\n\nEnd.\n',
    );
    expect(shape(ops)).toEqual([
      'keep paragraph: One.',
      'delete paragraph: Two.',
      'update paragraph: The quick brown fox leaps over the dog.',
      'keep paragraph: End.',
    ]);
  });

  it('never falls back across block types', () => {
    const ops = diff('One.\n\nTwo.\n\nEnd.\n', 'One.\n\n## Two, edited.\n\nEnd.\n');
    expect(shape(ops)).toEqual([
      'keep paragraph: One.',
      'delete paragraph: Two.',
      'insert heading:2: Two, edited.',
      'keep paragraph: End.',
    ]);
  });

  it('does not pair blocks of different types, however alike', () => {
    const ops = diff('The quick brown fox.\n', '## The quick brown fox.\n');
    expect(shape(ops).sort()).toEqual([
      'delete paragraph: The quick brown fox.',
      'insert heading:2: The quick brown fox.',
    ]);
  });

  it('carries the whole block, children included, for an insertion', () => {
    const ops = diff('A.\n', 'A.\n\n- new\n  - deep\n');
    const inserted = ops.find((op) => op.op === 'insert');
    expect(inserted?.op === 'insert' && inserted.next.source.length).toBe(1);
    expect(inserted?.op === 'insert' && inserted.next.children[0]?.text).toBe('deep');
  });
});
