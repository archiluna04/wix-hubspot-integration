/**
 * Wix delivers webhooks as an RS256-signed JWT (request body). The JWT's `data` claim is
 * a JSON string: { eventType, instanceId, data: <JSON string>, identity: <JSON string> }.
 */
import { importSPKI, jwtVerify } from 'jose';

export interface WixWebhookEnvelope {
  eventType: string;
  instanceId: string;
  data: Record<string, unknown>;
  identity?: { identityType?: string; appId?: string };
}

const parseMaybeJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v); // eslint-disable-line @typescript-eslint/no-explicit-any

function toPem(key: string): string {
  const trimmed = key.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) return trimmed;
  return `-----BEGIN PUBLIC KEY-----\n${trimmed.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
}

export class WixWebhookVerifier {
  private key: ReturnType<typeof importSPKI> | undefined;

  constructor(private readonly publicKey: string) {}

  async verify(token: string): Promise<WixWebhookEnvelope> {
    this.key ??= importSPKI(toPem(this.publicKey), 'RS256');
    const { payload } = await jwtVerify(token.trim(), await this.key, { algorithms: ['RS256'] });
    const outer = parseMaybeJson(payload.data);
    if (!outer?.eventType || !outer?.instanceId) throw new Error('Malformed Wix webhook');
    return {
      eventType: String(outer.eventType),
      instanceId: String(outer.instanceId),
      data: parseMaybeJson(outer.data) ?? {},
      identity: outer.identity ? parseMaybeJson(outer.identity) : undefined,
    };
  }
}

/** Extracts entity id + entity body from a Wix domain event (created/updated/deleted). */
export function entityFromEvent(data: Record<string, any>): { entityId?: string; entity?: any } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const raw =
    data?.createdEvent?.entityAsJson ??
    data?.createdEvent?.entity ??
    data?.updatedEvent?.currentEntityAsJson ??
    data?.updatedEvent?.currentEntity ??
    data?.entity;
  const entity = parseMaybeJson(raw);
  const entityId = data?.entityId ?? entity?.id;
  return { entityId: entityId ? String(entityId) : undefined, entity };
}
