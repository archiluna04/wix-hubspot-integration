import { requestJson } from '../lib/http.js';

/**
 * Least-privilege scopes:
 *  - crm.objects.contacts.read/write: read and create/update contacts (features #1 and #2)
 *  - crm.schemas.contacts.read: list contact properties for the mapping UI
 *  - crm.schemas.contacts.write: create the "Wix Integration" property group + UTM/attribution properties
 *  - oauth: required by HubSpot for OAuth apps
 */
export const HUBSPOT_SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
];

const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
const API = 'https://api.hubapi.com';

export interface HubSpotTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  hubId: string;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class HubSpotOAuth {
  constructor(private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string }) {}

  authorizeUrl(state: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('scope', HUBSPOT_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<HubSpotTokenSet> {
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri });
    const info = await requestJson<{ hub_id: number; scopes: string[] }>(
      `${API}/oauth/v1/access-tokens/${encodeURIComponent(t.access_token)}`,
    );
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      hubId: String(info.hub_id),
      scopes: info.scopes ?? HUBSPOT_SCOPES,
    };
  }

  async refresh(current: HubSpotTokenSet): Promise<HubSpotTokenSet> {
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
    return {
      ...current,
      accessToken: t.access_token,
      refreshToken: t.refresh_token || current.refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
  }

  async revoke(refreshToken: string): Promise<void> {
    await requestJson(`${API}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, {
      method: 'DELETE',
      retries: 1,
    });
  }

  private token(params: Record<string, string>): Promise<TokenResponse> {
    return requestJson<TokenResponse>(`${API}/oauth/v1/token`, {
      method: 'POST',
      form: { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params },
      retries: 2,
    });
  }
}
