/**
 * The process's own output streams, as writers that treat a closed reader as
 * the end of the conversation rather than as a failure.
 *
 * `docsync status | head` closes the read end of stdout as soon as `head` has
 * the lines it wanted, and everything docsync still had to say then raises
 * EPIPE. Without an 'error' listener that is an unhandled event: the process
 * dies with a stack trace and a non-zero code over output the user
 * deliberately truncated. The helper has needed this since ticket 22
 * (`createLineWriter`, which is this writer plus a newline); the front end
 * needs the same, one text chunk at a time, because a command writes its own
 * newlines.
 *
 * Writes are queued rather than awaited so that a caller stays synchronous;
 * `flush` is how a process that is about to exit waits for the ones still in
 * flight, since an exit with a write outstanding truncates the output.
 */

/** A stream as a writer that goes quiet instead of throwing, and can be waited on. */
export interface StreamWriter {
  /** Writes text verbatim. Adds nothing: the caller's newlines are the caller's. */
  write(text: string): void;
  /** Whether the far end has closed: every write since is a no-op. */
  broken(): boolean;
  /** Resolves once every write handed over so far has been answered. */
  flush(): Promise<void>;
}

export function createStreamWriter(stream: NodeJS.WritableStream): StreamWriter {
  let broken = false;
  const pending = new Set<Promise<void>>();
  stream.on('error', () => {
    broken = true;
  });
  return {
    write(text) {
      if (broken) return;
      const written = new Promise<void>((done) => {
        try {
          stream.write(text, (error) => {
            if (error) broken = true;
            done();
          });
        } catch {
          // A stream destroyed under us throws where a live one would have
          // called back with the error.
          broken = true;
          done();
        }
      });
      pending.add(written);
      void written.then(() => pending.delete(written));
    },
    broken: () => broken,
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
