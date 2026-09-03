import { describe, expect, it } from 'vitest';
import { similarity, tokens } from './similarity.js';

describe('tokens', () => {
  it('splits on word boundaries, keeping whitespace and punctuation', () => {
    expect(tokens('one two.')).toEqual(['one', ' ', 'two', '.']);
  });

  it('keeps an emoji and a surrogate pair whole', () => {
    expect(tokens('a 👨‍👩‍👦 b')).toContain('👨‍👩‍👦');
  });

  it('does not glue a run of CJK into one token', () => {
    expect(tokens('中文字符').length).toBeGreaterThan(1);
  });
});

describe('similarity', () => {
  it('is 1 for the same text and for two empty texts', () => {
    expect(similarity('hello there', 'hello there')).toBe(1);
    expect(similarity('', '')).toBe(1);
  });

  it('is 0 when nothing is shared', () => {
    expect(similarity('alpha', 'beta')).toBe(0);
  });

  it('is above a half for a sentence with one word replaced', () => {
    expect(similarity('the quick brown fox', 'the quick red fox')).toBeGreaterThan(0.5);
  });

  it('is below a half for a sentence rewritten', () => {
    expect(
      similarity('the quick brown fox', 'entirely different words about nothing at all'),
    ).toBeLessThan(0.5);
  });

  it('is measured against the longer text, so a short prefix is not similar', () => {
    expect(similarity('the', 'the quick brown fox jumps over the lazy dog')).toBeLessThan(0.5);
  });
});
