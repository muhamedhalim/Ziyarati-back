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

export function resolveEmailConfig(config: ConfigService): EmailConfig {
  const isProd = config.get<string>('NODE_ENV') === 'production';
  const fromAddress = config.get<string>('EMAIL_FROM') ?? 'no-reply@example.com';
  const fromName = config.get<string>('EMAIL_FROM_NAME') ?? 'Ziyarati';
  const enabledRaw = config.get<string>('EMAIL_ENABLED');

  const enabled =
    enabledRaw != null ? enabledRaw === 'true' : isProd;

  const appUrl =
    config.get<string>('APP_URL') ??
    (config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000')
      .split(',')[0]
      .trim();

  return {
    enabled,
    provider: config.get<string>('EMAIL_PROVIDER') ?? 'resend',
    from: `${fromName} <${fromAddress}>`,
    replyTo: config.get<string>('EMAIL_REPLY_TO') || undefined,
    appUrl,
    defaultLocale: config.get<string>('EMAIL_DEFAULT_LOCALE') ?? 'en',
  };
}
