import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { EmailSuppressionService } from './email-suppression.service';

export interface UnsubscribeTarget {
  tenantId: string;
  /** Already normalized (lowercased/trimmed) — see `EmailSuppressionService.normalize`. */
  email: string;
}

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T134).
 *
 * STATELESS, deterministic HMAC token — no database row per token, unlike
 * `PatientActionLinkService`'s random-secret links. Deliberate: an
 * unsubscribe link must keep working PERMANENTLY (the task's own "works
 * without signing in, permanently" requirement), and it is embedded in every
 * marketing email sent, so a DB-issued-and-stored token per send would mean
 * either one link per email (fine) or reusing one link across a clinic's
 * entire history (needs the same deterministic property this already gives
 * for free). The token encodes ONLY (tenantId, email) — the task's "reveals
 * no other customer data" requirement — recomputed identically here and
 * embedded into `campaign_marketing`'s footer link (T131/T132), so nothing is
 * ever looked up by token; the token IS the (tenant, email) pair, integrity-
 * protected by the HMAC tag so it cannot be forged or altered client-side.
 */
@Injectable()
export class UnsubscribeTokenService {
  private readonly logger = new Logger(UnsubscribeTokenService.name);

  constructor(private readonly config: ConfigService) {}

  issue(tenantId: string, email: string): string {
    const normalized = EmailSuppressionService.normalize(email);
    const payload = `${tenantId}:${normalized}`;
    const tag = this.tagFor(payload);
    return Buffer.from(`${payload}:${tag}`, 'utf8').toString('base64url');
  }

  /**
   * Returns the (tenant, email) pair the token authorises, or `null` for
   * EVERY invalid case (malformed, tampered, unknown format) — deliberately
   * indistinguishable, matching `PatientActionLinkService.resolve`'s
   * uniform-failure convention.
   */
  verify(token: string): UnsubscribeTarget | null {
    let decoded: string;
    try {
      decoded = Buffer.from(token, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon <= 0) return null;
    const payload = decoded.slice(0, lastColon);
    const presentedTag = decoded.slice(lastColon + 1);
    const firstColon = payload.indexOf(':');
    if (firstColon <= 0) return null;

    const expectedTag = this.tagFor(payload);
    if (!this.constantTimeEqual(presentedTag, expectedTag)) return null;

    const tenantId = payload.slice(0, firstColon);
    const email = payload.slice(firstColon + 1);
    if (!tenantId || !email) return null;
    return { tenantId, email };
  }

  private tagFor(payload: string): string {
    const secret = this.secret();
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  private secret(): string {
    const dedicated = this.config.get<string>('EMAIL_UNSUBSCRIBE_SECRET');
    if (dedicated) return dedicated;
    const fallback = this.config.get<string>('JWT_ACCESS_SECRET');
    if (!fallback) {
      // Should be unreachable — JWT_ACCESS_SECRET is a required env var — but
      // fail closed rather than sign with an empty/undefined key.
      this.logger.error(
        'Neither EMAIL_UNSUBSCRIBE_SECRET nor JWT_ACCESS_SECRET is configured',
      );
      throw new Error('No secret configured for unsubscribe token signing');
    }
    return fallback;
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length === 0 || ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
