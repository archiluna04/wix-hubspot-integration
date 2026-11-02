/**
 * In-memory Wix + HubSpot fakes that behave like the real systems for sync purposes:
 * every write bumps updatedAt and emits a webhook-like event, so tests can pump events
 * back into the engine and count resulting writes (ping-pong detection).
 */
import { HttpError } from '../src/lib/http.js';
import {
  ContactExistsError,
  type HubSpotContact,
  type HubSpotContactsPort,
  type WixContact,
  type WixContactsPort,
} from '../src/sync/engine.js';
import { primaryEmail, type WixContactInfo } from '../src/sync/wixFields.js';

let clock = Date.parse('2026-01-01T00:00:00Z');
export const tick = () => new Date((clock += 1000)).toISOString();

const clone = <T>(v: T): T => structuredClone(v);

export class FakeWix implements WixContactsPort {
  contacts = new Map<string, WixContact>();
  events: string[] = [];
  writes = 0;
  private seq = 0;

  async getContact(id: string) {
    const c = this.contacts.get(id);
    return c ? clone(c) : null;
  }
  async findContactByEmail(email: string) {
    for (const c of this.contacts.values()) if (primaryEmail(c.info)?.toLowerCase() === email.toLowerCase()) return clone(c);
    return null;
  }
  async createContact(info: WixContactInfo) {
    this.writes++;
    return clone(this.insert(info));
  }
  async updateContact(id: string, revision: number | undefined, patch: WixContactInfo) {
    const c = this.contacts.get(id);
    if (!c) throw new HttpError(404, 'not found');
    if (revision !== c.revision) throw new HttpError(409, 'revision mismatch');
    this.writes++;
    c.info = { ...c.info, ...clone(patch) };
    c.revision = (c.revision ?? 0) + 1;
    c.updatedDate = tick();
    this.events.push(id);
    return clone(c);
  }

  /** Simulates the site owner creating/editing a contact in Wix (emits a webhook). */
  insert(info: WixContactInfo): WixContact {
    const c: WixContact = { id: `wix-${++this.seq}`, revision: 1, info: clone(info), updatedDate: tick() };
    this.contacts.set(c.id, c);
    this.events.push(c.id);
    return c;
  }
  userEdit(id: string, mutate: (info: WixContactInfo) => void) {
    const c = this.contacts.get(id)!;
    mutate(c.info);
    c.revision = (c.revision ?? 0) + 1;
    c.updatedDate = tick();
    this.events.push(id);
  }
}

export class FakeHubSpot implements HubSpotContactsPort {
  contacts = new Map<string, HubSpotContact>();
  /** HubSpot sends one webhook per changed property: simulate that burst. */
  events: string[] = [];
  writes = 0;
  private seq = 100;

  async getContact(id: string) {
    const c = this.contacts.get(id);
    return c ? clone(c) : null;
  }
  async findContactByEmail(email: string) {
    for (const c of this.contacts.values()) if (c.properties.email?.toLowerCase() === email.toLowerCase()) return clone(c);
    return null;
  }
  async createContact(properties: Record<string, string>) {
    if (properties.email && (await this.findContactByEmail(properties.email))) {
      throw new ContactExistsError((await this.findContactByEmail(properties.email))!.id);
    }
    this.writes++;
    return clone(this.insert(properties));
  }
  async updateContact(id: string, properties: Record<string, string>) {
    const c = this.contacts.get(id);
    if (!c) throw new HttpError(404, 'not found');
    this.writes++;
    Object.assign(c.properties, properties);
    c.updatedAt = tick();
    for (const _ of Object.keys(properties)) this.events.push(id);
    return clone({ ...c, properties: { ...properties } }); // like HubSpot: echoes the written props
  }

  insert(properties: Record<string, string>): HubSpotContact {
    const c: HubSpotContact = { id: String(++this.seq), properties: { ...properties }, updatedAt: tick() };
    this.contacts.set(c.id, c);
    this.events.push(c.id);
    return c;
  }
  userEdit(id: string, properties: Record<string, string>) {
    const c = this.contacts.get(id)!;
    Object.assign(c.properties, properties);
    c.updatedAt = tick();
    this.events.push(id);
  }
}
