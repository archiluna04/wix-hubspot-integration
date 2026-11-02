import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS installations (
  instance_id TEXT PRIMARY KEY,
  site_key TEXT NOT NULL UNIQUE,
  hubspot_portal_id TEXT,
  hubspot_scopes TEXT,
  hubspot_connected_at TEXT,
  hubspot_properties_ready INTEGER NOT NULL DEFAULT 0,
  script_embedded INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS installations_portal ON installations(hubspot_portal_id);

CREATE TABLE IF NOT EXISTS field_mappings (
  instance_id TEXT PRIMARY KEY,
  rows_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- External ID mapping (WixContactId <-> HubSpotContactId) plus the last values synced
-- on each side, which is what makes loop prevention and idempotency work.
CREATE TABLE IF NOT EXISTS contact_links (
  instance_id TEXT NOT NULL,
  wix_contact_id TEXT NOT NULL,
  hubspot_contact_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  last_sync_id TEXT,
  last_sync_source TEXT,
  last_synced_at TEXT,
  PRIMARY KEY (instance_id, wix_contact_id),
  UNIQUE (instance_id, hubspot_contact_id)
);

-- Dedupe window: hashes of what we just wrote, so the echo webhook can be ignored.
CREATE TABLE IF NOT EXISTS recent_writes (
  instance_id TEXT NOT NULL,
  system TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (instance_id, system, contact_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  dedupe_key TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_pending_dedupe ON jobs(dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  sync_id TEXT,
  source TEXT NOT NULL,
  wix_contact_id TEXT,
  hubspot_contact_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  fields TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_events_instance ON sync_events(instance_id, id);

-- Observability for form capture. Deliberately stores no PII (no email/name/field values).
CREATE TABLE IF NOT EXISTS form_events (
  instance_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  form_id TEXT,
  form_name TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  hubspot_contact_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  latency_ms INTEGER,
  submitted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, submission_id)
);

-- UTM/source touches reported by the site script. Email is stored only as a salted hash.
CREATE TABLE IF NOT EXISTS attribution_touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  first_json TEXT,
  last_json TEXT,
  page_url TEXT,
  referrer TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attribution_lookup ON attribution_touches(instance_id, email_hash, created_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  nonce TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Used only by the local encrypted secret store (AES-256-GCM ciphertext).
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// WAL needs shared memory, which network file shares (e.g. Azure App Service /home) don't
// support reliably; use DELETE there.
export function openDatabase(path: string, journalMode: 'WAL' | 'DELETE' = 'WAL'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = ${journalMode}; PRAGMA busy_timeout = 5000;`);
  db.exec(SCHEMA);
  return db;
}
