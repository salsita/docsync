import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPS_FILE_TEMPLATE,
  appsFilePath,
  defaultRunEditor,
  editorCommand,
  loadOAuthApp,
} from './apps-file.js';
import { AppsFileIncompleteError, AuthError } from './errors.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docsync-apps-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';

function filled(key: string): string {
  return `${key}:\n  client_id: "cid-${key}"\n  client_secret: "csec-${key}"\n`;
}

describe('appsFilePath', () => {
  it('is ~/.docsync/oauth-apps.yaml', () => {
    expect(appsFilePath('/home/j')).toBe(join('/home/j', '.docsync', 'oauth-apps.yaml'));
  });
});

describe('loadOAuthApp', () => {
  it('writes the template, opens the editor, and re-reads what was typed', async () => {
    const path = appsFilePath(home);
    const runEditor = vi.fn((p: string) => {
      expect(readFileSync(p, 'utf8')).toBe(APPS_FILE_TEMPLATE);
      writeFileSync(p, `${readFileSync(p, 'utf8')}`.replace('client_id: ""', 'client_id: "abc"'));
      writeFileSync(
        p,
        readFileSync(p, 'utf8').replace('client_secret: ""', 'client_secret: "shh"'),
      );
    });

    const app = await loadOAuthApp('gdocs', { home, runEditor });

    expect(runEditor).toHaveBeenCalledWith(path);
    expect(app).toEqual({ clientId: 'abc', clientSecret: 'shh' });
  });

  it('keeps the comments in the file it wrote', async () => {
    const path = appsFilePath(home);
    await loadOAuthApp('gdocs', {
      home,
      runEditor: (p) =>
        writeFileSync(
          p,
          readFileSync(p, 'utf8')
            .replace('client_id: ""', 'client_id: "abc"')
            .replace('client_secret: ""', 'client_secret: "shh"'),
        ),
    }).catch(() => undefined);

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# OAuth apps used by docsync.');
    expect(text).toContain('http://localhost:27183/callback');
    expect(text).toContain('http://localhost:27184/callback');
    expect(text).toContain('# notion.so/profile/integrations');
  });

  it.runIf(posix)('creates the directory 0700 and the file 0600', async () => {
    await loadOAuthApp('notion', {
      home,
      runEditor: (p) => writeFileSync(p, filled('notion')),
    });

    expect(statSync(join(home, '.docsync')).mode & 0o777).toBe(0o700);
    expect(statSync(appsFilePath(home)).mode & 0o777).toBe(0o600);
  });

  it('does not open the editor when the entry is already filled', async () => {
    await mkdir(join(home, '.docsync'), { recursive: true });
    await writeFile(appsFilePath(home), `${filled('google')}${filled('notion')}`);
    const runEditor = vi.fn();

    expect(await loadOAuthApp('gdocs', { home, runEditor })).toEqual({
      clientId: 'cid-google',
      clientSecret: 'csec-google',
    });
    expect(await loadOAuthApp('notion', { home, runEditor })).toEqual({
      clientId: 'cid-notion',
      clientSecret: 'csec-notion',
    });
    expect(runEditor).not.toHaveBeenCalled();
  });

  it('does not touch a file that already exists', async () => {
    await mkdir(join(home, '.docsync'), { recursive: true });
    await writeFile(appsFilePath(home), `# mine\n${filled('notion')}`);

    await loadOAuthApp('notion', { home, runEditor: () => undefined });

    expect(readFileSync(appsFilePath(home), 'utf8')).toBe(`# mine\n${filled('notion')}`);
  });

  it('fails with AppsFileIncompleteError when the entry is still empty after editing', async () => {
    const runEditor = vi.fn();

    await expect(loadOAuthApp('notion', { home, runEditor })).rejects.toThrow(
      AppsFileIncompleteError,
    );
    expect(runEditor).toHaveBeenCalledOnce();
  });

  it('treats a whitespace-only value as empty', async () => {
    await mkdir(join(home, '.docsync'), { recursive: true });
    await writeFile(appsFilePath(home), 'notion:\n  client_id: "  "\n  client_secret: "x"\n');

    await expect(loadOAuthApp('notion', { home, runEditor: () => undefined })).rejects.toThrow(
      AppsFileIncompleteError,
    );
  });

  it('treats an entry of the wrong shape as empty', async () => {
    await mkdir(join(home, '.docsync'), { recursive: true });
    await writeFile(appsFilePath(home), 'notion: nope\n');

    await expect(loadOAuthApp('notion', { home, runEditor: () => undefined })).rejects.toThrow(
      AppsFileIncompleteError,
    );
  });

  it('reports a YAML syntax error instead of silently rewriting the file', async () => {
    await mkdir(join(home, '.docsync'), { recursive: true });
    await writeFile(appsFilePath(home), 'notion:\n  client_id: "unterminated\n');

    const error = await loadOAuthApp('notion', { home, runEditor: () => undefined }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toContain('oauth-apps.yaml');
    expect(error.message).not.toContain('unterminated');
  });

  it('accepts an empty file', async () => {
    await mkdir(join(home, '.docsync'), { recursive: true });
    await writeFile(appsFilePath(home), '');

    await expect(loadOAuthApp('notion', { home, runEditor: () => undefined })).rejects.toThrow(
      AppsFileIncompleteError,
    );
  });
});

describe('editorCommand', () => {
  it('uses $EDITOR, keeping its arguments', () => {
    expect(editorCommand({ EDITOR: 'code -w' }, 'darwin')).toEqual({
      command: 'code',
      args: ['-w'],
    });
  });

  it('falls back to vi off Windows and notepad on it', () => {
    expect(editorCommand({}, 'darwin')).toEqual({ command: 'vi', args: [] });
    expect(editorCommand({ EDITOR: '   ' }, 'linux')).toEqual({ command: 'vi', args: [] });
    expect(editorCommand({}, 'win32')).toEqual({ command: 'notepad', args: [] });
  });
});

describe('defaultRunEditor', () => {
  it.runIf(posix)('runs the editor and waits for it', () => {
    const path = join(home, 'scratch.yaml');
    writeFileSync(path, 'x');
    expect(() => defaultRunEditor(path, { EDITOR: 'true' })).not.toThrow();
  });

  it.runIf(posix)('reports an editor that cannot be started', () => {
    expect(() =>
      defaultRunEditor(join(home, 'scratch.yaml'), { EDITOR: 'docsync-no-such-editor' }),
    ).toThrow(/docsync-no-such-editor/);
  });

  it.runIf(posix)('reports an editor that exits non-zero', () => {
    expect(() => defaultRunEditor(join(home, 'scratch.yaml'), { EDITOR: 'false' })).toThrow(
      /exited with 1/,
    );
  });
});

describe('loadOAuthApp without a prompt', () => {
  it('fails instead of opening an editor', async () => {
    const runEditor = vi.fn();

    await expect(loadOAuthApp('notion', { home, runEditor }, false)).rejects.toThrow(
      AppsFileIncompleteError,
    );
    expect(runEditor).not.toHaveBeenCalled();
  });
});
