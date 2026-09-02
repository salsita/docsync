import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  version?: string;
}

function readVersion(): string {
  // Resolved relative to this module, so it works from src/ and from dist/ alike:
  // both sit one directory below the package root.
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  if (!parsed.version) {
    throw new Error(`No "version" field in ${packageJsonPath}`);
  }
  return parsed.version;
}

/** The version of the installed docsync package. */
export const version: string = readVersion();
