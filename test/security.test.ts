import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth/session.js';
import { verifyWixInstance } from '../src/auth/wixInstance.js';
import { openDatabase } from '../src/db.js';
import { parseHubSpotEvents, verifyHubSpotSignatureV3 } from '../src/hubspot/webhooks.js';
import { redact, scrub } from '../src/lib/logger.js';
import { LocalEncryptedSecretStore } from '../src/secrets/secretStore.js';

describe('HubSpot v3 webhook signature', () => {
  const clientSecret = 'secret-123';
  const url = 'https://app.example.com/webhooks/hubspot';
  const rawBody = '[{"objectId":1}]';
  const sign = (ts: string) =>
    createHmac('sha256', clientSecret).update(`POST${url}${rawBody}${ts}`).digest('base64');

  it('accepts a valid, fresh signature', () => {
    const ts = String(Date.now());
    expect(verifyHubSpotSignatureV3({ clientSecret, method: 'POST', url, rawBody, timestamp: ts, signature: sign(ts) })).toBe(true);
  });
  it('rejects a tampered body', () => {
    const ts = String(Date.now());
    expect(
      verifyHubSpotSignatureV3({ clientSecret, method: 'POST', url, rawBody: '[]', timestamp: ts, signature: sign(ts) }),
    ).toBe(false);
  });
  it('rejects replayed (stale) requests', () => {
    const ts = String(Date.now() - 10 * 60_000);
    expect(verifyHubSpotSignatureV3({ clientSecret, method: 'POST', url, rawBody, timestamp: ts, signature: sign(ts) })).toBe(false);
  });
});

describe('HubSpot webhook parsing', () => {
  it('accepts legacy contact events and normalizes generic object events for contacts only', () => {
    const events = parseHubSpotEvents(
      JSON.stringify([
        { eventId: 1, subscriptionType: 'contact.propertyChange', portalId: 1, objectId: 10, propertyName: 'email' },
        { eventId: 2, subscriptionType: 'object.creation', objectTypeId: '0-1', portalId: 1, objectId: 11 },
        { eventId: 3, subscriptionType: 'object.creation', objectTypeId: '0-2', portalId: 1, objectId: 12 },
      ]),
    );
    expect(events.map((e) => [e.subscriptionType, e.objectId])).toEqual([
      ['contact.propertyChange', 10],
      ['contact.creation', 11],
    ]);
  });
});

describe('Wix instance verification', () => {
  const secret = 'wix-app-secret';
  const make = (data: object, key = secret) => {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const sig = createHmac('sha256', key).update(payload).digest('base64url');
    return `${sig}.${payload}`;
  };

  it('accepts a correctly signed instance', () => {
    const inst = make({ instanceId: 'abc', appDefId: 'app', signDate: new Date().toISOString() });
    expect(verifyWixInstance(inst, secret, { appId: 'app', maxAgeMs: 60_000 }).instanceId).toBe('abc');
  });
  it('rejects a forged signature, another app, or an expired instance', () => {
    expect(() => verifyWixInstance(make({ instanceId: 'abc' }, 'other'), secret)).toThrow(/bad signature/);
    expect(() => verifyWixInstance(make({ instanceId: 'abc', appDefId: 'evil' }), secret, { appId: 'app' })).toThrow(/wrong app/);
    expect(() =>
      verifyWixInstance(make({ instanceId: 'abc', signDate: '2020-01-01T00:00:00Z' }), secret, { maxAgeMs: 60_000 }),
    ).toThrow(/expired/);
  });
});

describe('sessions and OAuth state', () => {
  const sessions = new SessionService('x'.repeat(40));
  it('round-trips a session and rejects a state token used as a session', async () => {
    const token = await sessions.issueSession('site-1');
    expect(await sessions.verifySession(token)).toBe('site-1');
    const { state } = await sessions.issueOAuthState('site-1');
    await expect(sessions.verifySession(state)).rejects.toThrow();
    expect((await sessions.verifyOAuthState(state)).instanceId).toBe('site-1');
  });
});

describe('encrypted secret store', () => {
  it('encrypts at rest and decrypts', async () => {
    const db = openDatabase(':memory:');
    const store = new LocalEncryptedSecretStore(db, randomBytes(32).toString('base64'));
    await store.put('hubspot-oauth-site', '{"accessToken":"super-secret"}');
    const raw = db.prepare('SELECT ciphertext FROM secrets').get() as { ciphertext: string };
    expect(raw.ciphertext).not.toContain('super-secret');
    expect(await store.get('hubspot-oauth-site')).toBe('{"accessToken":"super-secret"}');
    await store.delete('hubspot-oauth-site');
    expect(await store.get('hubspot-oauth-site')).toBeNull();
  });
});

describe('safe logging', () => {
  it('redacts tokens and PII', () => {
    const out = redact({
      accessToken: 'abc',
      email: 'ada@example.com',
      nested: { refresh_token: 'r', note: 'contact ada@example.com', firstname: 'Ada' },
      instanceId: 'site-1',
    }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.accessToken).toBe('[redacted]');
    expect(out.email).toBe('[redacted]');
    expect(out.nested.refresh_token).toBe('[redacted]');
    expect(out.nested.firstname).toBe('[redacted]');
    expect(out.nested.note).toBe('contact [email]');
    expect(out.instanceId).toBe('site-1');
    expect(scrub('Authorization: Bearer eyJhbGciOi.abc.def')).toBe('Authorization: Bearer [redacted]');
  });
});
