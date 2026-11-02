/**
 * Dashboard API. Every route except POST /session requires a session token, which is
 * only issued for a verified Wix instance, so a caller can only see and change its own site.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireSession } from '../auth/session.js';
import { verifyWixInstance } from '../auth/wixInstance.js';
import { HUBSPOT_SCOPES } from '../hubspot/oauth.js';
import { INTERNAL_PROPERTIES } from '../hubspot/properties.js';
import { errorInfo, log } from '../lib/logger.js';
import { rateLimit } from '../lib/rateLimit.js';
import { mappingListSchema, validateMappings, type MappingCatalog } from '../sync/mapping.js';
import { EXTENDED_PREFIX, STANDARD_WIX_FIELDS } from '../sync/wixFields.js';

const settingsSchema = z
  .object({
    syncEnabled: z.boolean(),
    conflictStrategy: z.enum(['last_updated_wins', 'hubspot_wins', 'wix_wins']),
    formCaptureEnabled: z.boolean(),
    setLifecycleStageLead: z.boolean(),
  })
  .partial();

interface FieldOption {
  key: string;
  label: string;
  group: string;
}
interface PropertyOption {
  name: string;
  label: string;
  group: string;
  type: string;
  readOnly: boolean;
}

export function dashboardApi(deps: AppDeps): Router {
  const { store, sessions, config } = deps;
  const r = Router();
  r.use(express.json({ limit: '100kb' }));
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.post('/session', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
    const instance = typeof req.body?.instance === 'string' ? req.body.instance : '';
    let instanceId: string;
    try {
      instanceId = verifyWixInstance(instance, config.WIX_APP_SECRET, {
        appId: config.WIX_APP_ID,
        maxAgeMs: 24 * 60 * 60 * 1000,
      }).instanceId;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired Wix instance' });
    }
    store.ensureInstallation(instanceId);
    void deps.lifecycle.ensureEmbeddedScript(instanceId);
    res.json({ token: await sessions.issueSession(instanceId), expiresIn: 3600 });
  });

  if (config.DEV_LOGIN_ENABLED && config.NODE_ENV !== 'production') {
    r.post('/dev-session', async (_req, res) => {
      store.ensureInstallation('dev-instance');
      res.json({ token: await sessions.issueSession('dev-instance'), expiresIn: 3600 });
    });
  }

  r.use(requireSession(sessions));
  const instanceOf = (res: express.Response) => String(res.locals.instanceId);

  // ---- connection ---------------------------------------------------------------

  r.get('/status', (_req, res) => {
    const id = instanceOf(res);
    const inst = store.ensureInstallation(id);
    res.json({
      hubspot: {
        connected: !!inst.hubspotPortalId,
        portalId: inst.hubspotPortalId,
        connectedAt: inst.hubspotConnectedAt,
        scopes: inst.hubspotScopes,
        propertiesReady: inst.hubspotPropertiesReady,
      },
      requestedScopes: HUBSPOT_SCOPES,
      settings: inst.settings,
      scriptEmbedded: inst.scriptEmbedded,
      linkedContacts: store.countLinks(id),
      queue: store.jobStats(id),
    });
  });

  r.post('/hubspot/connect', async (_req, res) => {
    const id = instanceOf(res);
    const { state, nonce, expiresAt } = await sessions.issueOAuthState(id);
    store.saveOAuthState(nonce, id, expiresAt);
    res.json({ url: deps.oauth.authorizeUrl(state) });
  });

  r.post('/hubspot/disconnect', async (_req, res) => {
    await deps.lifecycle.disconnectHubSpot(instanceOf(res));
    res.json({ ok: true });
  });

  r.post('/hubspot/repair-properties', async (_req, res) => {
    const ok = await deps.lifecycle.ensureProperties(instanceOf(res));
    res.status(ok ? 200 : 502).json({ ok });
  });

  // ---- settings -------------------------------------------------------------------

  r.put('/settings', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid settings' });
    const id = instanceOf(res);
    const inst = store.ensureInstallation(id);
    const settings = { ...inst.settings, ...parsed.data };
    store.updateSettings(id, settings);
    res.json({ settings });
  });

  // ---- field mapping -----------------------------------------------------------------

  async function loadCatalog(id: string) {
    const wix: FieldOption[] = STANDARD_WIX_FIELDS.map((f) => ({ key: f.key, label: f.label, group: 'Contact fields' }));
    let wixError: string | null = null;
    try {
      const ext = await deps.wixClient(id).listExtendedFields();
      wix.push(
        ...ext.map((f) => ({ key: `${EXTENDED_PREFIX}${f.key}`, label: f.displayName || f.key, group: 'Custom fields' })),
      );
    } catch (err) {
      wixError = 'Could not load Wix custom fields';
      log.warn('extended fields unavailable', { instanceId: id, error: errorInfo(err) });
    }

    let hubspot: PropertyOption[] = [];
    let hubspotError: string | null = null;
    if (store.getInstallation(id)?.hubspotPortalId) {
      try {
        hubspot = (await deps.hubspotClient(id).listProperties())
          .filter((p) => !p.hidden && !INTERNAL_PROPERTIES.has(p.name))
          .map((p) => ({
            name: p.name,
            label: p.label,
            group: p.groupName,
            type: p.type,
            readOnly: !!p.modificationMetadata?.readOnlyValue || !!p.calculated,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
      } catch (err) {
        hubspotError = 'Could not load HubSpot properties';
        log.warn('hubspot properties unavailable', { instanceId: id, error: errorInfo(err) });
      }
    }
    return { wix, hubspot, wixError, hubspotError };
  }

  r.get('/fields', async (_req, res) => {
    res.json(await loadCatalog(instanceOf(res)));
  });

  r.get('/mappings', (_req, res) => {
    res.json({ rows: store.getMappings(instanceOf(res)) });
  });

  r.put('/mappings', async (req, res) => {
    const parsed = mappingListSchema.safeParse(req.body?.rows);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid mapping', errors: parsed.error.issues.map((i) => i.message) });
    }
    const id = instanceOf(res);
    const catalog = await loadCatalog(id);
    const check: MappingCatalog = {};
    if (!catalog.wixError) check.wixFields = new Set(catalog.wix.map((f) => f.key));
    if (catalog.hubspot.length) {
      check.hubspotProperties = new Map(catalog.hubspot.map((p) => [p.name, { readOnly: p.readOnly }]));
    }
    const errors = validateMappings(parsed.data, check);
    if (errors.length) return res.status(422).json({ error: 'Mapping has errors', errors });
    store.saveMappings(id, parsed.data);
    log.info('mapping saved', { instanceId: id, rows: parsed.data.length });
    res.json({ rows: parsed.data });
  });

  // ---- activity + manual sync ----------------------------------------------------------

  r.get('/activity', (_req, res) => {
    const id = instanceOf(res);
    res.json({
      syncEvents: store.listSyncEvents(id, 50),
      formEvents: store.listFormEvents(id, 50),
      queue: store.jobStats(id),
      linkedContacts: store.countLinks(id),
    });
  });

  r.post('/sync/full', (req, res) => {
    const id = instanceOf(res);
    if (!store.getInstallation(id)?.hubspotPortalId) return res.status(409).json({ error: 'Connect HubSpot first' });
    const system = req.body?.system === 'hubspot' ? 'hubspot' : req.body?.system === 'wix' ? 'wix' : 'both';
    if (system !== 'hubspot') deps.queue.enqueue(id, 'backfill_wix', { offset: 0 }, { dedupeKey: `backfill:wix:${id}` });
    if (system !== 'wix') deps.queue.enqueue(id, 'backfill_hubspot', {}, { dedupeKey: `backfill:hubspot:${id}` });
    res.status(202).json({ ok: true });
  });

  return r;
}
