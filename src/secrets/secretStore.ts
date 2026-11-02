/**
 * Secret storage for OAuth tokens.
 *  - GcpSecretManagerStore: Google Cloud Secret Manager. Every token refresh adds a new
 *    secret version and destroys the previous ones (rotation).
 *  - LocalEncryptedSecretStore: AES-256-GCM encrypted at rest in SQLite, for local dev or
 *    hosts without a managed secret store. The key never touches the database.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';

export interface SecretStore {
  readonly kind: string;
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class LocalEncryptedSecretStore implements SecretStore {
  readonly kind = 'local-aes-256-gcm';
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseSync,
    keyBase64: string,
  ) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }

  async put(name: string, value: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const blob = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(
      '.',
    );
    this.db
      .prepare(
        `INSERT INTO secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      )
      .run(name, blob, new Date().toISOString());
  }

  async get(name: string): Promise<string | null> {
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE name = ?').get(name) as
      | { ciphertext: string }
      | undefined;
    if (!row) return null;
    const [version, iv, tag, data] = row.ciphertext.split('.');
    if (version !== 'v1') throw new Error('Unsupported secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  async delete(name: string): Promise<void> {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }
}

// gRPC status codes used by the Secret Manager client.
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class GcpSecretManagerStore implements SecretStore {
  readonly kind = 'gcp-secret-manager';
  private client: Promise<any> | undefined;

  constructor(private readonly projectId: string) {}

  private getClient(): Promise<any> {
    // Optional dependency: loaded only when SECRET_STORE=gcp.
    const pkg = '@google-cloud/secret-manager';
    this.client ??= import(pkg).then((m: any) => new m.SecretManagerServiceClient());
    return this.client;
  }

  private secretPath(name: string): string {
    return `projects/${this.projectId}/secrets/${name}`;
  }

  async put(name: string, value: string): Promise<void> {
    const client = await this.getClient();
    try {
      await client.createSecret({
        parent: `projects/${this.projectId}`,
        secretId: name,
        secret: { replication: { automatic: {} }, labels: { app: 'wix-hubspot-integration' } },
      });
    } catch (err: any) {
      if (err?.code !== ALREADY_EXISTS) throw err;
    }
    const [version] = await client.addSecretVersion({
      parent: this.secretPath(name),
      payload: { data: Buffer.from(value, 'utf8') },
    });
    // Rotation: only the newest version stays usable.
    const [versions] = await client.listSecretVersions({ parent: this.secretPath(name), filter: 'state:ENABLED' });
    await Promise.all(
      (versions as Array<{ name: string }>)
        .filter((v) => v.name !== version.name)
        .map((v) => client.destroySecretVersion({ name: v.name })),
    );
  }

  async get(name: string): Promise<string | null> {
    const client = await this.getClient();
    try {
      const [res] = await client.accessSecretVersion({ name: `${this.secretPath(name)}/versions/latest` });
      return Buffer.from(res.payload.data).toString('utf8');
    } catch (err: any) {
      if (err?.code === NOT_FOUND) return null;
      throw err;
    }
  }

  async delete(name: string): Promise<void> {
    const client = await this.getClient();
    try {
      await client.deleteSecret({ name: this.secretPath(name) });
    } catch (err: any) {
      if (err?.code !== NOT_FOUND) throw err;
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function createSecretStore(config: AppConfig, db: DatabaseSync): SecretStore {
  return config.SECRET_STORE === 'gcp'
    ? new GcpSecretManagerStore(config.GCP_PROJECT_ID!)
    : new LocalEncryptedSecretStore(db, config.TOKEN_ENCRYPTION_KEY!);
}
