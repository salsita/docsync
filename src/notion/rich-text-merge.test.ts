import type { Paragraph, PhrasingContent } from 'mdast';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../markdown.js';
import type { RawObject } from './api.js';
import { mergeRichText } from './rich-text-merge.js';
import type { RichText } from './to-markdown.js';

/** The phrasing content of a one-paragraph Markdown snippet. */
function phrasing(markdown: string): PhrasingContent[] {
  const first = parseMarkdown(markdown).children[0] as Paragraph | undefined;
  return first?.children ?? [];
}

/** A live text run, as Notion answers one. */
function run(content: string, annotations: Record<string, unknown> = {}): RichText {
  return {
    type: 'text',
    text: { content, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
      ...annotations,
    },
    plain_text: content,
    href: null,
  };
}

/** What a merge produced, as `text` plus the annotations that are not default. */
function shape(runs: readonly RawObject[]): unknown[] {
  return runs.map((one) => {
    const annotations = (one.annotations ?? {}) as Record<string, unknown>;
    const set = Object.entries(annotations).filter(
      ([key, value]) => value !== false && !(key === 'color' && value === 'default'),
    );
    const text = one.text as { content?: string; link?: { url: string } | null } | undefined;
    return {
      text: text?.content ?? `<${String(one.type)}>`,
      ...Object.fromEntries(set),
      ...(text?.link == null ? {} : { link: text.link.url }),
    };
  });
}

describe('mergeRichText', () => {
  it('leaves a coloured run alone when the edit is elsewhere in the block', () => {
    const live = [run('The '), run('red part', { color: 'red' }), run(' and the tail.')];
    const merged = mergeRichText(
      live,
      phrasing('The <span data-color="red">red part</span> and the tail.'),
      phrasing('The <span data-color="red">red part</span> and the end.'),
    );
    // The kept text and the inserted text agree on everything, so they are one
    // run again: what goes back is what Notion would itself have stored.
    expect(shape(merged)).toEqual([
      { text: 'The ' },
      { text: 'red part', color: 'red' },
      { text: ' and the end.' },
    ]);
  });

  it('gives inserted text the formatting of the text before it', () => {
    const live = [run('a red sentence here', { color: 'red' })];
    const merged = mergeRichText(
      live,
      phrasing('<span data-color="red">a red sentence here</span>'),
      phrasing('<span data-color="red">a red and long sentence here</span>'),
    );
    expect(merged.every((one) => (one.annotations as RawObject).color === 'red')).toBe(true);
    expect(merged.map((one) => (one.text as RawObject).content).join('')).toBe(
      'a red and long sentence here',
    );
  });

  it('takes the emphasis an inserted word carries in the new Markdown', () => {
    const live = [run('one two three')];
    const merged = mergeRichText(
      live,
      phrasing('one two three'),
      phrasing('one **bold** two three'),
    );
    expect(shape(merged)).toEqual([
      { text: 'one ' },
      { text: 'bold', bold: true },
      { text: ' two three' },
    ]);
  });

  it('splits a red run when bold is added to part of it', () => {
    const live = [run('the whole thing is red', { color: 'red' })];
    const merged = mergeRichText(
      live,
      phrasing('<span data-color="red">the whole thing is red</span>'),
      phrasing('<span data-color="red">the **whole** thing is red</span>'),
    );
    expect(shape(merged)).toEqual([
      { text: 'the ', color: 'red' },
      { text: 'whole', bold: true, color: 'red' },
      { text: ' thing is red', color: 'red' },
    ]);
  });

  it('sets only the attribute that changed, leaving the rest of the run', () => {
    const live = [run('a link here', { color: 'blue', italic: true })];
    const merged = mergeRichText(
      live,
      phrasing('<span data-color="blue">_a link here_</span>'),
      phrasing('<span data-color="blue">_a **link** here_</span>'),
    );
    expect(shape(merged)).toEqual([
      { text: 'a ', italic: true, color: 'blue' },
      { text: 'link', bold: true, italic: true, color: 'blue' },
      { text: ' here', italic: true, color: 'blue' },
    ]);
  });

  it('keeps a mention the edit did not touch', () => {
    const live = [
      run('hi '),
      {
        type: 'mention',
        mention: { type: 'user', user: { object: 'user', id: 'u1' } },
        annotations: run('').annotations,
        plain_text: '@Ada',
        href: null,
      } as RichText,
      run(' and the rest here'),
    ];
    const merged = mergeRichText(
      live,
      phrasing('hi [@Ada](notion://user/u1) and the rest here'),
      phrasing('hi [@Ada](notion://user/u1) and the end here'),
    );
    expect(merged[1]?.type).toBe('mention');
    expect(merged.map((one) => one.plain_text ?? (one.text as RawObject).content).join('')).toBe(
      'hi @Ada and the end here',
    );
  });

  it('replaces a mention an edit runs across', () => {
    const live = [
      run('hi '),
      {
        type: 'mention',
        mention: { type: 'user', user: { object: 'user', id: 'u1' } },
        annotations: run('').annotations,
        plain_text: '@Ada',
        href: null,
      } as RichText,
      run(' there'),
    ];
    const merged = mergeRichText(
      live,
      phrasing('hi [@Ada](notion://user/u1) there'),
      phrasing('hi @Adam there'),
    );
    expect(merged.some((one) => one.type === 'mention')).toBe(false);
    expect(merged.map((one) => (one.text as RawObject).content).join('')).toBe('hi @Adam there');
  });

  it('writes the new text whole when the live block is not the base', () => {
    const merged = mergeRichText(
      [run('something else entirely')],
      phrasing('base'),
      phrasing('new'),
    );
    expect(shape(merged)).toEqual([{ text: 'new' }]);
  });

  it('answers the live runs unchanged when nothing changed', () => {
    const live = [run('unchanged '), run('text', { bold: true })];
    expect(
      shape(mergeRichText(live, phrasing('unchanged **text**'), phrasing('unchanged **text**'))),
    ).toEqual([{ text: 'unchanged ' }, { text: 'text', bold: true }]);
  });
});
