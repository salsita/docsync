import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { version } from './version.js';

describe('version', () => {
  it('matches the version field of package.json', () => {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const declared = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
    expect(version).toBe(declared.version);
  });

  it('is a non-empty semver-shaped string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
