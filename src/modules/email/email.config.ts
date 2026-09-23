import { ConfigService } from '@nestjs/config';

/**
 * Resolved email configuration (env-specific). In production, email is ON when a
 * provider is configured; in development it is OFF unless `EMAIL_ENABLED=true`,
 * so local runs default to the no-op provider (log only).
 */
export interface EmailConfig {
  enabled: boolean;
  provider: string;
  from: string;
  replyTo?: string;
  appUrl: string;
  defaultLocale: string;
}

/** Non-production fallback sender — production refuses to boot without a real one. */
const FALLBACK_FROM_ADDRESS = 'no-reply@example.com';
const DEFAULT_FROM_NAME = 'Ziyarati';

/** A bare `local@domain.tld` mailbox — the shape Resend accepts inside `from`. */
const MAILBOX = /^[^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+$/;
/** An already-formatted `Name <local@domain.tld>` sender. */
const NAMED_MAILBOX = /^[^<>]*<([^<>]+)>$/;

/**
 * Builds the `from` header from `EMAIL_FROM` / `EMAIL_FROM_NAME`, or returns
 * `null` when they cannot form a sender a provider will accept.
 *
 * Blank values are treated as UNSET. The previous `EMAIL_FROM ?? fallback`
 * let an empty-string `EMAIL_FROM` through (`??` only replaces null/undefined),
 * producing `Ziyarati <>` — which Resend rejects with a 422 on every send.
 * That is exactly how production's worker, whose `EMAIL_FROM` was set to "",
 * failed every email it ever attempted.
 *
 * `EMAIL_FROM` may also already be `Name <addr>` (the format Resend's own
 * docs use); it is then taken as-is rather than wrapped a second time into
 * `Name <Name <addr>>`.
 */
export function formatFromAddress(
  address: string | null | undefined,
  name: string | null | undefined,
): string | null {
  const addr = (address ?? '').trim();
  if (!addr) return null;

  const named = NAMED_MAILBOX.exec(addr);
  if (named) return MAILBOX.test(named[1].trim()) ? addr : null;
  if (!MAILBOX.test(addr)) return null;

  const displayName = (name ?? '').trim() || DEFAULT_FROM_NAME;
  if (/[<>"]/.test(displayName)) return null;
  return `${displayName} <${addr}>`;
}

export function resolveEmailConfig(config: ConfigService): EmailConfig {
  const isProd = config.get<string>('NODE_ENV') === 'production';
  const fromName = config.get<string>('EMAIL_FROM_NAME');
  const enabledRaw = config.get<string>('EMAIL_ENABLED');

  const enabled = enabledRaw != null ? enabledRaw === 'true' : isProd;

  const appUrl =
    config.get<string>('APP_URL') ??
    (config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000')
      .split(',')[0]
      .trim();

  return {
    enabled,
    provider: config.get<string>('EMAIL_PROVIDER') ?? 'resend',
    // Production never reaches the fallback: env.validation refuses to boot
    // when a live Resend sender cannot be formed.
    from:
      formatFromAddress(config.get<string>('EMAIL_FROM'), fromName) ??
      formatFromAddress(FALLBACK_FROM_ADDRESS, fromName) ??
      `${DEFAULT_FROM_NAME} <${FALLBACK_FROM_ADDRESS}>`,
    replyTo: config.get<string>('EMAIL_REPLY_TO') || undefined,
    appUrl,
    defaultLocale: config.get<string>('EMAIL_DEFAULT_LOCALE') ?? 'en',
  };
}
