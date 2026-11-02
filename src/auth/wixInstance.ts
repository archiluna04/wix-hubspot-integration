/**
 * Verifies the signed `instance` query parameter Wix appends to a self-hosted
 * dashboard page URL: "<signature>.<payload>", where signature =
 * base64url(HMAC-SHA256(payload, appSecret)).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WixInstance {
  instanceId: string;
  appDefId?: string;
  signDate?: string;
  uid?: string;
  permissions?: string;
  siteOwnerId?: string;
}

export class InvalidInstanceError extends Error {
  constructor(reason: string) {
    super(`Invalid Wix instance: ${reason}`);
    this.name = 'InvalidInstanceError';
  }
}

const toBuffer = (b64: string) => Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function verifyWixInstance(
  instance: string,
  appSecret: string,
  opts: { appId?: string; maxAgeMs?: number; now?: number } = {},
): WixInstance {
  const parts = instance.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidInstanceError('malformed');
  const [signature, payload] = parts;

  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const given = toBuffer(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InvalidInstanceError('bad signature');
  }

  let data: WixInstance;
  try {
    data = JSON.parse(toBuffer(payload).toString('utf8'));
  } catch {
    throw new InvalidInstanceError('unreadable payload');
  }
  if (!data.instanceId) throw new InvalidInstanceError('missing instanceId');
  if (opts.appId && data.appDefId && data.appDefId !== opts.appId) throw new InvalidInstanceError('wrong app');
  if (opts.maxAgeMs && data.signDate) {
    const age = (opts.now ?? Date.now()) - Date.parse(data.signDate);
    if (!(age <= opts.maxAgeMs)) throw new InvalidInstanceError('expired');
  }
  return data;
}
