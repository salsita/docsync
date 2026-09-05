import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from './frontmatter.js';
import { parseMarkdown, stringifyMarkdown } from './markdown.js';

const REF = { source: 'notion', id: '3cf715cbeb088035b511f0b4f06efbd5' } as const;

describe('serializeDocument', () => {
  it('writes id and title in that order, then the body', () => {
    expect(serializeDocument({ id: REF, title: 'Auth' }, 'Hello.\n')).toBe(
      '---\nid: notion:3cf715cbeb088035b511f0b4f06efbd5\ntitle: Auth\n---\n\nHello.\n',
    );
  });

  it('writes url after title when there is one (ticket 27)', () => {
    expect(
      serializeDocument(
        { id: REF, title: 'Auth', url: 'https://www.notion.so/3cf715cbeb088035b511f0b4f06efbd5' },
        'Hello.\n',
      ),
    ).toBe(
      '---\nid: notion:3cf715cbeb088035b511f0b4f06efbd5\ntitle: Auth\n' +
        'url: https://www.notion.so/3cf715cbeb088035b511f0b4f06efbd5\n---\n\nHello.\n',
    );
  });

  it('quotes a title YAML would otherwise misread', () => {
    const text = serializeDocument({ id: REF, title: '- yes: no #1' }, '');
    expect(text).toContain('title: "- yes: no #1"');
    expect(parseDocument(text).frontmatter?.title).toBe('- yes: no #1');
  });

  it('accepts a body that is already an mdast tree', () => {
    const text = serializeDocument({ id: REF, title: 'Tree' }, parseMarkdown('# Head\n'));
    expect(text.endsWith('# Head\n')).toBe(true);
  });

  it('writes an empty body as frontmatter alone', () => {
    expect(serializeDocument({ id: REF, title: 'Leaf' }, '')).toBe(
      '---\nid: notion:3cf715cbeb088035b511f0b4f06efbd5\ntitle: Leaf\n---\n',
    );
  });
});

describe('parseDocument', () => {
  it('reads back what serializeDocument wrote', () => {
    const text = serializeDocument({ id: REF, title: 'Auth' }, 'Hello.\n');
    const { frontmatter, body } = parseDocument(text);
    expect(frontmatter).toEqual({ id: REF, title: 'Auth' });
    expect(stringifyMarkdown(body)).toBe('Hello.\n');
  });

  it('reports no frontmatter for a file that has none — a new document', () => {
    const { frontmatter, body } = parseDocument('# New\n');
    expect(frontmatter).toBeUndefined();
    expect(stringifyMarkdown(body)).toBe('# New\n');
  });

  it('reports no frontmatter when the block is not first', () => {
    expect(parseDocument('Text.\n\n---\nid: notion:x\n---\n').frontmatter).toBeUndefined();
  });

  it('reads url and ignores it: docsync owns it, and writes it again (ticket 27)', () => {
    const text = serializeDocument(
      { id: REF, title: 'Auth', url: 'https://www.notion.so/3cf715cbeb088035b511f0b4f06efbd5' },
      'Hello.\n',
    );
    const { frontmatter, body } = parseDocument(text);
    // Not an error, not part of the identity, and not part of the body: an
    // edited or a missing url means nothing at all to a push.
    expect(frontmatter).toEqual({ id: REF, title: 'Auth' });
    expect(stringifyMarkdown(body)).toBe('Hello.\n');
    const read = (one: string) => {
      const parsed = parseDocument(one);
      return { frontmatter: parsed.frontmatter, body: stringifyMarkdown(parsed.body) };
    };
    expect(read(text.replace(/^url: .*$/m, 'url: https://elsewhere/'))).toEqual(read(text));
    expect(read(text.replace(/^url: .*\n/m, ''))).toEqual(read(text));
  });

  it('drops keys docsync does not own', () => {
    const text = '---\nid: notion:3cf715cbeb088035b511f0b4f06efbd5\ntitle: A\nmine: 1\n---\n';
    expect(parseDocument(text).frontmatter).toEqual({ id: REF, title: 'A' });
  });

  it('treats an unparsable id as absent, keeping the title', () => {
    expect(parseDocument('---\nid: nope\ntitle: A\n---\n').frontmatter).toEqual({ title: 'A' });
  });

  it('treats a non-string title as absent', () => {
    expect(parseDocument('---\ntitle: [1, 2]\n---\n').frontmatter).toEqual({});
  });

  it('survives frontmatter that is not a YAML mapping', () => {
    expect(parseDocument('---\n- one\n---\n').frontmatter).toEqual({});
  });

  it('survives frontmatter that is not valid YAML at all', () => {
    expect(parseDocument('---\n: : :\n---\n').frontmatter).toEqual({});
  });
});
