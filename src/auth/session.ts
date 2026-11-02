/**
 * Short-lived HS256 tokens:
 *  - dashboard sessions (issued after the Wix instance is verified, sent as a Bearer token,
 *    so it works inside the third-party Wix dashboard iframe without cookies);
 *  - OAuth `state` values for the HubSpot connect flow (bound to the instance + one-time nonce).
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { SignJWT, jwtVerify } from 'jose';

const SESSION_AUDIENCE = 'wix-hubspot-dashboard';
const STATE_AUDIENCE = 'hubspot-oauth-state';

export class SessionService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  issueSession(instanceId: string, ttlSeconds = 3600): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(instanceId)
      .setAudience(SESSION_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verifySession(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.key, { audience: SESSION_AUDIENCE, algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('missing subject');
    return payload.sub;
  }

  async issueOAuthState(instanceId: string): Promise<{ state: string; nonce: string; expiresAt: number }> {
    const nonce = randomUUID();
    const expiresAt = Date.now() + 10 * 60_000;
    const state = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(instanceId)
      .setJti(nonce)
      .setAudience(STATE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(this.key);
    return { state, nonce, expiresAt };
  }

  async verifyOAuthState(state: string): Promise<{ instanceId: string; nonce: string }> {
    const { payload } = await jwtVerify(state, this.key, { audience: STATE_AUDIENCE, algorithms: ['HS256'] });
    if (!payload.sub || !payload.jti) throw new Error('invalid state');
    return { instanceId: payload.sub, nonce: payload.jti };
  }
}

/** Requires `Authorization: Bearer <session>` and exposes `res.locals.instanceId`. */
export function requireSession(sessions: SessionService): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      res.locals.instanceId = await sessions.verifySession(token);
      next();
    } catch {
      res.status(401).json({ error: 'Session expired' });
    }
  };
}
