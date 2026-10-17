import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailProvider } from './email-provider.interface';
import { SesProvider } from './ses.provider';
import { NoopEmailProvider } from './noop-email.provider';
import { resolveEmailConfig } from '../email.config';

/**
 * Raised when email is enabled but Amazon SES cannot be used. There is NO
 * fallback to another provider: a misconfigured environment must fail loudly
 * (and the message names only the missing setting, never a value).
 */
export class EmailConfigurationError extends Error {
  constructor() {
    super(
      'Email is enabled but Amazon SES is not configured: set SES_REGION (or AWS_REGION). ' +
        'Credentials come from the ECS task role. Refusing to send through any other provider.',
    );
    this.name = 'EmailConfigurationError';
  }
}

/**
 * Selects the email provider. Amazon SES is the only delivery provider; the
 * no-op provider exists solely for environments where email is switched off
 * (`EMAIL_ENABLED=false`, the development/test default) so the app runs
 * end-to-end without sending. Enabled + SES missing is an error, never a
 * silent downgrade to no-op.
 */
@Injectable()
export class EmailProviderFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly noop: NoopEmailProvider,
    private readonly ses: SesProvider,
  ) {}

  resolve(): EmailProvider {
    if (!resolveEmailConfig(this.config).enabled) return this.noop;
    if (!this.ses.isConfigured()) throw new EmailConfigurationError();
    return this.ses;
  }

  /** True when a real (non-noop) provider will be used. Never throws. */
  isLiveDelivery(): boolean {
    return resolveEmailConfig(this.config).enabled && this.ses.isConfigured();
  }
}
