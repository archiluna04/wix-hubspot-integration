/**
 * Minimal JSON HTTP client with timeouts and retry/backoff for 429 + 5xx + network errors.
 * Error messages contain only method, host and path (query strings and long path
 * segments are dropped), so they are safe to log.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Parsed error body. May contain PII: use for control flow only, never log it. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body. */
  body?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 8000) + Math.floor(Math.random() * 200);

export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (seg.length > 32 ? ':redacted' : seg))
      .join('/');
    return `${u.host}${path}`;
  } catch {
    return '[invalid-url]';
  }
}

export async function requestJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const retries = opts.retries ?? 3;
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    } catch {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new HttpError(0, `${method} ${safeUrl(url)} failed: network error`);
    }

    if (res.ok) {
      const text = res.status === 204 ? '' : await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    if (RETRYABLE.has(res.status) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : backoff(attempt));
      continue;
    }

    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = undefined;
    }
    throw new HttpError(res.status, `${method} ${safeUrl(url)} failed with ${res.status}`, details);
  }
}

export function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === false) return false;
  if (!(err instanceof HttpError)) return true;
  return err.status === 0 || err.status === 409 || err.status === 412 || RETRYABLE.has(err.status);
}
