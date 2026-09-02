import { describe, expect, it } from 'vitest';
import { AppsFileIncompleteError, AuthError, NotSignedInError } from './errors.js';

describe('NotSignedInError', () => {
  it('names the exact command to run', () => {
    expect(new NotSignedInError('gdocs').message).toContain('docsync auth gdocs');
    expect(new NotSignedInError('notion').message).toContain('docsync auth notion');
  });

  it('is an AuthError carrying the source', () => {
    const error = new NotSignedInError('notion');
    expect(error).toBeInstanceOf(AuthError);
    expect(error.name).toBe('NotSignedInError');
    expect(error.source).toBe('notion');
  });
});

describe('AppsFileIncompleteError', () => {
  it('points at the file and the entry that is still empty', () => {
    const error = new AppsFileIncompleteError('gdocs', '/home/j/.docsync/oauth-apps.yaml');
    expect(error.message).toContain('/home/j/.docsync/oauth-apps.yaml');
    expect(error.message).toContain('google');
    expect(error.name).toBe('AppsFileIncompleteError');
    expect(error.source).toBe('gdocs');
    expect(error.path).toBe('/home/j/.docsync/oauth-apps.yaml');
  });
});

describe('AuthError', () => {
  it('keeps its name and source', () => {
    const error = new AuthError('notion', 'the browser never came back');
    expect(error.name).toBe('AuthError');
    expect(error.source).toBe('notion');
    expect(error.message).toBe('the browser never came back');
  });
});
