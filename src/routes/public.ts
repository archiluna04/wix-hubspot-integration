/**
 * Public routes: the dashboard page (framed by Wix), the site attribution script and its
 * beacon endpoint. The beacon is unauthenticated by nature (it runs on the public site),
 * so it is rate limited, size limited, schema validated and stores no raw PII.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { PUBLIC_DIR } from '../app.js';
import { emailHash } from '../forms/formCapture.js';
import { rateLimit } from '../lib/rateLimit.js';

const short = z.string().max(500).optional();
const touchSchema = z
  .object({
    utm_source: short,
    utm_medium: short,
    utm_campaign: short,
    utm_term: short,
    utm_content: short,
    landing_page: short,
    referrer: short,
    ts: z.number().optional(),
  })
  .partial()
  .nullable()
  .optional();

const beaconSchema = z.object({
  siteKey: z.string().min(10).max(64),
  email: z.string().email().max(254),
  first: touchSchema,
  last: touchSchema,
  pageUrl: short,
  referrer: short,
});

/** Keeps origin + path only: query strings can carry PII. */
function stripQuery(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  'frame-ancestors https://*.wix.com https://*.wixapps.net https://*.editorx.com',
].join('; ');

export function publicRoutes(deps: AppDeps): Router {
  const { store } = deps;
  const r = Router();

  r.get(['/', '/dashboard'], (_req, res) => {
    res.set('Content-Security-Policy', DASHBOARD_CSP);
    res.set('Cache-Control', 'no-store');
    res.sendFile('dashboard.html', { root: PUBLIC_DIR });
  });

  r.use('/assets', express.static(`${PUBLIC_DIR}/assets`, { maxAge: '1h' }));

  r.use(
    '/embed',
    (_req, res, next) => {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    },
    express.static(`${PUBLIC_DIR}/embed`, { maxAge: '1h' }),
  );

  const cors: express.RequestHandler = (_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    next();
  };
  r.options('/public/attribution', cors, (_req, res) => {
    res.sendStatus(204);
  });
  r.post(
    '/public/attribution',
    cors,
    rateLimit({ windowMs: 60_000, max: 30 }),
    express.text({ type: '*/*', limit: '8kb' }),
    (req, res) => {
      let body: unknown;
      try {
        body = JSON.parse(String(req.body ?? ''));
      } catch {
        return res.sendStatus(400);
      }
      const parsed = beaconSchema.safeParse(body);
      if (!parsed.success) return res.sendStatus(400);
      const inst = store.getInstallationBySiteKey(parsed.data.siteKey);
      if (!inst) return res.sendStatus(204); // don't reveal which site keys exist

      const clean = (t: z.infer<typeof touchSchema>) =>
        t ? { ...t, landing_page: stripQuery(t.landing_page) ?? undefined, referrer: stripQuery(t.referrer) ?? undefined } : null;
      store.addAttributionTouch(inst.instanceId, {
        emailHash: emailHash(inst.siteKey, parsed.data.email),
        first: clean(parsed.data.first),
        last: clean(parsed.data.last),
        pageUrl: stripQuery(parsed.data.pageUrl),
        referrer: stripQuery(parsed.data.referrer),
      });
      res.sendStatus(204);
    },
  );

  return r;
}
