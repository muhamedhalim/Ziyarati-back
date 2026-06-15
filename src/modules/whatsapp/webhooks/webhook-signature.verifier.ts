import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WhatsApp Cloud API webhook security.
 *
 * Two responsibilities:
 *  1. `verify()` — validate the `X-Hub-Signature-256` header. Meta signs the
 *     EXACT raw request bytes with the App Secret (HMAC-SHA256). We therefore
 *     hash the raw `Buffer` (never a JSON-re-serialized DTO — key order /
 *     whitespace would differ and never match) and compare in constant time.
 *  2. `resolveChallenge()` — the GET verification handshake: echo `hub.challenge`
 *     only when `hub.mode === 'subscribe'` and `hub.verify_token` matches the
 *     configured token (constant-time compare).
 *
 * Secrets come from configuration ONLY (`WHATSAPP_APP_SECRET`,
 * `WHATSAPP_VERIFY_TOKEN`) — never from the DB or the request. There is NO
 * dev "accept everything" bypass: a missing secret fails closed (rejects), which
 * is the correct posture for a production multi-tenant ingestion layer.
 *
 * This class is intentionally a thin, single-responsibility security seam so it
 * stays trivially unit-testable and can be swapped for a per-provider adapter
 * later without touching ingestion business logic.
 */
@Injectable()
export class WebhookSignatureVerifier {
  private readonly logger = new Logger('WebhookSignatureVerifier');

  constructor(private readonly config: ConfigService) {}

  /**
   * @param signatureHeader value of `X-Hub-Signature-256`, e.g. `sha256=<hex>`
   * @param rawBody exact raw request body bytes (from `req.rawBody`)
   * @returns true only if the HMAC-SHA256 of `rawBody` under the app secret
   *          matches the header. Fails closed on any missing/malformed input.
   */
  verify(signatureHeader: string | undefined, rawBody: Buffer | undefined): boolean {
    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) {
      // Fail closed — do NOT accept unverified webhooks just because the secret
      // is unset. (No environment/secret values are logged.)
      this.logger.error('WHATSAPP_APP_SECRET is not configured — rejecting webhook');
      return false;
    }

    if (!signatureHeader) {
      this.logger.warn('Rejected webhook: missing X-Hub-Signature-256 header');
      return false;
    }

    if (!rawBody || rawBody.length === 0) {
      this.logger.warn('Rejected webhook: missing raw request body');
      return false;
    }

    const separatorIndex = signatureHeader.indexOf('=');
    const scheme = separatorIndex === -1 ? '' : signatureHeader.slice(0, separatorIndex);
    const provided = separatorIndex === -1 ? '' : signatureHeader.slice(separatorIndex + 1);
    if (scheme !== 'sha256' || provided.length === 0) {
      this.logger.warn('Rejected webhook: malformed signature header');
      return false;
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const ok = this.timingSafeEqualHex(provided, expected);
    if (!ok) {
      this.logger.warn('Rejected webhook: signature mismatch');
    }
    return ok;
  }

  /**
   * WhatsApp GET verification handshake. Returns the challenge to echo, or null
   * if verification fails (caller responds 403). Inputs are trimmed defensively;
   * the token comparison is constant-time.
   */
  resolveChallenge(
    mode: string | undefined,
    verifyToken: string | undefined,
    challenge: string | undefined,
    expectedToken: string | undefined,
  ): string | null {
    const expected = expectedToken?.trim();
    if (!expected) {
      this.logger.error('WHATSAPP_VERIFY_TOKEN is not configured — rejecting handshake');
      return null;
    }

    const presentedMode = mode?.trim();
    const presentedToken = verifyToken?.trim();
    if (
      presentedMode === 'subscribe' &&
      !!presentedToken &&
      this.timingSafeEqualUtf8(presentedToken, expected)
    ) {
      // Meta expects the raw challenge echoed back verbatim.
      return challenge ?? '';
    }

    this.logger.warn('Webhook verification handshake failed (mode/token mismatch)');
    return null;
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Constant-time comparison of two hex-encoded digests of equal byte length. */
  private timingSafeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    // Length is not secret; guard before timingSafeEqual (which throws on mismatch).
    if (ab.length === 0 || ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }

  /** Constant-time comparison of two UTF-8 strings. */
  private timingSafeEqualUtf8(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }
}
