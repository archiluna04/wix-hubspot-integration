import { errorInfo, log } from '../lib/logger.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { HubSpotOAuth, HubSpotTokenSet } from './oauth.js';

export class NotConnectedError extends Error {
  readonly retryable = false;
  constructor() {
    super('HubSpot is not connected');
    this.name = 'NotConnectedError';
  }
}

const REFRESH_MARGIN_MS = 5 * 60_000;
const CACHE_TTL_MS = 60_000;
const secretName = (instanceId: string) => `hubspot-oauth-${instanceId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/**
 * Loads, refreshes and stores HubSpot tokens. Tokens live only in the secret store and
 * server memory; they are never sent to the browser or logged.
 */
export class HubSpotTokenManager {
  private cache = new Map<string, { set: HubSpotTokenSet; until: number }>();
  private refreshing = new Map<string, Promise<HubSpotTokenSet>>();

  constructor(
    private readonly secrets: SecretStore,
    private readonly oauth: HubSpotOAuth,
  ) {}

  async save(instanceId: string, set: HubSpotTokenSet): Promise<void> {
    await this.secrets.put(secretName(instanceId), JSON.stringify(set));
    this.cache.set(instanceId, { set, until: Date.now() + CACHE_TTL_MS });
  }

  private async load(instanceId: string): Promise<HubSpotTokenSet> {
    const cached = this.cache.get(instanceId);
    if (cached && cached.until > Date.now()) return cached.set;
    const raw = await this.secrets.get(secretName(instanceId));
    if (!raw) throw new NotConnectedError();
    const set = JSON.parse(raw) as HubSpotTokenSet;
    this.cache.set(instanceId, { set, until: Date.now() + CACHE_TTL_MS });
    return set;
  }

  async getAccessToken(instanceId: string): Promise<string> {
    const set = await this.load(instanceId);
    if (set.expiresAt - Date.now() > REFRESH_MARGIN_MS) return set.accessToken;
    return (await this.refresh(instanceId)).accessToken;
  }

  /** Single-flight refresh: concurrent callers share one refresh request. */
  refresh(instanceId: string): Promise<HubSpotTokenSet> {
    let pending = this.refreshing.get(instanceId);
    if (!pending) {
      pending = (async () => {
        this.cache.delete(instanceId);
        const next = await this.oauth.refresh(await this.load(instanceId));
        await this.save(instanceId, next);
        log.info('hubspot token refreshed', { instanceId });
        return next;
      })().finally(() => this.refreshing.delete(instanceId));
      this.refreshing.set(instanceId, pending);
    }
    return pending;
  }

  /** Revokes the refresh token at HubSpot (best effort) and deletes the stored secret. */
  async remove(instanceId: string): Promise<void> {
    try {
      const set = await this.load(instanceId);
      await this.oauth.revoke(set.refreshToken);
    } catch (err) {
      if (!(err instanceof NotConnectedError)) log.warn('hubspot token revoke failed', { instanceId, error: errorInfo(err) });
    }
    this.cache.delete(instanceId);
    await this.secrets.delete(secretName(instanceId));
  }
}
