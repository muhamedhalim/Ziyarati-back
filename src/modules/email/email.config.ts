import { ConfigService } from '@nestjs/config';

/**
 * Resolved email configuration (env-specific). In production, email is ON (Amazon SES); in development it is OFF unless `EMAIL_ENABLED=true`,
 * so local runs default to the no-op provider (log only).
 */
export interface EmailConfig {
  enabled: boolean;
  from: string;
  replyTo?: string;
  appUrl: string;
  defaultLocale: string;
}

/** Non-production fallback sender — production refuses to boot without a real one. */
const FALLBACK_FROM_ADDRESS = 'no-reply@example.com';
/** User-facing brand shown in every system email (sender name, header, body). */
export const EMAIL_BRAND_NAME = 'ZiyaraTech';
const DEFAULT_FROM_NAME = EMAIL_BRAND_NAME;

/** A bare `local@domain.tld` mailbox — the shape SES accepts inside `from`. */
const MAILBOX = /^[^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+$/;
/** An already-formatted `Name <local@domain.tld>` sender. */
const NAMED_MAILBOX = /^[^<>]*<([^<>]+)>$/;

/**
 * Builds the `from` header from `EMAIL_FROM` / `EMAIL_FROM_NAME`, or returns
 * `null` when they cannot form a sender a provider will accept.
 *
 * Blank values are treated as UNSET. The previous `EMAIL_FROM ?? fallback`
 * let an empty-string `EMAIL_FROM` through (`??` only replaces null/undefined),
 * producing `ZiyaraTech <>` — which the provider rejects on every send.
 * That is exactly how production's worker, whose `EMAIL_FROM` was set to "",
 * failed every email it ever attempted.
 *
 * `EMAIL_FROM` may also already be `Name <addr>` (the common display-name format); it is then taken as-is rather than wrapped a second time into
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
    // Production never reaches the fallback: env.validation refuses to boot
    // when a live SES sender cannot be formed.
    from:
      formatFromAddress(config.get<string>('EMAIL_FROM'), fromName) ??
      formatFromAddress(FALLBACK_FROM_ADDRESS, fromName) ??
      `${DEFAULT_FROM_NAME} <${FALLBACK_FROM_ADDRESS}>`,
    replyTo: config.get<string>('EMAIL_REPLY_TO') || undefined,
    appUrl,
    defaultLocale: config.get<string>('EMAIL_DEFAULT_LOCALE') ?? 'en',
  };
}
