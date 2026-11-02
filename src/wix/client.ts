import { HttpError, requestJson } from '../lib/http.js';
import type { WixContact, WixContactsPort } from '../sync/engine.js';
import type { WixContactInfo } from '../sync/wixFields.js';

const WIX_API = 'https://www.wixapis.com';

/**
 * Self-hosted app authentication: exchanges app credentials for a short-lived
 * access token scoped to one site installation (OAuth client_credentials).
 */
export class WixAppAuth {
  private cache = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async token(instanceId: string): Promise<string> {
    const cached = this.cache.get(instanceId);
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await requestJson<{ access_token: string; expires_in?: number }>(`${WIX_API}/oauth2/token`, {
      method: 'POST',
      body: {
        grant_type: 'client_credentials',
        client_id: this.appId,
        client_secret: this.appSecret,
        instance_id: instanceId,
      },
      retries: 2,
    });
    const ttl = Math.max((res.expires_in ?? 14_400) - 300, 60) * 1000;
    this.cache.set(instanceId, { token: res.access_token, until: Date.now() + ttl });
    return res.access_token;
  }

  invalidate(instanceId: string): void {
    this.cache.delete(instanceId);
  }
}

export interface WixExtendedField {
  key: string;
  displayName: string;
  fieldType?: string;
}

interface RawContact {
  id: string;
  revision?: number;
  info?: WixContactInfo;
  createdDate?: string;
  updatedDate?: string;
}

const toContact = (c: RawContact): WixContact => ({
  id: c.id,
  revision: c.revision,
  info: c.info ?? {},
  createdDate: c.createdDate,
  updatedDate: c.updatedDate,
});

/** Wix REST client (Contacts v4, Extended Fields, Forms, Embedded Scripts) for one site. */
export class WixClient implements WixContactsPort {
  constructor(
    private readonly instanceId: string,
    private readonly auth: WixAppAuth,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = async () =>
      requestJson<T>(`${WIX_API}${path}`, {
        method,
        body,
        headers: { Authorization: await this.auth.token(this.instanceId) },
      });
    try {
      return await send();
    } catch (err) {
      // 401: token expired. 403: the site may have just granted new permissions, which
      // only a newly issued token carries. Either way, retry once with a fresh token.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        this.auth.invalidate(this.instanceId);
        return send();
      }
      throw err;
    }
  }

  async getContact(id: string): Promise<WixContact | null> {
    try {
      const res = await this.call<{ contact: RawContact }>(
        'GET',
        `/contacts/v4/contacts/${encodeURIComponent(id)}?fieldsets=FULL`,
      );
      return toContact(res.contact);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async findContactByEmail(email: string): Promise<WixContact | null> {
    const res = await this.call<{ contacts?: RawContact[] }>('POST', '/contacts/v4/contacts/query', {
      query: { filter: { 'primaryInfo.email': { $eq: email } }, paging: { limit: 1 } },
    });
    const hit = res.contacts?.[0];
    return hit ? this.getContact(hit.id) : null;
  }

  async createContact(info: WixContactInfo): Promise<WixContact> {
    const res = await this.call<{ contact: RawContact }>('POST', '/contacts/v4/contacts', {
      info,
      allowDuplicates: false,
    });
    return toContact(res.contact);
  }

  async updateContact(id: string, revision: number | undefined, info: WixContactInfo): Promise<WixContact> {
    const res = await this.call<{ contact: RawContact }>('PATCH', `/contacts/v4/contacts/${encodeURIComponent(id)}`, {
      revision,
      info,
      allowDuplicates: false,
    });
    return toContact(res.contact);
  }

  async listContactIds(offset: number): Promise<{ ids: string[]; hasMore: boolean }> {
    const res = await this.call<{ contacts?: RawContact[]; pagingMetadata?: { hasNext?: boolean; total?: number } }>(
      'POST',
      '/contacts/v4/contacts/query',
      { query: { paging: { limit: 100, offset } } },
    );
    const ids = (res.contacts ?? []).map((c) => c.id);
    const total = res.pagingMetadata?.total;
    return { ids, hasMore: res.pagingMetadata?.hasNext ?? (total != null ? offset + ids.length < total : ids.length === 100) };
  }

  /** User-defined custom contact fields ("custom.*"), offered in the mapping UI. */
  async listExtendedFields(): Promise<WixExtendedField[]> {
    const res = await this.call<{ fields?: WixExtendedField[] }>('POST', '/contacts/v4/extended-fields/query', {
      query: { paging: { limit: 100 } },
    });
    return (res.fields ?? []).filter((f) => f.key?.startsWith('custom.'));
  }

  /** Best effort: Get Form by id is not permitted for apps, but a namespace-scoped query is. */
  async getFormName(formId: string, namespace = 'wix.form_app.form'): Promise<string | null> {
    try {
      const res = await this.call<{ forms?: Array<{ id?: string; name?: string }> }>(
        'POST',
        '/form-schema-service/v4/forms/query',
        { query: { filter: { namespace: { $eq: namespace } }, paging: { limit: 100 } }, namespace },
      );
      return res.forms?.find((f) => f.id === formId)?.name ?? null;
    } catch {
      return null;
    }
  }

  /** Activates the app's Embedded Script extension on the site with template parameters. */
  async embedScript(parameters: Record<string, string>): Promise<void> {
    await this.call('POST', '/apps/v1/scripts', { properties: { parameters } });
  }
}
