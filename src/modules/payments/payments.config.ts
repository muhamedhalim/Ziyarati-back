import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Typed accessor for the PLATFORM-level payments configuration.
 *
 * Mirrors the MetaConfig pattern: every payment-related env variable is
 * resolved through here rather than scattered `config.get()` calls, so there is
 * exactly one place that knows the variable names, one place that decides what
 * is secret, and one place that reasons about "is the gateway live?".
 *
 * Scope boundary:
 *  - `.env` holds ONLY platform-level gateway credentials (one Moyasar account
 *    owned by the platform). Tenants NEVER supply gateway credentials.
 *  - Secrets (secret key, webhook secret) are read by the Moyasar adapter and
 *    webhook verifier only — never returned by any API, never logged.
 *
 * Startup safety: `src/config/env.validation.ts` fails the boot in production
 * when `PAYMENT_PROVIDER` names a real gateway whose essential variables are
 * missing. This class additionally exposes `gatewayConfigured` so runtime
 * seams (factory guard) can fail CLOSED instead of falling back to the Noop
 * simulator in production.
 */
@Injectable()
export class PaymentsConfig {
  private readonly logger = new Logger('PaymentsConfig');

  constructor(private readonly config: ConfigService) {}

  /** Active gateway name (`PAYMENT_PROVIDER`, default `moyasar`). */
  get providerName(): string {
    return (this.trimmed('PAYMENT_PROVIDER') ?? 'moyasar').toLowerCase();
  }

  get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  /**
   * TRUE when the platform intends to move real money: production runtime with
   * a real (non-noop) provider selected. Merchant-eligibility gating and the
   * factory's anti-simulation guard key off this — dev/test keep the Noop
   * end-to-end flow with no keys and no network calls.
   */
  get paymentsLive(): boolean {
    return this.isProduction && this.providerName !== 'noop';
  }

  // ── Moyasar (SECRET values never leave the adapter/verifier) ──────────────

  get moyasarSecretKey(): string | undefined {
    return this.trimmed('MOYASAR_SECRET_KEY');
  }

  /** Publishable key — safe for the browser (client-side form / tokenization). */
  get moyasarPublishableKey(): string | undefined {
    return this.trimmed('MOYASAR_PUBLISHABLE_KEY');
  }

  get moyasarWebhookSecret(): string | undefined {
    return this.trimmed('MOYASAR_WEBHOOK_SECRET');
  }

  get moyasarApiBase(): string {
    return this.trimmed('MOYASAR_API_BASE') ?? 'https://api.moyasar.com/v1';
  }

  /** TRUE when the selected real gateway has its essential credential set. */
  get gatewayConfigured(): boolean {
    if (this.providerName === 'noop') return true;
    if (this.providerName === 'moyasar') return !!this.moyasarSecretKey;
    return false;
  }

  /**
   * Marketplace split payments (`splits` on Moyasar Create Payment) require a
   * commercial "Moyasar for Platforms" contract and per-clinic recipient ids
   * issued by Moyasar. OFF by default: a technically-supported feature is not
   * assumed to be contractually enabled. When OFF, the money lands in the
   * platform account and the internal ledger still tracks each clinic's net
   * (settled via the settlements flow); when ON, an approved clinic's
   * `provider_recipient_id` is attached as a split recipient.
   */
  get marketplaceSplitsEnabled(): boolean {
    return this.config.get<string>('MOYASAR_MARKETPLACE_ENABLED') === 'true';
  }

  // ── Reconciliation sweep knobs ────────────────────────────────────────────

  /** Minutes before a PENDING payment becomes eligible for reconciliation. */
  get reconStaleMinutes(): number {
    return this.positiveInt('PAYMENTS_RECON_STALE_MIN', 15);
  }

  /** Minutes after which a still-unresolved PENDING payment pages an operator. */
  get reconHardAlertMinutes(): number {
    return this.positiveInt('PAYMENTS_RECON_HARDFAIL_MIN', 240);
  }

  private positiveInt(key: string, fallback: number): number {
    const raw = Number(this.config.get<string>(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  private trimmed(key: string): string | undefined {
    const value = this.config.get<string>(key)?.trim();
    return value ? value : undefined;
  }
}
