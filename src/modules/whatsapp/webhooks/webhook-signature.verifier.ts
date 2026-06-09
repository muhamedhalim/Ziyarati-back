import { Injectable, Logger } from '@nestjs/common';

/**
 * Webhook signature verification abstraction.
 *
 * Schema note: `whatsapp_webhooks` stores inbound EVENTS only — there is no
 * column for a per-tenant webhook secret or callback URL. The signing secret /
 * verify-token therefore come from configuration (env), not the DB. This is the
 * single seam where a real adapter validates the `X-Hub-Signature-256` header
 * (HMAC-SHA256 of the raw body with the app secret).
 *
 * The default implementation accepts everything (dev) — replace by binding a
 * real verifier; business logic (ingestion) is unaffected.
 */
@Injectable()
export class WebhookSignatureVerifier {
  private readonly logger = new Logger('WebhookSignatureVerifier');

  /**
   * @param _signatureHeader e.g. `sha256=...`
   * @param _rawBody raw request body used to compute the HMAC
   * @returns true if the signature is valid (default: true)
   */
  verify(_signatureHeader: string | undefined, _rawBody: unknown): boolean {
    // Abstraction point only — a real adapter would compute the HMAC and
    // timing-safe compare it against `_signatureHeader`.
    return true;
  }

  /**
   * WhatsApp GET verification handshake: echo `hub.challenge` when the token
   * matches the configured verify token. Returns null if it does not match.
   */
  resolveChallenge(
    mode: string | undefined,
    verifyToken: string | undefined,
    challenge: string | undefined,
    expectedToken: string | undefined,
  ): string | null {
    if (mode === 'subscribe' && verifyToken && verifyToken === expectedToken) {
      return challenge ?? '';
    }
    this.logger.warn('Webhook verification handshake failed (token mismatch)');
    return null;
  }
}
