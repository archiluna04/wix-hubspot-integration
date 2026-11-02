import { createApp } from './app.js';
import { SessionService } from './auth/session.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { FormCapture, type WixSubmission } from './forms/formCapture.js';
import { HubSpotClient } from './hubspot/client.js';
import { HubSpotOAuth } from './hubspot/oauth.js';
import { HubSpotTokenManager } from './hubspot/tokens.js';
import { Lifecycle } from './lifecycle.js';
import { errorInfo, log, setLogLevel } from './lib/logger.js';
import { createSecretStore } from './secrets/secretStore.js';
import { Store } from './store.js';
import { SyncEngine, type SyncResult } from './sync/engine.js';
import { JobQueue } from './sync/queue.js';
import { WixAppAuth, WixClient } from './wix/client.js';
import { WixWebhookVerifier } from './wix/webhooks.js';

const MAX_BACKFILL = 5000;

const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

const db = openDatabase(config.DATABASE_PATH, config.SQLITE_JOURNAL_MODE);
const store = new Store(db);
const secrets = createSecretStore(config, db);
const oauth = new HubSpotOAuth({
  clientId: config.HUBSPOT_CLIENT_ID,
  clientSecret: config.HUBSPOT_CLIENT_SECRET,
  redirectUri: `${config.APP_BASE_URL}/oauth/hubspot/callback`,
});
const tokens = new HubSpotTokenManager(secrets, oauth);
const wixAuth = new WixAppAuth(config.WIX_APP_ID, config.WIX_APP_SECRET);
const hubspotClient = (instanceId: string) => new HubSpotClient(instanceId, tokens);
const wixClient = (instanceId: string) => new WixClient(instanceId, wixAuth);

const engine = new SyncEngine({ store, wix: wixClient, hubspot: hubspotClient });
const forms = new FormCapture({ store, hubspot: hubspotClient, wix: wixClient });
const lifecycle = new Lifecycle({ store, oauth, tokens, hubspotClient, wixClient });
const queue = new JobQueue(store);

function followUp(instanceId: string, result: SyncResult): void {
  if (!result.followUp) return;
  const { system, contactId } = result.followUp;
  if (system === 'hubspot') {
    queue.enqueue(instanceId, 'hubspot_contact_changed', { hubspotContactId: contactId }, { dedupeKey: `hs:${instanceId}:${contactId}` });
  } else {
    queue.enqueue(instanceId, 'wix_contact_changed', { wixContactId: contactId }, { dedupeKey: `wix:${instanceId}:${contactId}` });
  }
}

queue
  .register('wix_contact_changed', async (job) => {
    followUp(job.instanceId, await engine.syncFromWix(job.instanceId, String(job.payload.wixContactId)));
  })
  .register('hubspot_contact_changed', async (job) => {
    followUp(job.instanceId, await engine.syncFromHubSpot(job.instanceId, String(job.payload.hubspotContactId)));
  })
  .register('wix_contact_deleted', async (job) => engine.unlinkWix(job.instanceId, String(job.payload.wixContactId)))
  .register('hubspot_contact_deleted', async (job) =>
    engine.unlinkHubSpot(job.instanceId, String(job.payload.hubspotContactId)),
  )
  .register('form_submission', async (job) => {
    const submission = job.payload.submission as WixSubmission;
    try {
      await forms.handle(job.instanceId, submission);
    } catch (err) {
      store.upsertFormEvent(job.instanceId, {
        submissionId: submission.id,
        formId: submission.formId ?? null,
        formName: null,
        status: 'failed',
        reason: String(errorInfo(err).message ?? 'error').slice(0, 200),
        hubspotContactId: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        latencyMs: null,
        submittedAt: submission.createdDate ?? null,
      });
      throw err; // retried by the queue
    }
  })
  .register('backfill_wix', async (job) => {
    const offset = Number(job.payload.offset ?? 0);
    const { ids, hasMore } = await wixClient(job.instanceId).listContactIds(offset);
    for (const id of ids) {
      queue.enqueue(job.instanceId, 'wix_contact_changed', { wixContactId: id }, { dedupeKey: `wix:${job.instanceId}:${id}` });
    }
    const next = offset + ids.length;
    if (hasMore && ids.length && next < MAX_BACKFILL) {
      queue.enqueue(job.instanceId, 'backfill_wix', { offset: next }, { delayMs: 2000 });
    }
  })
  .register('backfill_hubspot', async (job) => {
    const page = await hubspotClient(job.instanceId).listContactIds(job.payload.after as string | undefined);
    for (const id of page.ids) {
      queue.enqueue(job.instanceId, 'hubspot_contact_changed', { hubspotContactId: id }, { dedupeKey: `hs:${job.instanceId}:${id}` });
    }
    const seen = Number(job.payload.seen ?? 0) + page.ids.length;
    if (page.after && seen < MAX_BACKFILL) {
      queue.enqueue(job.instanceId, 'backfill_hubspot', { after: page.after, seen }, { delayMs: 2000 });
    }
  });

const app = createApp({
  config,
  store,
  sessions: new SessionService(config.SESSION_SECRET),
  oauth,
  lifecycle,
  queue,
  wixVerifier: new WixWebhookVerifier(config.WIX_PUBLIC_KEY),
  hubspotClient,
  wixClient,
});

queue.start();
const purgeTimer = setInterval(() => store.purge(), 60 * 60 * 1000);
purgeTimer.unref();

const server = app.listen(config.PORT, () => {
  log.info('server listening', { port: config.PORT, baseUrl: config.APP_BASE_URL, tokenStorage: secrets.kind });
});

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  server.close();
  await queue.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
