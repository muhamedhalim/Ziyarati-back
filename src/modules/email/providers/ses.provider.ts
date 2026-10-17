import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SESv2Client,
  SendEmailCommand,
  type MessageTag,
} from '@aws-sdk/client-sesv2';

import {
  EmailMessage,
  EmailProvider,
  EmailSendResult,
} from './email-provider.interface';
import { resolveEmailConfig } from '../email.config';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Errors worth retrying: throttling, quota windows, SES-side faults. */
const TRANSIENT_ERRORS = new Set([
  'TooManyRequestsException',
  'LimitExceededException',
  'InternalServiceErrorException',
  'ThrottlingException',
  'ServiceUnavailable',
  'RequestTimeout',
  'TimeoutError',
  'AbortError',
]);

/**
 * Errors no retry can fix (bad request, unverified sender domain, sandbox
 * recipient not verified, suspended/paused account, missing configuration
 * set, IAM denial). Checked BEFORE the status-code heuristics.
 */
const PERMANENT_ERRORS = new Set([
  'BadRequestException',
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
  'NotFoundException',
  'AccessDeniedException',
]);

/**
 * Amazon SES v2 adapter — the platform's only email delivery provider.
 *
 * No credentials exist in configuration: the SDK default chain resolves the
 * ECS task role, whose policy allows `ses:SendEmail` on this identity and
 * configuration set only. The configuration set routes bounce/complaint
 * events to SNS → SQS, consumed by `SesFeedbackConsumer` on the worker.
 *
 * Retry layering: the SDK makes exactly ONE attempt (`maxAttempts: 1`) under
 * `SES_HTTP_TIMEOUT_MS`; BullMQ owns retries with backoff. Two retry layers
 * could outlive BullMQ's 30 s job lock and get the job stall-requeued while
 * a send is still in flight — the reason `SES_HTTP_TIMEOUT_MS` is capped
 * below that lock.
 *
 * SES has no idempotency key: `idempotencyKey` is accepted and
 * ignored. The `email_logs` claim already prevents re-sending a SENT row;
 * the residual duplicate window is a timeout AFTER SES accepted the message.
 */
@Injectable()
export class SesProvider implements EmailProvider {
  readonly name = 'ses';
  private readonly logger = new Logger(SesProvider.name);
  private client: SESv2Client | null = null;
  private readonly region: string;
  private readonly configurationSet?: string;
  private readonly defaultFrom: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.region =
      config.get<string>('SES_REGION') || config.get<string>('AWS_REGION') || '';
    this.configurationSet =
      config.get<string>('SES_CONFIGURATION_SET') || undefined;
    this.defaultFrom = resolveEmailConfig(config).from;
    this.timeoutMs =
      Number(config.get<number>('SES_HTTP_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS;
  }

  /** Credentials come from the runtime role, so a region is all that's needed. */
  isConfigured(): boolean {
    return this.region.length > 0;
  }

  private getClient(): SESv2Client {
    if (!this.client) {
      this.client = new SESv2Client({
        region: this.region,
        maxAttempts: 1,
        requestHandler: {
          connectionTimeout: 3_000,
          requestTimeout: this.timeoutMs,
        },
      });
    }
    return this.client;
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'SES region is not set (SES_REGION or AWS_REGION)',
        transient: false,
      };
    }

    const headers = Object.entries(message.headers ?? {}).map(
      ([Name, Value]) => ({ Name, Value }),
    );
    const tags = sesTags(message.tags);

    const command = new SendEmailCommand({
      FromEmailAddress: encodeFromHeader(message.from || this.defaultFrom),
      Destination: {
        ToAddresses: Array.isArray(message.to) ? message.to : [message.to],
        CcAddresses: message.cc,
        BccAddresses: message.bcc,
      },
      ReplyToAddresses: message.replyTo ? [message.replyTo] : undefined,
      ConfigurationSetName: this.configurationSet,
      EmailTags: tags.length > 0 ? tags : undefined,
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: message.html, Charset: 'UTF-8' },
            ...(message.text
              ? { Text: { Data: message.text, Charset: 'UTF-8' } }
              : {}),
          },
          ...(headers.length > 0 ? { Headers: headers } : {}),
        },
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.getClient().send(command, {
        abortSignal: controller.signal,
      });
      return { success: true, providerMessageId: res.MessageId };
    } catch (err) {
      const e = err as {
        name?: string;
        message?: string;
        $retryable?: unknown;
        $metadata?: { httpStatusCode?: number };
      };
      const name = e?.name ?? 'Error';
      const status = e?.$metadata?.httpStatusCode;
      const transient = classifyTransient(name, status, e?.$retryable);
      // Name + status only: SES messages can echo recipient addresses.
      this.logger.warn(
        `SES send failed (${name}${status ? ` ${status}` : ''}, transient=${transient})`,
      );
      return {
        success: false,
        error: `${name}${status ? ` (HTTP ${status})` : ''}: ${e?.message ?? 'unknown error'}`,
        transient,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exported for tests. */
export function classifyTransient(
  name: string,
  status: number | undefined,
  retryable: unknown,
): boolean {
  if (PERMANENT_ERRORS.has(name)) return false;
  if (TRANSIENT_ERRORS.has(name) || retryable != null) return true;
  if (status === undefined) return true; // no response at all: network
  return status === 429 || status >= 500;
}

/**
 * SES requires RFC 2047 encoded-words for a non-ASCII display name (e.g. an
 * Arabic EMAIL_FROM_NAME). ASCII senders pass through unchanged.
 * Exported for tests.
 */
export function encodeFromHeader(from: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(from)) return from;
  const named = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (!named) return from; // a bare address: nothing to encode
  const displayName = named[1].replace(/^"(.*)"$/, '$1');
  const encoded = Buffer.from(displayName, 'utf8').toString('base64');
  return `=?UTF-8?B?${encoded}?= <${named[2]}>`;
}

/** SES tag names/values allow only [A-Za-z0-9_-], max 256 chars. */
function sesTags(tags: EmailMessage['tags']): MessageTag[] {
  const clean = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
  return (tags ?? [])
    .map((t) => ({ Name: clean(t.name), Value: clean(t.value) }))
    .filter((t) => t.Name.length > 0 && t.Value.length > 0);
}
