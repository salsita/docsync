import { describe, expect, it } from 'vitest';
import * as manifest from './index.js';

describe('the manifest module', () => {
  it('re-exports every function ticket 02 names', () => {
    expect(Object.keys(manifest).sort()).toEqual([
      'assignNames',
      'fileNameFor',
      'isDirectoryPath',
      'isIgnored',
      'parseManifest',
      'resolveAlias',
      'serializeManifest',
      'territoryOf',
      'validatePath',
      'validateRoots',
    ]);
  });
});
