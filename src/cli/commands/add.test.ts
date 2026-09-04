import { describe, expect, it } from 'vitest';
import { looksLikeSource, parseSpec, splitSpec } from './add.js';

const NID = '391715cbeb0880969354d4d54fdec7a4';
const GID = '1AbCdEfGhIjKlMnOpQrStUvWxYz-_012';

describe('splitSpec', () => {
  it('splits a ref from its alias at the "="', () => {
    expect(splitSpec(`notion:${NID}=Specs/`)).toEqual({ text: `notion:${NID}`, alias: 'Specs/' });
    expect(splitSpec(`notion:${NID}`)).toEqual({ text: `notion:${NID}` });
  });

  it('leaves a URL its own "="', () => {
    const view = `https://www.notion.so/Specs-${NID}?v=aaaaaaaabbbbccccddddeeeeeeeeeeee`;
    expect(splitSpec(view)).toEqual({ text: view });
    const open = `https://drive.google.com/open?id=${GID}&usp=sharing`;
    expect(splitSpec(open)).toEqual({ text: open });
    const heading = `https://docs.google.com/document/d/${GID}/edit#heading=h.abc`;
    expect(splitSpec(heading)).toEqual({ text: heading });
  });

  it('finds the alias after a URL with a query', () => {
    expect(splitSpec(`https://www.notion.so/Specs-${NID}?pvs=4=process`)).toEqual({
      text: `https://www.notion.so/Specs-${NID}?pvs=4`,
      alias: 'process',
    });
    expect(
      splitSpec(`https://app.notion.com/p/salsita/Configurator-Project-Timeline-${NID}=process`),
    ).toEqual({
      text: `https://app.notion.com/p/salsita/Configurator-Project-Timeline-${NID}`,
      alias: 'process',
    });
  });
});

describe('parseSpec', () => {
  it('resolves the app.notion.com URL with an alias', () => {
    const spec = parseSpec(
      `https://app.notion.com/p/salsita/Configurator-Project-Timeline-${NID}=process`,
    );
    expect(spec.ref).toEqual({ source: 'notion', id: NID });
    expect(spec.alias).toBe('process');
  });

  it('refuses an empty alias and a non-ref', () => {
    expect(() => parseSpec(`notion:${NID}=`)).toThrow(/needs a path/);
    expect(() => parseSpec('my-docs')).toThrow(/Not a source ref/);
  });
});

describe('looksLikeSource', () => {
  it('tells a directory from a ref with a query and an alias', () => {
    expect(looksLikeSource('my-docs')).toBe(false);
    expect(looksLikeSource(`https://www.notion.so/Specs-${NID}?pvs=4=Specs/`)).toBe(true);
  });
});
