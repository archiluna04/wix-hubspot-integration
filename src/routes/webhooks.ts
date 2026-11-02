/**
 * Inbound webhooks. Both endpoints verify signatures, enqueue work and respond fast;
 * all API calls happen in the job queue.
 */
import express, { Router } from 'express';
import type { AppDeps } from '../app.js';
import { parseHubSpotEvents, verifyHubSpotSignatureV3 } from '../hubspot/webhooks.js';
import { INTERNAL_PROPERTIES } from '../hubspot/properties.js';
import { errorInfo, log } from '../lib/logger.js';
import { entityFromEvent } from '../wix/webhooks.js';

/** Debounce windows: coalesce bursts of events for the same contact into one sync. */
const WIX_DEBOUNCE_MS = 1000;
const HUBSPOT_DEBOUNCE_MS = 1500;

export function webhookRoutes(deps: AppDeps): Router {
  const { store, queue, config } = deps;
  const r = Router();

  // ---- Wix: contacts + forms + app lifecycle --------------------------------------
  r.post('/wix', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = await deps.wixVerifier.verify(String(req.body ?? ''));
    } catch (err) {
      log.warn('rejected wix webhook', { error: errorInfo(err) });
      return res.status(401).send('invalid signature');
    }
    const { eventType, instanceId, data, identity } = event;
    const { entityId, entity } = entityFromEvent(data);

    switch (eventType) {
      case 'AppInstalled':
        store.ensureInstallation(instanceId);
        void deps.lifecycle.ensureEmbeddedScript(instanceId);
        break;
      case 'AppRemoved':
        await deps.lifecycle.uninstall(instanceId);
        break;
      case 'wix.contacts.v4.contact_created':
      case 'wix.contacts.v4.contact_updated':
        if (!entityId || !store.getInstallation(instanceId)) break;
        // Origin tag: changes made by this app are the echo of our own sync writes.
        if (identity?.identityType === 'APP' && identity.appId === config.WIX_APP_ID) {
          store.addSyncEvent(instanceId, {
            syncId: null,
            source: 'wix',
            wixContactId: entityId,
            hubspotContactId: null,
            action: 'skipped',
            reason: 'origin_is_this_app',
            fields: [],
          });
          break;
        }
        queue.enqueue(
          instanceId,
          'wix_contact_changed',
          { wixContactId: entityId },
          { dedupeKey: `wix:${instanceId}:${entityId}`, delayMs: WIX_DEBOUNCE_MS },
        );
        break;
      case 'wix.contacts.v4.contact_deleted':
        if (entityId) queue.enqueue(instanceId, 'wix_contact_deleted', { wixContactId: entityId });
        break;
      case 'wix.forms.v4.submission_created':
        if (!entity?.id || !store.getInstallation(instanceId)) break;
        queue.enqueue(
          instanceId,
          'form_submission',
          { submission: entity },
          { dedupeKey: `form:${instanceId}:${entity.id}` },
        );
        break;
      default:
        log.debug('ignored wix event', { eventType });
    }
    res.status(200).send('ok');
  });

  // ---- HubSpot: contact.creation / contact.propertyChange / contact.deletion -----------
  r.post('/hubspot', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    const rawBody = String(req.body ?? '');
    const valid = verifyHubSpotSignatureV3({
      clientSecret: config.HUBSPOT_CLIENT_SECRET,
      method: req.method,
      url: `${config.APP_BASE_URL}${req.originalUrl}`,
      rawBody,
      signature: req.get('x-hubspot-signature-v3'),
      timestamp: req.get('x-hubspot-request-timestamp'),
    });
    if (!valid) {
      log.warn('rejected hubspot webhook: bad signature');
      return res.status(401).send('invalid signature');
    }

    let events;
    try {
      events = parseHubSpotEvents(rawBody);
    } catch {
      return res.status(400).send('invalid body');
    }

    for (const e of events) {
      if (e.propertyName && INTERNAL_PROPERTIES.has(e.propertyName)) continue; // our own bookkeeping
      const contactId = String(e.objectId);
      for (const inst of store.getInstallationsByPortal(String(e.portalId))) {
        if (e.subscriptionType === 'contact.deletion') {
          queue.enqueue(inst.instanceId, 'hubspot_contact_deleted', { hubspotContactId: contactId });
        } else if (e.subscriptionType === 'contact.creation' || e.subscriptionType === 'contact.propertyChange') {
          queue.enqueue(
            inst.instanceId,
            'hubspot_contact_changed',
            { hubspotContactId: contactId },
            { dedupeKey: `hs:${inst.instanceId}:${contactId}`, delayMs: HUBSPOT_DEBOUNCE_MS },
          );
        }
      }
    }
    res.status(200).send('ok');
  });

  return r;
}
