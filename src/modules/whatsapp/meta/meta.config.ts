import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppError, ErrorCode } from '../../../common/errors';

/**
 * The Meta App's public identifiers — the ONLY Meta values the browser is ever
 * allowed to see. Required to launch the Embedded Signup dialog client-side.
 */
export interface MetaPublicConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

/**
 * Typed accessor for ZiyaraTech's PLATFORM-level Meta App configuration.
 *
 * Scope boundary — this is the whole point of the class:
 *   - `.env` holds ONLY app-level config (one Meta App, shared by all tenants);
 *   - a clinic's WABA id / phone number id / access token are TENANT data and
 *     live on the WhatsappAccount row (encrypted). They are never read from,
 *     nor written to, configuration.
 *
 * Everything is resolved through here rather than scattered `config.get()`
 * calls, so there is exactly one place that knows the variable names, one place
 * that decides what is public vs. secret, and one place to fail loudly when the
 * platform is misconfigured.
 *
 * Back-compat: the webhook secrets were originally named `WHATSAPP_APP_SECRET` /
 * `WHATSAPP_VERIFY_TOKEN`. The `META_*` names are canonical now, but the old
 * ones are still honoured as a fallback so a deploy doesn't break the webhook
 * the moment this ships. Remove the aliases once every environment is migrated.
 */
@Injectable()
export class MetaConfig {
  private readonly logger = new Logger('MetaConfig');

  constructor(private readonly config: ConfigService) {}

  /** Meta App ID. Public — safe to hand to the browser. */
  get appId(): string | undefined {
    return this.trimmed('META_APP_ID');
  }

  /** Embedded Signup configuration id. Public — safe to hand to the browser. */
  get embeddedSignupConfigId(): string | undefined {
    return this.trimmed('META_EMBEDDED_SIGNUP_CONFIG_ID');
  }

  /** Graph API version, e.g. `v21.0`. Public. */
  get graphVersion(): string {
    return this.trimmed('META_GRAPH_API_VERSION') ?? 'v21.0';
  }

  /**
   * App Secret. SECRET — used to (a) verify the X-Hub-Signature-256 HMAC on
   * inbound webhooks and (b) exchange Embedded Signup codes. Never leaves the
   * server, never logged.
   */
  get appSecret(): string | undefined {
    return this.trimmed('META_APP_SECRET') ?? this.trimmed('WHATSAPP_APP_SECRET');
  }

  /** Webhook verify token for the GET handshake. SECRET. */
  get webhookVerifyToken(): string | undefined {
    return (
      this.trimmed('META_WEBHOOK_VERIFY_TOKEN') ?? this.trimmed('WHATSAPP_VERIFY_TOKEN')
    );
  }

  /** Graph API base for a path, e.g. `graphUrl('me/messages')`. */
  graphUrl(path: string): string {
    return `https://graph.facebook.com/${this.graphVersion}/${path.replace(/^\//, '')}`;
  }

  /** Outbound Graph HTTP timeout (ms). */
  get httpTimeoutMs(): number {
    const raw = Number(this.config.get<string>('META_HTTP_TIMEOUT_MS') ?? '10000');
    return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
  }

  /** True when Embedded Signup can actually run (all three public values set). */
  get embeddedSignupConfigured(): boolean {
    return !!(this.appId && this.embeddedSignupConfigId && this.appSecret);
  }

  /**
   * The public identifiers the frontend needs to open the Embedded Signup
   * dialog. Deliberately returns ONLY these three — adding a secret to this
   * shape would leak it to every browser that loads the connect page.
   */
  requirePublicConfig(): MetaPublicConfig {
    const appId = this.appId;
    const configId = this.embeddedSignupConfigId;
    if (!appId || !configId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message:
          'WhatsApp onboarding is not available: the platform Meta App is not configured.',
      });
    }
    return { appId, configId, graphVersion: this.graphVersion };
  }

  /** The App Secret, or a 422 the caller can surface. Never returns ''. */
  requireAppSecret(): string {
    const secret = this.appSecret;
    if (!secret) {
      this.logger.error('META_APP_SECRET is not configured');
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp onboarding is not available: the platform Meta App is not configured.',
      });
    }
    return secret;
  }

  /** The Meta App ID, or a 422. */
  requireAppId(): string {
    const appId = this.appId;
    if (!appId) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: 'WhatsApp onboarding is not available: the platform Meta App is not configured.',
      });
    }
    return appId;
  }

  private trimmed(key: string): string | undefined {
    const value = this.config.get<string>(key)?.trim();
    return value ? value : undefined;
  }
}
