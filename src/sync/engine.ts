/**
 * Bi-directional contact sync engine.
 *
 * Loop prevention uses four independent layers:
 *  1. External ID mapping: every synced pair is stored in `contact_links`.
 *  2. Per-side "last synced" state: for each mapping row we remember the value we last
 *     saw/wrote on the Wix side and on the HubSpot side. An incoming event is only a
 *     change if the source's current value differs from that state. The echo of our own
 *     write therefore never looks like a change, even if the target normalized the value.
 *  3. Dedupe window: a hash of what we just wrote is kept for a short TTL, so the echo
 *     webhook is dropped before any further work (also covers webhooks that race the
 *     link being persisted). Wix webhooks from this app's own identity are also dropped.
 *  4. Idempotent writes: the target is only written when its current values differ
 *     from the desired values.
 *
 * Every run gets a `syncId` (correlation id) that is logged, stored on the link and,
 * when the integration properties exist, written to HubSpot as `wix_sync_id` together
 * with `wix_sync_source`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { log } from '../lib/logger.js';
import type { ConflictStrategy, LinkState, Store, System } from '../store.js';
import { applyTransform, rowKey, writesToHubSpot, writesToWix, type MappingRow } from './mapping.js';
import { buildWixInfoPatch, getWixField, primaryEmail, type WixContactInfo } from './wixFields.js';

export interface WixContact {
  id: string;
  revision?: number;
  info: WixContactInfo;
  createdDate?: string;
  updatedDate?: string;
}

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null | undefined>;
  updatedAt?: string;
}

export interface WixContactsPort {
  getContact(id: string): Promise<WixContact | null>;
  findContactByEmail(email: string): Promise<WixContact | null>;
  createContact(info: WixContactInfo): Promise<WixContact>;
  updateContact(id: string, revision: number | undefined, info: WixContactInfo): Promise<WixContact>;
}

export interface HubSpotContactsPort {
  getContact(id: string, properties: string[]): Promise<HubSpotContact | null>;
  findContactByEmail(email: string, properties: string[]): Promise<HubSpotContact | null>;
  createContact(properties: Record<string, string>): Promise<HubSpotContact>;
  updateContact(id: string, properties: Record<string, string>): Promise<HubSpotContact>;
}

/** Thrown by a HubSpot port when a create collides with an existing contact (409). */
export class ContactExistsError extends Error {
  constructor(readonly existingId: string) {
    super('Contact already exists');
    this.name = 'ContactExistsError';
  }
}

export interface SyncResult {
  syncId: string;
  action: 'created' | 'updated' | 'linked' | 'skipped';
  reason?: string;
  fields?: string[];
  /** Ask the caller to run the opposite direction for rows that still need reconciling. */
  followUp?: { system: System; contactId: string };
}

export interface EngineDeps {
  store: Store;
  wix(instanceId: string): WixContactsPort;
  hubspot(instanceId: string): HubSpotContactsPort;
  /** TTL of the dedupe window. 0 disables it (state comparison still prevents loops). */
  dedupeWindowMs?: number;
}

export const DEFAULT_DEDUPE_WINDOW_MS = 2 * 60_000;

export const normalize = (value: unknown): string => (value == null ? '' : String(value).trim());

export function projectWix(info: WixContactInfo, rows: MappingRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[rowKey(r)] = normalize(getWixField(r.wixField)?.get(info));
  return out;
}

export function projectHubSpot(props: HubSpotContact['properties'], rows: MappingRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[rowKey(r)] = normalize(props[r.hubspotProperty]);
  return out;
}

export function hashState(state: Record<string, string>): string {
  const entries = Object.keys(state)
    .sort()
    .map((k) => [k, state[k]]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Deterministic conflict rule shared by both directions so they always agree. */
export function resolveConflict(strategy: ConflictStrategy, wixUpdated?: string, hubspotUpdated?: string): System {
  if (strategy === 'wix_wins') return 'wix';
  if (strategy === 'hubspot_wins') return 'hubspot';
  const w = wixUpdated ? Date.parse(wixUpdated) : NaN;
  const h = hubspotUpdated ? Date.parse(hubspotUpdated) : NaN;
  if (Number.isNaN(w)) return 'hubspot';
  if (Number.isNaN(h)) return 'wix';
  return w > h ? 'wix' : 'hubspot'; // ties go to HubSpot
}

export function hubspotPropertiesFor(rows: MappingRow[]): string[] {
  return [...new Set(['email', 'lastmodifieddate', ...rows.map((r) => r.hubspotProperty)])];
}

const emptyState = (): LinkState => ({ wix: {}, hs: {} });

interface Context {
  rows: MappingRow[];
  strategy: ConflictStrategy;
  metaReady: boolean;
}

export class SyncEngine {
  private readonly dedupeWindowMs: number;

  constructor(private readonly deps: EngineDeps) {
    this.dedupeWindowMs = deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  }

  private context(instanceId: string): Context | string {
    const inst = this.deps.store.getInstallation(instanceId);
    if (!inst?.hubspotPortalId) return 'hubspot_not_connected';
    if (!inst.settings.syncEnabled) return 'sync_disabled';
    return {
      rows: this.deps.store.getMappings(instanceId),
      strategy: inst.settings.conflictStrategy,
      metaReady: inst.hubspotPropertiesReady,
    };
  }

  private record(
    instanceId: string,
    source: System,
    ids: { wixContactId: string | null; hubspotContactId: string | null },
    result: SyncResult,
  ): SyncResult {
    this.deps.store.addSyncEvent(instanceId, {
      syncId: result.syncId,
      source,
      wixContactId: ids.wixContactId,
      hubspotContactId: ids.hubspotContactId,
      action: result.action,
      reason: result.reason ?? null,
      fields: result.fields ?? [],
    });
    log.info('contact sync', {
      instanceId,
      syncId: result.syncId,
      source,
      action: result.action,
      reason: result.reason,
      fieldCount: result.fields?.length ?? 0,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Wix -> HubSpot
  // ---------------------------------------------------------------------------

  async syncFromWix(instanceId: string, wixContactId: string): Promise<SyncResult> {
    const syncId = randomUUID();
    const ids = { wixContactId, hubspotContactId: null as string | null };
    const finish = (r: Omit<SyncResult, 'syncId'>) => this.record(instanceId, 'wix', ids, { syncId, ...r });

    const ctx = this.context(instanceId);
    if (typeof ctx === 'string') return finish({ action: 'skipped', reason: ctx });
    const { rows, strategy, metaReady } = ctx;
    const { store } = this.deps;
    const wix = this.deps.wix(instanceId);
    const hubspot = this.deps.hubspot(instanceId);

    const contact = await wix.getContact(wixContactId);
    if (!contact) return finish({ action: 'skipped', reason: 'wix_contact_not_found' });

    const wixProj = projectWix(contact.info, rows);
    if (store.isRecentWrite(instanceId, 'wix', contact.id, hashState(wixProj))) {
      return finish({ action: 'skipped', reason: 'own_write_echo' });
    }

    const props = hubspotPropertiesFor(rows);
    let link = store.getLinkByWix(instanceId, contact.id);
    let target: HubSpotContact | null = null;
    if (link) {
      ids.hubspotContactId = link.hubspotContactId;
      target = await hubspot.getContact(link.hubspotContactId, props);
      if (!target) {
        store.deleteLinkByWix(instanceId, contact.id);
        link = null;
      }
    }

    const outbound = rows.filter(writesToHubSpot);
    const email = primaryEmail(contact.info);
    let candidates: MappingRow[];
    if (link) {
      const prev = link.state.wix;
      candidates = outbound.filter((r) => wixProj[rowKey(r)] !== (prev[rowKey(r)] ?? ''));
      if (!candidates.length) return finish({ action: 'skipped', reason: 'no_mapped_changes' });
    } else {
      if (!email) return finish({ action: 'skipped', reason: 'no_email' });
      target = await hubspot.findContactByEmail(email, props);
      candidates = outbound;
    }

    // Conflict handling: HubSpot also changed this field since the last sync
    // (or, on first link, already holds a different non-empty value).
    const targetProj = target ? projectHubSpot(target.properties, rows) : {};
    const winners: MappingRow[] = [];
    const conflictsLost: string[] = [];
    for (const r of candidates) {
      const k = rowKey(r);
      const hubspotDiverged = link ? targetProj[k] !== (link.state.hs[k] ?? '') : !!targetProj[k];
      if (target && r.direction === 'bidirectional' && hubspotDiverged && targetProj[k] !== wixProj[k]) {
        if (resolveConflict(strategy, contact.updatedDate, target.updatedAt) === 'hubspot') {
          conflictsLost.push(r.hubspotProperty);
          continue;
        }
      }
      winners.push(r);
    }

    const desired: Record<string, string> = {};
    for (const r of winners) {
      let value = applyTransform(wixProj[rowKey(r)] ?? '', r.transform);
      if (!value && r.defaultValue) value = r.defaultValue;
      if (!value && !link) continue; // never blank out HubSpot data when first linking
      desired[r.hubspotProperty] = value;
    }

    const changes = target
      ? Object.fromEntries(Object.entries(desired).filter(([p, v]) => normalize(target!.properties[p]) !== v))
      : desired;
    const meta: Record<string, string> = metaReady
      ? { wix_sync_source: 'wix', wix_sync_id: syncId, wix_contact_id: contact.id }
      : {};

    let written: HubSpotContact;
    let action: SyncResult['action'];
    if (!target) {
      const body = { email: email!, ...desired, ...meta };
      try {
        written = await hubspot.createContact(body);
        action = 'created';
      } catch (err) {
        if (!(err instanceof ContactExistsError)) throw err;
        written = await hubspot.updateContact(err.existingId, body);
        action = 'updated';
      }
    } else if (Object.keys(changes).length) {
      written = await hubspot.updateContact(target.id, { ...changes, ...meta });
      action = 'updated';
    } else {
      written = target;
      action = link ? 'skipped' : 'linked';
    }
    ids.hubspotContactId = written.id;

    const writtenProj = projectHubSpot({ ...(target?.properties ?? {}), ...written.properties }, rows);
    const state: LinkState = link ? structuredClone(link.state) : emptyState();
    for (const r of winners) {
      const k = rowKey(r);
      state.wix[k] = wixProj[k] ?? '';
      state.hs[k] = writtenProj[k] ?? '';
    }
    store.upsertLink({
      instanceId,
      wixContactId: contact.id,
      hubspotContactId: written.id,
      state,
      lastSyncId: syncId,
      lastSyncSource: 'wix',
      lastSyncedAt: new Date().toISOString(),
    });
    if (action === 'created' || action === 'updated') {
      store.recordWrite(instanceId, 'hubspot', written.id, hashState(writtenProj), syncId, this.dedupeWindowMs);
    }

    // Rows that should flow HubSpot -> Wix (or conflicts HubSpot won) still need a pass in that direction.
    const pending = !link
      ? rows.some((r) => writesToWix(r) && !winners.includes(r))
      : conflictsLost.length > 0;
    return finish({
      action,
      reason: conflictsLost.length
        ? `conflict_hubspot_won:${conflictsLost.join('|')}`
        : action === 'skipped'
          ? 'already_in_sync'
          : undefined,
      fields: action === 'created' ? Object.keys(desired) : Object.keys(changes),
      followUp: pending ? { system: 'hubspot', contactId: written.id } : undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // HubSpot -> Wix
  // ---------------------------------------------------------------------------

  async syncFromHubSpot(instanceId: string, hubspotContactId: string): Promise<SyncResult> {
    const syncId = randomUUID();
    const ids = { wixContactId: null as string | null, hubspotContactId };
    const finish = (r: Omit<SyncResult, 'syncId'>) => this.record(instanceId, 'hubspot', ids, { syncId, ...r });

    const ctx = this.context(instanceId);
    if (typeof ctx === 'string') return finish({ action: 'skipped', reason: ctx });
    const { rows, strategy } = ctx;
    const { store } = this.deps;
    const wix = this.deps.wix(instanceId);
    const hubspot = this.deps.hubspot(instanceId);

    const contact = await hubspot.getContact(hubspotContactId, hubspotPropertiesFor(rows));
    if (!contact) return finish({ action: 'skipped', reason: 'hubspot_contact_not_found' });

    const hsProj = projectHubSpot(contact.properties, rows);
    if (store.isRecentWrite(instanceId, 'hubspot', contact.id, hashState(hsProj))) {
      return finish({ action: 'skipped', reason: 'own_write_echo' });
    }

    let link = store.getLinkByHubSpot(instanceId, contact.id);
    let target: WixContact | null = null;
    if (link) {
      ids.wixContactId = link.wixContactId;
      target = await wix.getContact(link.wixContactId);
      if (!target) {
        store.deleteLinkByHubSpot(instanceId, contact.id);
        link = null;
      }
    }

    const inbound = rows.filter(writesToWix);
    const email = normalize(contact.properties.email);
    let candidates: MappingRow[];
    if (link) {
      const prev = link.state.hs;
      candidates = inbound.filter((r) => hsProj[rowKey(r)] !== (prev[rowKey(r)] ?? ''));
      if (!candidates.length) return finish({ action: 'skipped', reason: 'no_mapped_changes' });
    } else {
      if (!email) return finish({ action: 'skipped', reason: 'no_email' });
      target = await wix.findContactByEmail(email);
      candidates = inbound;
    }

    const targetProj = target ? projectWix(target.info, rows) : {};
    const winners: MappingRow[] = [];
    const conflictsLost: string[] = [];
    for (const r of candidates) {
      const k = rowKey(r);
      const wixDiverged = link ? targetProj[k] !== (link.state.wix[k] ?? '') : !!targetProj[k];
      if (target && r.direction === 'bidirectional' && wixDiverged && targetProj[k] !== hsProj[k]) {
        if (resolveConflict(strategy, target.updatedDate, contact.updatedAt) === 'wix') {
          conflictsLost.push(r.wixField);
          continue;
        }
      }
      winners.push(r);
    }

    const desired: Array<{ field: string; value: string; key: string }> = [];
    for (const r of winners) {
      let value = applyTransform(hsProj[rowKey(r)] ?? '', r.transform);
      if (!value && r.defaultValue) value = r.defaultValue;
      if (!value && !link) continue;
      desired.push({ field: r.wixField, value, key: rowKey(r) });
    }
    const changes = target ? desired.filter((d) => normalize(targetProj[d.key]) !== d.value) : desired;

    let written: WixContact;
    let action: SyncResult['action'];
    if (!target) {
      const info = buildWixInfoPatch({}, changes);
      if (!primaryEmail(info)) getWixField('email')!.set(info, email);
      try {
        written = await wix.createContact(info);
        action = 'created';
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 409) throw err;
        const existing = await wix.findContactByEmail(email);
        if (!existing) throw err;
        written = await this.updateWix(wix, existing, changes);
        action = 'updated';
      }
    } else if (changes.length) {
      written = await this.updateWix(wix, target, changes);
      action = 'updated';
    } else {
      written = target;
      action = link ? 'skipped' : 'linked';
    }
    ids.wixContactId = written.id;

    const writtenProj = projectWix(written.info, rows);
    const state: LinkState = link ? structuredClone(link.state) : emptyState();
    for (const r of winners) {
      const k = rowKey(r);
      state.hs[k] = hsProj[k] ?? '';
      state.wix[k] = writtenProj[k] ?? '';
    }
    store.upsertLink({
      instanceId,
      wixContactId: written.id,
      hubspotContactId: contact.id,
      state,
      lastSyncId: syncId,
      lastSyncSource: 'hubspot',
      lastSyncedAt: new Date().toISOString(),
    });
    if (action === 'created' || action === 'updated') {
      store.recordWrite(instanceId, 'wix', written.id, hashState(writtenProj), syncId, this.dedupeWindowMs);
    }

    const pending = !link
      ? rows.some((r) => writesToHubSpot(r) && !winners.includes(r))
      : conflictsLost.length > 0;
    return finish({
      action,
      reason: conflictsLost.length
        ? `conflict_wix_won:${conflictsLost.join('|')}`
        : action === 'skipped'
          ? 'already_in_sync'
          : undefined,
      fields: changes.map((c) => c.field),
      followUp: pending ? { system: 'wix', contactId: written.id } : undefined,
    });
  }

  /** Wix updates are revision-checked; on a concurrent edit, refetch once and re-apply. */
  private async updateWix(
    wix: WixContactsPort,
    target: WixContact,
    changes: Array<{ field: string; value: string }>,
  ): Promise<WixContact> {
    try {
      return await wix.updateContact(target.id, target.revision, buildWixInfoPatch(target.info, changes));
    } catch (err) {
      if (!(err instanceof HttpError) || (err.status !== 409 && err.status !== 412)) throw err;
      const fresh = await wix.getContact(target.id);
      if (!fresh) throw err;
      return wix.updateContact(fresh.id, fresh.revision, buildWixInfoPatch(fresh.info, changes));
    }
  }

  // ---------------------------------------------------------------------------
  // Deletions: unlink only. We never delete contacts in the other system.
  // ---------------------------------------------------------------------------

  unlinkWix(instanceId: string, wixContactId: string): void {
    this.deps.store.deleteLinkByWix(instanceId, wixContactId);
  }

  unlinkHubSpot(instanceId: string, hubspotContactId: string): void {
    this.deps.store.deleteLinkByHubSpot(instanceId, hubspotContactId);
  }
}
