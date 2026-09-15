/**
 * One authenticated request to a Google API, retried the way both adapters
 * retry (ticket 07, ticket 38).
 *
 * The Drive adapter grew this first; the calendar adapter needs the same
 * policy — bearer token, retry a throttle or a backend failure, and an error
 * carrying Google's own message — against a third endpoint. It lives here
 * rather than in `gdrive/` so that neither adapter has to import the other,
 * and it knows nothing about either API: a URL in, a response out.
 */

/** How many times a throttled or failed request is retried. */
const MAX_RETRIES = 3;

/** Backoff used when Google does not say how long to wait. */
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** What a failed request throws: the status, so a caller can tell 403 apart. */
export class GoogleApiError extends Error {
  readonly status: number;
  /** Google's own `error.message`, empty when the body did not carry one. */
  readonly detail: string;

  constructor(status: number, url: string, detail: string) {
    super(`Google API ${status} on ${url}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'GoogleApiError';
    this.status = status;
    this.detail = detail;
  }
}

export interface GoogleHttpOptions {
  /** Injected in tests. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected so the retry tests do not wait. Default: real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** What one authenticated caller offers: a response, JSON, or bytes. */
export interface GoogleHttp {
  call(url: string, init?: RequestInit): Promise<Response>;
  json<T>(url: string, init?: RequestInit): Promise<T>;
  bytes(url: string): Promise<Uint8Array>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A caller that signs every request with `accessToken`. The token is one that
 * is good now; `CredentialProvider` renews it, and nothing here knows how.
 */
export function createGoogleHttp(accessToken: string, options: GoogleHttpOptions = {}): GoogleHttp {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) },
      });
      if (response.ok) return response;
      if (attempt >= MAX_RETRIES || !isRetryable(response.status))
        throw await failure(url, response);
      await sleep(retryAfterMs(response) ?? RETRY_DELAYS_MS[attempt] ?? 4000);
    }
  }

  return {
    call,
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      return (await (await call(url, init)).json()) as T;
    },
    async bytes(url: string): Promise<Uint8Array> {
      return new Uint8Array(await (await call(url)).arrayBuffer());
    },
  };
}

/** Throttling and Google's own failures are worth another try; nothing else. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** `Retry-After` in milliseconds, when the response carries a readable one. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** The error a failed request becomes: the status, the URL and Google's message. */
async function failure(url: string, response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    // A non-JSON body (an HTML error page, or bytes) says nothing more than the
    // status already does.
  }
  return new GoogleApiError(response.status, url, detail);
}
