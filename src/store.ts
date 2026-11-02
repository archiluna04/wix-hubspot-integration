import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MAPPINGS, type MappingRow } from './sync/mapping.js';

export type ConflictStrategy = 'last_updated_wins' | 'hubspot_wins' | 'wix_wins';
export type System = 'wix' | 'hubspot';

export interface Settings {
  syncEnabled: boolean;
  conflictStrategy: ConflictStrategy;
  formCaptureEnabled: boolean;
  setLifecycleStageLead: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  syncEnabled: true,
  conflictStrategy: 'last_updated_wins',
  formCaptureEnabled: true,
  setLifecycleStageLead: true,
};

export interface Installation {
  instanceId: string;
  siteKey: string;
  hubspotPortalId: string | null;
  hubspotScopes: string[];
  hubspotConnectedAt: string | null;
  hubspotPropertiesReady: boolean;
  scriptEmbedded: boolean;
  settings: Settings;
}

/** Last synced (normalized) values per mapping row, tracked separately for each side. */
export interface LinkState {
  wix: Record<string, string>;
  hs: Record<string, string>;
}

export interface ContactLink {
  instanceId: string;
  wixContactId: string;
  hubspotContactId: string;
  state: LinkState;
  lastSyncId: string | null;
  lastSyncSource: System | null;
  lastSyncedAt: string | null;
}

export interface SyncEvent {
  syncId: string | null;
  source: string;
  wixContactId: string | null;
  hubspotContactId: string | null;
  action: string;
  reason: string | null;
  fields: string[];
  createdAt: string;
}

export interface FormEvent {
  submissionId: string;
  formId: string | null;
  formName: string | null;
  status: string;
  reason: string | null;
  hubspotContactId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  latencyMs: number | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface Job {
  id: number;
  instanceId: string;
  type: string;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

type Row = Record<string, unknown>;
const iso = () => new Date().toISOString();
const str = (v: unknown) => (v == null ? null : String(v));

function toInstallation(r: Row): Installation {
  return {
    instanceId: String(r.instance_id),
    siteKey: String(r.site_key),
    hubspotPortalId: str(r.hubspot_portal_id),
    hubspotScopes: r.hubspot_scopes ? String(r.hubspot_scopes).split(' ') : [],
    hubspotConnectedAt: str(r.hubspot_connected_at),
    hubspotPropertiesReady: Number(r.hubspot_properties_ready) === 1,
    scriptEmbedded: Number(r.script_embedded) === 1,
    settings: { ...DEFAULT_SETTINGS, ...JSON.parse(String(r.settings_json || '{}')) },
  };
}

function toLink(r: Row): ContactLink {
  return {
    instanceId: String(r.instance_id),
    wixContactId: String(r.wix_contact_id),
    hubspotContactId: String(r.hubspot_contact_id),
    state: JSON.parse(String(r.state_json)),
    lastSyncId: str(r.last_sync_id),
    lastSyncSource: str(r.last_sync_source) as System | null,
    lastSyncedAt: str(r.last_synced_at),
  };
}

export class Store {
  constructor(readonly db: DatabaseSync) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- installations ------------------------------------------------------

  ensureInstallation(instanceId: string): Installation {
    const now = iso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO installations (instance_id, site_key, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(instanceId, randomBytes(18).toString('base64url'), JSON.stringify(DEFAULT_SETTINGS), now, now);
    return this.getInstallation(instanceId)!;
  }

  getInstallation(instanceId: string): Installation | null {
    const row = this.db.prepare('SELECT * FROM installations WHERE instance_id = ?').get(instanceId) as Row | undefined;
    return row ? toInstallation(row) : null;
  }

  getInstallationBySiteKey(siteKey: string): Installation | null {
    const row = this.db.prepare('SELECT * FROM installations WHERE site_key = ?').get(siteKey) as Row | undefined;
    return row ? toInstallation(row) : null;
  }

  getInstallationsByPortal(portalId: string): Installation[] {
    return (this.db.prepare('SELECT * FROM installations WHERE hubspot_portal_id = ?').all(portalId) as Row[]).map(
      toInstallation,
    );
  }

  setHubSpotConnection(instanceId: string, conn: { portalId: string; scopes: string[] } | null): void {
    this.db
      .prepare(
        `UPDATE installations SET hubspot_portal_id = ?, hubspot_scopes = ?, hubspot_connected_at = ?,
           hubspot_properties_ready = 0, updated_at = ? WHERE instance_id = ?`,
      )
      .run(conn?.portalId ?? null, conn ? conn.scopes.join(' ') : null, conn ? iso() : null, iso(), instanceId);
  }

  setHubSpotPropertiesReady(instanceId: string, ready: boolean): void {
    this.db
      .prepare('UPDATE installations SET hubspot_properties_ready = ?, updated_at = ? WHERE instance_id = ?')
      .run(ready ? 1 : 0, iso(), instanceId);
  }

  setScriptEmbedded(instanceId: string): void {
    this.db
      .prepare('UPDATE installations SET script_embedded = 1, updated_at = ? WHERE instance_id = ?')
      .run(iso(), instanceId);
  }

  updateSettings(instanceId: string, settings: Settings): void {
    this.db
      .prepare('UPDATE installations SET settings_json = ?, updated_at = ? WHERE instance_id = ?')
      .run(JSON.stringify(settings), iso(), instanceId);
  }

  /** Removes all data for an installation (app uninstalled). */
  deleteInstallation(instanceId: string): void {
    this.tx(() => {
      for (const table of [
        'field_mappings',
        'contact_links',
        'recent_writes',
        'jobs',
        'sync_events',
        'form_events',
        'attribution_touches',
        'oauth_states',
        'installations',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE instance_id = ?`).run(instanceId);
      }
    });
  }

  // ---- field mappings ------------------------------------------------------

  getMappings(instanceId: string): MappingRow[] {
    const row = this.db.prepare('SELECT rows_json FROM field_mappings WHERE instance_id = ?').get(instanceId) as
      | Row
      | undefined;
    return row ? JSON.parse(String(row.rows_json)) : structuredClone(DEFAULT_MAPPINGS);
  }

  saveMappings(instanceId: string, rows: MappingRow[]): void {
    this.db
      .prepare(
        `INSERT INTO field_mappings (instance_id, rows_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET rows_json = excluded.rows_json, updated_at = excluded.updated_at`,
      )
      .run(instanceId, JSON.stringify(rows), iso());
  }

  // ---- contact links -------------------------------------------------------

  getLinkByWix(instanceId: string, wixContactId: string): ContactLink | null {
    const row = this.db
      .prepare('SELECT * FROM contact_links WHERE instance_id = ? AND wix_contact_id = ?')
      .get(instanceId, wixContactId) as Row | undefined;
    return row ? toLink(row) : null;
  }

  getLinkByHubSpot(instanceId: string, hubspotContactId: string): ContactLink | null {
    const row = this.db
      .prepare('SELECT * FROM contact_links WHERE instance_id = ? AND hubspot_contact_id = ?')
      .get(instanceId, hubspotContactId) as Row | undefined;
    return row ? toLink(row) : null;
  }

  upsertLink(link: ContactLink): void {
    this.tx(() => {
      this.db
        .prepare('DELETE FROM contact_links WHERE instance_id = ? AND (wix_contact_id = ? OR hubspot_contact_id = ?)')
        .run(link.instanceId, link.wixContactId, link.hubspotContactId);
      this.db
        .prepare(
          `INSERT INTO contact_links (instance_id, wix_contact_id, hubspot_contact_id, state_json, last_sync_id,
             last_sync_source, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          link.instanceId,
          link.wixContactId,
          link.hubspotContactId,
          JSON.stringify(link.state),
          link.lastSyncId,
          link.lastSyncSource,
          link.lastSyncedAt,
        );
    });
  }

  deleteLinkByWix(instanceId: string, wixContactId: string): void {
    this.db
      .prepare('DELETE FROM contact_links WHERE instance_id = ? AND wix_contact_id = ?')
      .run(instanceId, wixContactId);
  }

  deleteLinkByHubSpot(instanceId: string, hubspotContactId: string): void {
    this.db
      .prepare('DELETE FROM contact_links WHERE instance_id = ? AND hubspot_contact_id = ?')
      .run(instanceId, hubspotContactId);
  }

  deleteAllLinks(instanceId: string): void {
    this.db.prepare('DELETE FROM contact_links WHERE instance_id = ?').run(instanceId);
    this.db.prepare('DELETE FROM recent_writes WHERE instance_id = ?').run(instanceId);
  }

  countLinks(instanceId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM contact_links WHERE instance_id = ?').get(instanceId) as Row;
    return Number(row.n);
  }

  // ---- dedupe window ---------------------------------------------------------

  recordWrite(instanceId: string, system: System, contactId: string, stateHash: string, syncId: string, ttlMs: number) {
    if (ttlMs <= 0) return;
    this.db
      .prepare(
        `INSERT INTO recent_writes (instance_id, system, contact_id, state_hash, sync_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, system, contact_id) DO UPDATE SET state_hash = excluded.state_hash,
           sync_id = excluded.sync_id, expires_at = excluded.expires_at`,
      )
      .run(instanceId, system, contactId, stateHash, syncId, Date.now() + ttlMs);
  }

  /** True when `stateHash` matches a write we made to this contact within the dedupe window. */
  isRecentWrite(instanceId: string, system: System, contactId: string, stateHash: string): boolean {
    const row = this.db
      .prepare(
        'SELECT state_hash, expires_at FROM recent_writes WHERE instance_id = ? AND system = ? AND contact_id = ?',
      )
      .get(instanceId, system, contactId) as Row | undefined;
    return !!row && Number(row.expires_at) > Date.now() && row.state_hash === stateHash;
  }

  // ---- sync + form events -----------------------------------------------------

  addSyncEvent(instanceId: string, e: Omit<SyncEvent, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO sync_events (instance_id, sync_id, source, wix_contact_id, hubspot_contact_id, action, reason,
           fields, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instanceId,
        e.syncId,
        e.source,
        e.wixContactId,
        e.hubspotContactId,
        e.action,
        e.reason,
        e.fields.join(','),
        iso(),
      );
  }

  listSyncEvents(instanceId: string, limit = 50): SyncEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM sync_events WHERE instance_id = ? ORDER BY id DESC LIMIT ?')
        .all(instanceId, limit) as Row[]
    ).map((r) => ({
      syncId: str(r.sync_id),
      source: String(r.source),
      wixContactId: str(r.wix_contact_id),
      hubspotContactId: str(r.hubspot_contact_id),
      action: String(r.action),
      reason: str(r.reason),
      fields: r.fields ? String(r.fields).split(',') : [],
      createdAt: String(r.created_at),
    }));
  }

  getFormEventStatus(instanceId: string, submissionId: string): string | null {
    const row = this.db
      .prepare('SELECT status FROM form_events WHERE instance_id = ? AND submission_id = ?')
      .get(instanceId, submissionId) as Row | undefined;
    return row ? String(row.status) : null;
  }

  upsertFormEvent(instanceId: string, e: Omit<FormEvent, 'createdAt'>): void {
    const now = iso();
    this.db
      .prepare(
        `INSERT INTO form_events (instance_id, submission_id, form_id, form_name, status, reason, hubspot_contact_id,
           utm_source, utm_medium, utm_campaign, latency_ms, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, submission_id) DO UPDATE SET form_id = excluded.form_id,
           form_name = excluded.form_name, status = excluded.status, reason = excluded.reason,
           hubspot_contact_id = excluded.hubspot_contact_id, utm_source = excluded.utm_source,
           utm_medium = excluded.utm_medium, utm_campaign = excluded.utm_campaign,
           latency_ms = excluded.latency_ms, submitted_at = excluded.submitted_at, updated_at = excluded.updated_at`,
      )
      .run(
        instanceId,
        e.submissionId,
        e.formId,
        e.formName,
        e.status,
        e.reason,
        e.hubspotContactId,
        e.utmSource,
        e.utmMedium,
        e.utmCampaign,
        e.latencyMs,
        e.submittedAt,
        now,
        now,
      );
  }

  listFormEvents(instanceId: string, limit = 50): FormEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM form_events WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(instanceId, limit) as Row[]
    ).map((r) => ({
      submissionId: String(r.submission_id),
      formId: str(r.form_id),
      formName: str(r.form_name),
      status: String(r.status),
      reason: str(r.reason),
      hubspotContactId: str(r.hubspot_contact_id),
      utmSource: str(r.utm_source),
      utmMedium: str(r.utm_medium),
      utmCampaign: str(r.utm_campaign),
      latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
      submittedAt: str(r.submitted_at),
      createdAt: String(r.created_at),
    }));
  }

  // ---- attribution -------------------------------------------------------------

  addAttributionTouch(
    instanceId: string,
    t: { emailHash: string; first: unknown; last: unknown; pageUrl: string | null; referrer: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO attribution_touches (instance_id, email_hash, first_json, last_json, page_url, referrer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instanceId,
        t.emailHash,
        t.first ? JSON.stringify(t.first) : null,
        t.last ? JSON.stringify(t.last) : null,
        t.pageUrl,
        t.referrer,
        Date.now(),
      );
  }

  findAttributionTouch(
    instanceId: string,
    emailHash: string,
    sinceMs: number,
  ): { first: Record<string, string> | null; last: Record<string, string> | null; pageUrl: string | null; referrer: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM attribution_touches WHERE instance_id = ? AND email_hash = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(instanceId, emailHash, sinceMs) as Row | undefined;
    if (!row) return null;
    return {
      first: row.first_json ? JSON.parse(String(row.first_json)) : null,
      last: row.last_json ? JSON.parse(String(row.last_json)) : null,
      pageUrl: str(row.page_url),
      referrer: str(row.referrer),
    };
  }

  // ---- OAuth state (one-time nonces) -----------------------------------------------

  saveOAuthState(nonce: string, instanceId: string, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO oauth_states (nonce, instance_id, expires_at) VALUES (?, ?, ?)')
      .run(nonce, instanceId, expiresAt);
  }

  /** Returns the instance id if the nonce exists and is unexpired; the nonce is deleted either way. */
  consumeOAuthState(nonce: string): string | null {
    const row = this.db.prepare('SELECT * FROM oauth_states WHERE nonce = ?').get(nonce) as Row | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM oauth_states WHERE nonce = ?').run(nonce);
    return Number(row.expires_at) > Date.now() ? String(row.instance_id) : null;
  }

  // ---- jobs -------------------------------------------------------------------------

  enqueueJob(instanceId: string, type: string, payload: object, dedupeKey: string | null, runAt: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (instance_id, type, dedupe_key, payload_json, status, attempts, run_at, created_at,
           updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(instanceId, type, dedupeKey, JSON.stringify(payload), runAt, now, now);
  }

  claimJobs(limit: number, busyKeys: Set<string>): Job[] {
    const candidates = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT ?`)
      .all(Date.now(), limit + busyKeys.size + 10) as Row[];
    const claimed: Job[] = [];
    for (const r of candidates) {
      if (claimed.length >= limit) break;
      const key = str(r.dedupe_key);
      if (key && busyKeys.has(key)) continue;
      const res = this.db
        .prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(Date.now(), Number(r.id));
      if (Number(res.changes) !== 1) continue;
      claimed.push({
        id: Number(r.id),
        instanceId: String(r.instance_id),
        type: String(r.type),
        dedupeKey: key,
        payload: JSON.parse(String(r.payload_json)),
        attempts: Number(r.attempts),
      });
    }
    return claimed;
  }

  /** Marks a job done and drops its payload (which may contain form data). */
  completeJob(id: number): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'done', payload_json = '{}', updated_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }

  failJob(id: number, attempts: number, error: string, retryAt: number | null): void {
    try {
      this.db
        .prepare('UPDATE jobs SET status = ?, attempts = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?')
        .run(retryAt ? 'pending' : 'failed', attempts, error.slice(0, 500), retryAt ?? Date.now(), Date.now(), id);
    } catch {
      // A newer pending job with the same dedupe key exists; it supersedes this one.
      this.db
        .prepare(`UPDATE jobs SET status = 'done', payload_json = '{}', last_error = 'coalesced', updated_at = ? WHERE id = ?`)
        .run(Date.now(), id);
    }
  }

  resetRunningJobs(): void {
    const running = this.db.prepare(`SELECT id FROM jobs WHERE status = 'running'`).all() as Row[];
    for (const r of running) this.failJob(Number(r.id), 0, 'interrupted', Date.now());
  }

  jobStats(instanceId: string): { pending: number; failed: number } {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM jobs WHERE instance_id = ? AND status IN ('pending', 'running', 'failed')
         GROUP BY status`,
      )
      .all(instanceId) as Row[];
    const count = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0);
    return { pending: count('pending') + count('running'), failed: count('failed') };
  }

  /** Housekeeping: expired dedupe entries, nonces, old jobs/events/touches. */
  purge(): void {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM recent_writes WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
    this.db.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`).run(now - day);
    this.db.prepare(`DELETE FROM jobs WHERE status = 'failed' AND updated_at < ?`).run(now - 14 * day);
    this.db.prepare('DELETE FROM attribution_touches WHERE created_at < ?').run(now - 30 * day);
    this.db.prepare('DELETE FROM sync_events WHERE created_at < ?').run(new Date(now - 30 * day).toISOString());
  }
}
