import { Router } from 'express';
import { PUBLIC_DIR, type AppDeps } from '../app.js';
import { errorInfo, log } from '../lib/logger.js';

/**
 * HubSpot OAuth callback. Runs in the popup opened from the dashboard; tokens are exchanged
 * and stored server-side, and the browser only ever sees a success/error redirect.
 */
export function oauthRoutes(deps: AppDeps): Router {
  const r = Router();

  const done = (status: 'success' | 'error', message?: string) =>
    `/oauth/complete?status=${status}${message ? `&message=${encodeURIComponent(message)}` : ''}`;

  r.get('/hubspot/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (typeof error === 'string') return res.redirect(done('error', 'HubSpot authorization was cancelled.'));
    if (typeof code !== 'string' || typeof state !== 'string') return res.redirect(done('error', 'Missing parameters.'));

    let instanceId: string;
    try {
      const verified = await deps.sessions.verifyOAuthState(state);
      const owner = deps.store.consumeOAuthState(verified.nonce);
      if (owner !== verified.instanceId) throw new Error('state already used or expired');
      instanceId = verified.instanceId;
    } catch (err) {
      log.warn('rejected hubspot oauth state', { error: errorInfo(err) });
      return res.redirect(done('error', 'This connection link expired. Please try again.'));
    }

    try {
      await deps.lifecycle.completeHubSpotConnect(instanceId, code);
      res.redirect(done('success'));
    } catch (err) {
      log.error('hubspot oauth exchange failed', { instanceId, error: errorInfo(err) });
      res.redirect(done('error', 'Could not complete the HubSpot connection.'));
    }
  });

  r.get('/complete', (_req, res) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'");
    res.sendFile('oauth-complete.html', { root: PUBLIC_DIR });
  });

  return r;
}
