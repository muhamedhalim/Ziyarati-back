import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailProvider } from './email-provider.interface';
import { ResendProvider } from './resend.provider';
import { SesProvider } from './ses.provider';
import { NoopEmailProvider } from './noop-email.provider';
import { resolveEmailConfig } from '../email.config';

/**
 * Selects the active email provider from configuration. Business logic never
 * sees this decision — it only ever holds an {@link EmailProvider}. Falls back to
 * the no-op provider when email is disabled or the chosen provider is not
 * configured, so the app runs end-to-end in every environment.
 */
@Injectable()
export class EmailProviderFactory {
  private readonly logger = new Logger(EmailProviderFactory.name);

  constructor(
    private readonly config: ConfigService,
    private readonly resend: ResendProvider,
    private readonly noop: NoopEmailProvider,
    // Last so positional test constructions (resend, noop) stay valid.
    private readonly ses?: SesProvider,
  ) {}

  resolve(): EmailProvider {
    const cfg = resolveEmailConfig(this.config);
    if (!cfg.enabled) return this.noop;

    if (cfg.provider === 'resend' && this.resend.isConfigured()) {
      return this.resend;
    }
    if (cfg.provider === 'ses' && this.ses?.isConfigured()) {
      return this.ses;
    }

    this.logger.warn(
      `Email provider "${cfg.provider}" not configured — falling back to no-op`,
    );
    return this.noop;
  }

  /** True when a real (non-noop) provider will be used. */
  isLiveDelivery(): boolean {
    return this.resolve().name !== 'noop';
  }
}
