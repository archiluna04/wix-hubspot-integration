/**
 * Structured JSON logger that never emits tokens or PII.
 * - Values under sensitive keys are replaced with "[redacted]".
 * - Strings are scrubbed for email addresses, bearer tokens and long opaque tokens.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : 'info';

export function setLogLevel(level: Level): void {
  minLevel = level;
}

const SENSITIVE_KEY =
  /(token|secret|password|authorization|cookie|signature|^code$|email|phone|firstname|lastname|first_name|last_name|^name$|address|birthdate|^instance$|payload|properties|submissions)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_\-.]{40,}\b/g;

export function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(BEARER, 'Bearer [redacted]').replace(LONG_TOKEN, '[redacted]');
}

export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    // Upstream error codes (e.g. HubSpot's "BAD_REDIRECT_URI") are enum-like and safe to log; the rest of the body is not.
    const details = (err as { details?: { status?: unknown; category?: unknown } }).details;
    const raw = details && typeof details === 'object' ? (details.category ?? details.status) : undefined;
    // Not logged under "code": that key is redacted because it usually holds an OAuth authorization code.
    const reason = typeof raw === 'string' && /^[A-Z_]{3,40}$/.test(raw) ? raw : undefined;
    return {
      type: err.name,
      message: scrub(err.message),
      ...(typeof status === 'number' ? { status } : {}),
      ...(reason ? { reason } : {}),
    };
  }
  return { message: scrub(String(err)) };
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return scrub(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return errorInfo(value);
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: scrub(msg),
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  });
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
