import { Injectable, Logger } from '@nestjs/common';

import {
  EmailMessage,
  EmailProvider,
  EmailSendResult,
} from './email-provider.interface';

/**
 * Development / unconfigured fallback. Logs the email (subject + recipients, no
 * body/PII) and reports success so flows that "send" an email work end-to-end
 * locally without a live provider. The factory selects this whenever email is
 * disabled or no real provider is configured.
 */
@Injectable()
export class NoopEmailProvider implements EmailProvider {
  readonly name = 'noop';
  private readonly logger = new Logger(NoopEmailProvider.name);

  isConfigured(): boolean {
    return true;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const to = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    this.logger.log(`[noop-email] would send "${message.subject}" → ${to}`);
    return { success: true, providerMessageId: `noop:${Date.now()}` };
  }
}
