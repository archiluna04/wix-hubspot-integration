import { HttpError, requestJson } from '../lib/http.js';
import { ContactExistsError, type HubSpotContact, type HubSpotContactsPort } from '../sync/engine.js';
import type { HubSpotTokenManager } from './tokens.js';

const API = 'https://api.hubapi.com';

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  hidden?: boolean;
  calculated?: boolean;
  modificationMetadata?: { readOnlyValue?: boolean };
}

interface CrmObject {
  id: string;
  properties: Record<string, string | null>;
  updatedAt?: string;
}

const toContact = (o: CrmObject): HubSpotContact => ({ id: String(o.id), properties: o.properties ?? {}, updatedAt: o.updatedAt });

/** HubSpot CRM v3 client for one connected installation. */
export class HubSpotClient implements HubSpotContactsPort {
  constructor(
    private readonly instanceId: string,
    private readonly tokens: HubSpotTokenManager,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const send = (token: string) =>
      requestJson<T>(`${API}${path}`, { method, body, headers: { Authorization: `Bearer ${token}` } });
    try {
      return await send(await this.tokens.getAccessToken(this.instanceId));
    } catch (err) {
      // Token revoked/expired early: refresh once and retry.
      if (err instanceof HttpError && err.status === 401) {
        return send((await this.tokens.refresh(this.instanceId)).accessToken);
      }
      throw err;
    }
  }

  // ---- Contacts API ----------------------------------------------------------

  async getContact(id: string, properties: string[]): Promise<HubSpotContact | null> {
    try {
      const qs = new URLSearchParams({ properties: properties.join(','), archived: 'false' });
      return toContact(await this.call<CrmObject>('GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?${qs}`));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async findContactByEmail(email: string, properties: string[]): Promise<HubSpotContact | null> {
    const res = await this.call<{ results: CrmObject[] }>('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties,
      limit: 1,
    });
    return res.results[0] ? toContact(res.results[0]) : null;
  }

  async createContact(properties: Record<string, string>): Promise<HubSpotContact> {
    try {
      return toContact(await this.call<CrmObject>('POST', '/crm/v3/objects/contacts', { properties }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const message = String((err.details as { message?: string } | undefined)?.message ?? '');
        const existingId = message.match(/Existing ID:\s*(\d+)/i)?.[1];
        if (existingId) throw new ContactExistsError(existingId);
      }
      throw err;
    }
  }

  async updateContact(id: string, properties: Record<string, string>): Promise<HubSpotContact> {
    return toContact(
      await this.call<CrmObject>('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties }),
    );
  }

  async listContactIds(after?: string): Promise<{ ids: string[]; after?: string }> {
    const qs = new URLSearchParams({ limit: '100', properties: 'email' });
    if (after) qs.set('after', after);
    const res = await this.call<{ results: CrmObject[]; paging?: { next?: { after: string } } }>(
      'GET',
      `/crm/v3/objects/contacts?${qs}`,
    );
    return { ids: res.results.map((r) => String(r.id)), after: res.paging?.next?.after };
  }

  // ---- Properties API ----------------------------------------------------------

  async listProperties(): Promise<HubSpotProperty[]> {
    const res = await this.call<{ results: HubSpotProperty[] }>('GET', '/crm/v3/properties/contacts');
    return res.results;
  }

  async createPropertyGroup(name: string, label: string): Promise<void> {
    try {
      await this.call('POST', '/crm/v3/properties/contacts/groups', { name, label, displayOrder: -1 });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }

  async createProperty(def: Omit<HubSpotProperty, 'hidden' | 'calculated' | 'modificationMetadata'> & { description?: string }) {
    try {
      await this.call('POST', '/crm/v3/properties/contacts', def);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
  }
}
