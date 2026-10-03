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

  // ── Tap (SECRET values never leave the adapter/verifier/client) ───────────

  /**
   * Which Tap key pair is active. Defaults to `sandbox` so a missing value can
   * never silently select live money; production + `PAYMENT_PROVIDER=tap`
   * requires it to be set explicitly (env.validation.ts).
   */
  get tapEnv(): 'sandbox' | 'live' {
    return this.trimmed('TAP_ENV')?.toLowerCase() === 'live'
      ? 'live'
      : 'sandbox';
  }

  /** The dashboard "Merchant ID" — the platform's own Tap merchant account. */
  get tapMerchantId(): string | undefined {
    return this.trimmed('TAP_MERCHANT_ID');
  }

  /**
   * The secret key for the ACTIVE environment (`TAP_ENV`). Used both to call
   * the Tap API and as the HMAC key that signs Tap webhooks. Never returned by
   * any API, never logged.
   */
  get tapSecretKey(): string | undefined {
    return this.trimmed(
      this.tapEnv === 'live' ? 'TAP_LIVE_SECRET_KEY' : 'TAP_TEST_SECRET_KEY',
    );
  }

  /** `commerce_platform_…` issued by Tap on platform activation (clinic routing). */
  get tapPlatformId(): string | undefined {
    return this.trimmed('TAP_PLATFORM_ID');
  }

  /** Public HTTPS URL Tap posts webhooks to (`post.url` on every charge). */
  get tapWebhookUrl(): string | undefined {
    return this.trimmed('TAP_WEBHOOK_URL');
  }

  get tapApiBase(): string {
    return (this.trimmed('TAP_API_BASE') ?? 'https://api.tap.company').replace(
      /\/+$/,
      '',
    );
  }

  /** Per-request HTTP timeout toward Tap, milliseconds. */
  get tapRequestTimeoutMs(): number {
    return this.positiveInt('TAP_REQUEST_TIMEOUT_MS', 15_000);
  }

  /**
   * OPT-IN payable window for a hosted charge, minutes (Tap allows 5–60). Unset
   * ⇒ nothing is sent and Tap's own default (30) applies. The OpenAPI schema
   * omits this request field while a guide page documents it, so it stays off
   * until sandbox validation confirms it.
   */
  get tapChargeExpiryMinutes(): number | undefined {
    // Blank must mean "not configured": Number('') is 0, which would otherwise
    // clamp to 5 and silently opt every charge in to a 5-minute window. The
    // value may already be a NUMBER (Joi converts it during env validation), so
    // normalise through String() rather than calling string methods on it.
    const raw = this.config.get<string | number>('TAP_CHARGE_EXPIRY_MINUTES');
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return undefined;
    }
    const minutes = Number(raw);
    if (!Number.isFinite(minutes)) return undefined;
    return Math.min(60, Math.max(5, Math.round(minutes)));
  }

  /**
   * Merchant-initiated (clinic-not-present) renewals and card saving. OFF until
   * Tap has activated Save Card AND non-3DS merchant-initiated charges on the
   * account (errors 1108 / 1109): while off, a checkout is a plain one-off
   * payment (no `save_card`) and a renewal asks the clinic to pay, so nothing is
   * ever sent that Tap would reject.
   */
  get tapRecurringEnabled(): boolean {
    // Joi converts the validated value to a real boolean; a raw env string is
    // still possible when validation is bypassed (unit tests), so accept both.
    const raw = this.config.get<string | boolean>('TAP_RECURRING_ENABLED');
    return (
      raw === true ||
      String(raw ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  /**
   * Patient booking payments through Tap Platform (a charge on a clinic's own
   * merchant). OFF until Tap has activated the platform (`TAP_PLATFORM_ID`) and a
   * clinic has been onboarded and approved: while off, a booking is confirmed as
   * "pay at the clinic" and no pay link is issued.
   */
  get tapBookingPaymentsEnabled(): boolean {
    const raw = this.config.get<string | boolean>(
      'TAP_BOOKING_PAYMENTS_ENABLED',
    );
    return (
      raw === true ||
      String(raw ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  /**
   * Secret key for the Lead / Connect (clinic onboarding) calls. Tap documents a
   * separate "segment" key for those; when none is configured the active
   * merchant secret key is used. Never returned by any API, never logged.
   */
  get tapOnboardingSecretKey(): string | undefined {
    return this.trimmed('TAP_SEGMENT_SECRET_KEY') ?? this.tapSecretKey;
  }

  // ── Server-built return URLs (never client-supplied) ──────────────────────

  /**
   * Base URL for links the gateway sends the payer back to — `APP_URL`, else the
   * first `FRONTEND_ORIGIN` (same resolution the notification links use).
   */
  get appUrl(): string {
    return (
      this.trimmed('APP_URL') ??
      (this.trimmed('FRONTEND_ORIGIN') ?? 'http://localhost:3000')
        .split(',')[0]
        .trim()
    ).replace(/\/+$/, '');
  }

  /**
   * Where the gateway returns the payer after a hosted/3DS flow. The target
   * pages arrive with the phase that owns them (billing return: subscriptions;
   * public pay page: booking payments); the URL is built here so no caller —
   * and no client — ever chooses it.
   */
  paymentReturnUrl(platformRevenue: boolean): string {
    return platformRevenue
      ? `${this.appUrl}/app/billing?checkout=return`
      : `${this.appUrl}/pay/return`;
  }

  /**
   * TRUE when the public pay page can actually complete a patient's payment: Tap,
   * or any non-production environment (the simulator). In PRODUCTION only Tap
   * qualifies: the legacy Moyasar create call was never proven and has no return
   * flow, and `noop` there is "payments explicitly disabled" — a pay URL handed to
   * a patient in either case would be a dead end. When FALSE no pay URL is issued
   * and the page itself reads "unavailable"; booking behaviour for such a
   * deployment is untouched.
   */
  get patientPayPageServed(): boolean {
    return this.providerName === 'tap' || !this.isProduction;
  }

  /**
   * The durable, public pay page a patient opens from a WhatsApp / e-mail / SMS
   * message. NOT a Tap URL: a hosted Tap charge expires within the hour, so the
   * link a patient keeps is ours and mints a fresh charge when it is opened. The
   * locale is left off on purpose — the frontend proxy resolves it from the
   * patient's own cookie / browser language.
   */
  payLinkUrl(token: string): string {
    return `${this.appUrl}/pay/${encodeURIComponent(token)}`;
  }

  /** Where Tap's hosted onboarding (Connect) sends the clinic when it is done. */
  tapOnboardingReturnUrl(): string {
    return `${this.appUrl}/app/payments?onboarding=return`;
  }

  /**
   * The URL Tap posts onboarding (Connect) events to. It carries an unguessable
   * per-clinic token because Tap documents no signature for these events, so the
   * URL itself is the only thing that authenticates them. Derived from
   * `TAP_WEBHOOK_URL`; undefined while that is unset.
   */
  tapOnboardingCallbackUrl(token: string): string | undefined {
    const base = this.tapWebhookUrl?.replace(/\/+$/, '');
    return base ? `${base}/onboarding/${encodeURIComponent(token)}` : undefined;
  }

  /** TRUE when the selected real gateway has its essential credential set. */
  get gatewayConfigured(): boolean {
    if (this.providerName === 'noop') return true;
    if (this.providerName === 'moyasar') return !!this.moyasarSecretKey;
    if (this.providerName === 'tap') return !!this.tapSecretKey;
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
