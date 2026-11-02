import { HubSpotClient } from './hubspot/client.js';
import type { HubSpotOAuth } from './hubspot/oauth.js';
import { ensureIntegrationProperties } from './hubspot/properties.js';
import type { HubSpotTokenManager } from './hubspot/tokens.js';
import { errorInfo, log } from './lib/logger.js';
import type { Store } from './store.js';
import type { WixClient } from './wix/client.js';

/** Installation + connection lifecycle: install/uninstall, HubSpot connect/disconnect. */
export class Lifecycle {
  constructor(
    private readonly deps: {
      store: Store;
      oauth: HubSpotOAuth;
      tokens: HubSpotTokenManager;
      hubspotClient(instanceId: string): HubSpotClient;
      wixClient(instanceId: string): WixClient;
    },
  ) {}

  /** Turns on the attribution script on the site (Embedded Script extension, param "siteKey"). */
  async ensureEmbeddedScript(instanceId: string): Promise<void> {
    const inst = this.deps.store.getInstallation(instanceId);
    if (!inst || inst.scriptEmbedded) return;
    try {
      await this.deps.wixClient(instanceId).embedScript({ siteKey: inst.siteKey });
      this.deps.store.setScriptEmbedded(instanceId);
      log.info('attribution script embedded', { instanceId });
    } catch (err) {
      log.warn('could not embed attribution script', { instanceId, error: errorInfo(err) });
    }
  }

  async completeHubSpotConnect(instanceId: string, code: string): Promise<string> {
    const { store, oauth, tokens } = this.deps;
    store.ensureInstallation(instanceId);
    const set = await oauth.exchangeCode(code);
    await tokens.save(instanceId, set);
    const previous = store.getInstallation(instanceId)?.hubspotPortalId;
    if (previous && previous !== set.hubId) store.deleteAllLinks(instanceId); // different portal: old links are meaningless
    store.setHubSpotConnection(instanceId, { portalId: set.hubId, scopes: set.scopes });
    await this.ensureProperties(instanceId);
    log.info('hubspot connected', { instanceId, portalId: set.hubId });
    return set.hubId;
  }

  async ensureProperties(instanceId: string): Promise<boolean> {
    try {
      await ensureIntegrationProperties(this.deps.hubspotClient(instanceId));
      this.deps.store.setHubSpotPropertiesReady(instanceId, true);
      return true;
    } catch (err) {
      log.warn('could not create hubspot integration properties', { instanceId, error: errorInfo(err) });
      return false;
    }
  }

  async disconnectHubSpot(instanceId: string): Promise<void> {
    await this.deps.tokens.remove(instanceId);
    this.deps.store.setHubSpotConnection(instanceId, null);
    this.deps.store.deleteAllLinks(instanceId);
    log.info('hubspot disconnected', { instanceId });
  }

  async uninstall(instanceId: string): Promise<void> {
    await this.deps.tokens.remove(instanceId);
    this.deps.store.deleteInstallation(instanceId);
    log.info('app uninstalled; data deleted', { instanceId });
  }
}
