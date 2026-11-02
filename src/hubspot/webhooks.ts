import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 5 * 60_000;

/**
 * Validates HubSpot's v3 request signature:
 * base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)), rejecting requests
 * older than 5 minutes (replay protection).
 */
export function verifyHubSpotSignatureV3(input: {
  clientSecret: string;
  method: string;
  url: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  now?: number;
}): boolean {
  const { signature, timestamp } = input;
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs((input.now ?? Date.now()) - ts) > MAX_AGE_MS) return false;
  const expected = createHmac('sha256', input.clientSecret)
    .update(`${input.method}${input.url}${input.rawBody}${timestamp}`, 'utf8')
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HubSpotWebhookEvent {
  eventId: number;
  subscriptionType: string;
  portalId: number;
  objectId: number;
  propertyName?: string;
  changeSource?: string;
  occurredAt: number;
  objectTypeId?: string;
}

const CONTACT_OBJECT_TYPE_ID = '0-1';

/**
 * Parses a webhook batch. Project-based apps may use the generic format
 * ("object.creation" + objectTypeId "0-1"); those are normalized to "contact.creation" etc.
 */
export function parseHubSpotEvents(rawBody: string): HubSpotWebhookEvent[] {
  const parsed: unknown = JSON.parse(rawBody);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (e): e is HubSpotWebhookEvent =>
        !!e && typeof e === 'object' && typeof e.subscriptionType === 'string' && e.portalId != null && e.objectId != null,
    )
    .flatMap((e) => {
      if (!e.subscriptionType.startsWith('object.')) return [e];
      if (String(e.objectTypeId) !== CONTACT_OBJECT_TYPE_ID) return [];
      return [{ ...e, subscriptionType: e.subscriptionType.replace(/^object\./, 'contact.') }];
    });
}
