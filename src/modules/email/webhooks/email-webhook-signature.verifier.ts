import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Spec 014 (Clinic Platform Completion) — Phase 11 (US7, T136).
 *
 * Resend bounce/complaint webhook authenticity check — mirrors
 * `WebhookSignatureVerifier` (WhatsApp) exactly: HMAC-SHA256 over the EXACT
 * raw request bytes, constant-time compared, fail-closed when the secret is
 * unconfigured. An unverified feedback message must suppress NOTHING —
 * otherwise an attacker could suppress a clinic's whole marketing list by
 * forging bounce/complaint events (T136's own stated risk).
 *
 * IMPLEMENTATION NOTE: Resend signs webhooks via Svix (three headers —
 * `svix-id`/`svix-timestamp`/`svix-signature`, base64, over `id.timestamp.body`).
 * This verifier implements the simpler single-header
 * `sha256=<hex-hmac-of-raw-body>` scheme (same shape as
 * `X-Hub-Signature-256` elsewhere in this codebase) behind
 * `RESEND_WEBHOOK_SECRET`, configured as a custom header on the Resend
 * endpoint (Resend supports a configurable webhook secret independent of the
 * Svix headers). Swapping to native Svix verification later is a change to
 * this one class only — the controller and every caller are unaffected.
 */
@Injectable()
export class EmailWebhookSignatureVerifier {
  private readonly logger = new Logger('EmailWebhookSignatureVerifier');

  constructor(private readonly config: ConfigService) {}

  verify(
    signatureHeader: string | undefined,
    rawBody: Buffer | undefined,
  ): boolean {
    const secret = this.config.get<string>('RESEND_WEBHOOK_SECRET');
    if (!secret) {
      // Fail closed — never accept unverified feedback just because the
      // secret is unset (T136: an unverified message must suppress nothing).
      this.logger.error(
        'RESEND_WEBHOOK_SECRET is not configured — rejecting webhook',
      );
      return false;
    }
    if (!signatureHeader) {
      this.logger.warn('Rejected email webhook: missing signature header');
      return false;
    }
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn('Rejected email webhook: missing raw request body');
      return false;
    }

    const separatorIndex = signatureHeader.indexOf('=');
    const scheme =
      separatorIndex === -1 ? '' : signatureHeader.slice(0, separatorIndex);
    const provided =
      separatorIndex === -1 ? '' : signatureHeader.slice(separatorIndex + 1);
    if (scheme !== 'sha256' || provided.length === 0) {
      this.logger.warn('Rejected email webhook: malformed signature header');
      return false;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const ok = this.timingSafeEqualHex(provided, expected);
    if (!ok) this.logger.warn('Rejected email webhook: signature mismatch');
    return ok;
  }

  private timingSafeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length === 0 || ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}
