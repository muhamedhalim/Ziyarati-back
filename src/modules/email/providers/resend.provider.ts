import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import {
  EmailMessage,
  EmailProvider,
  EmailSendResult,
} from './email-provider.interface';
import { resolveEmailConfig } from '../email.config';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Resend's own limit on the `Idempotency-Key` header. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resend adapter. Talks to the Resend HTTP API via global `fetch` (no SDK
 * dependency). The API key + default sender come from config; the domain is
 * pre-verified in Resend. Transient failures (429/5xx/network/timeout, and a
 * 409 for a concurrent request on the same idempotency key) are flagged for
 * retry; other 4xx are permanent.
 *
 * The sender defaults to the configured platform sender whenever a caller
 * leaves `from` unset (as `EmailChannelProvider` does) — Resend rejects a
 * message with no `from` outright, so there is no "provider default" to fall
 * back on.
 *
 * The request is bounded by `RESEND_HTTP_TIMEOUT_MS`, which env validation
 * caps below BullMQ's 30s job lock, and carries the delivery layer's
 * idempotency key so a retry after an unobserved success is deduplicated by
 * Resend (24h window) instead of delivering twice.
 */
@Injectable()
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendProvider.name);
  private readonly apiKey: string;
  private readonly defaultFrom: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('RESEND_API_KEY') ?? '';
    this.defaultFrom = resolveEmailConfig(config).from;
    this.timeoutMs =
      Number(config.get<number>('RESEND_HTTP_TIMEOUT_MS')) ||
      DEFAULT_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'RESEND_API_KEY is not set',
        transient: false,
      };
    }

    const body = {
      from: message.from || this.defaultFrom,
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

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (message.idempotencyKey) {
      headers['Idempotency-Key'] = this.providerIdempotencyKey(
        message.idempotencyKey,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        return { success: true, providerMessageId: json.id };
      }

      const errText = await res.text().catch(() => res.statusText);
      const transient =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 409 &&
          errText.includes('concurrent_idempotent_requests'));
      this.logger.warn(
        `Resend send failed (${res.status}, transient=${transient}): ${errText}`,
      );
      return {
        success: false,
        error: `HTTP ${res.status}: ${errText}`,
        transient,
      };
    } catch (err) {
      // Network/timeout — transient.
      const error =
        (err as Error)?.name === 'AbortError'
          ? `Resend API timeout after ${this.timeoutMs}ms`
          : (err as Error)?.message;
      this.logger.warn(`Resend send threw (transient): ${error}`);
      return { success: false, error, transient: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private providerIdempotencyKey(key: string): string {
    return key.length <= MAX_IDEMPOTENCY_KEY_LENGTH
      ? key
      : createHash('sha256').update(key).digest('hex');
  }
}
