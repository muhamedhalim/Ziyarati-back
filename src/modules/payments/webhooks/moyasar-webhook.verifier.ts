import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/**
 * Moyasar webhook authenticity check.
 *
 * Moyasar authenticates webhooks with a shared `secret_token` that you set when
 * registering the webhook. We compare the token presented on the request
 * (header `x-moyasar-token` or the body's `secret_token`) against the
 * platform-level `MOYASAR_WEBHOOK_SECRET`, using a constant-time comparison to
 * avoid timing leaks.
 *
 * Dev fallback: when no secret is configured the check accepts (and logs a
 * warning), mirroring the existing WhatsApp verifier so the flow is runnable
 * locally. Configure the secret in any real environment.
 *
 * The signing secret is platform configuration only — it is never stored per
 * tenant nor exposed to the tenant layer.
 */
@Injectable()
export class MoyasarWebhookVerifier {
  private readonly logger = new Logger('MoyasarWebhookVerifier');

  constructor(private readonly config: ConfigService) {}

  verify(providedToken: string | undefined): boolean {
    const expected = this.config.get<string>('MOYASAR_WEBHOOK_SECRET') ?? '';

    if (!expected) {
      this.logger.warn(
        'MOYASAR_WEBHOOK_SECRET not configured — accepting webhook (dev only)',
      );
      return true;
    }

    if (!providedToken) {
      return false;
    }

    return this.constantTimeEqual(providedToken, expected);
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // timingSafeEqual throws on length mismatch — guard first (length is not secret).
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }
}
