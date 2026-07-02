import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  EmailMessage,
  EmailProvider,
  EmailSendResult,
} from './email-provider.interface';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend adapter. Talks to the Resend HTTP API via global `fetch` (no SDK
 * dependency). The API key + default sender come from config; the domain is
 * pre-verified in Resend. Transient failures (429/5xx/network) are flagged for
 * retry; 4xx are permanent.
 */
@Injectable()
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendProvider.name);
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('RESEND_API_KEY') ?? '';
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'RESEND_API_KEY is not set', transient: false };
    }

    const body = {
      from: message.from,
      to: Array.isArray(message.to) ? message.to : [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.replyTo,
      cc: message.cc,
      bcc: message.bcc,
      headers: message.headers,
      tags: message.tags,
    };

    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        return { success: true, providerMessageId: json.id };
      }

      const errText = await res.text().catch(() => res.statusText);
      const transient = res.status === 429 || res.status >= 500;
      this.logger.warn(`Resend send failed (${res.status}): ${errText}`);
      return { success: false, error: `HTTP ${res.status}: ${errText}`, transient };
    } catch (err) {
      // Network/timeout — transient.
      return { success: false, error: (err as Error)?.message, transient: true };
    }
  }
}
