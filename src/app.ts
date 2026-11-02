import express, { type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import type { SessionService } from './auth/session.js';
import type { AppConfig } from './config.js';
import type { HubSpotClient } from './hubspot/client.js';
import type { HubSpotOAuth } from './hubspot/oauth.js';
import type { Lifecycle } from './lifecycle.js';
import { errorInfo, log } from './lib/logger.js';
import { dashboardApi } from './routes/dashboardApi.js';
import { oauthRoutes } from './routes/oauth.js';
import { publicRoutes } from './routes/public.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { Store } from './store.js';
import type { JobQueue } from './sync/queue.js';
import type { WixClient } from './wix/client.js';
import type { WixWebhookVerifier } from './wix/webhooks.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  sessions: SessionService;
  oauth: HubSpotOAuth;
  lifecycle: Lifecycle;
  queue: JobQueue;
  wixVerifier: WixWebhookVerifier;
  hubspotClient(instanceId: string): HubSpotClient;
  wixClient(instanceId: string): WixClient;
}

export const PUBLIC_DIR = resolve(process.cwd(), 'public');

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Webhooks need the raw body for signature verification: mount before any JSON parser.
  app.use('/webhooks', webhookRoutes(deps));
  app.use('/api', dashboardApi(deps));
  app.use('/oauth', oauthRoutes(deps));
  app.use(publicRoutes(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    log.error('request failed', { method: req.method, path: req.path, error: errorInfo(err) });
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal error' });
  };
  app.use(onError);
  return app;
}
