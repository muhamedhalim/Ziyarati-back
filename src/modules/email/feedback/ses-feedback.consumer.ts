import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';

import { RecipientDelivery } from '../../../entities/enums';
import { RecipientDeliveryService } from '../../campaigns/recipient-delivery.service';
import { EmailSuppressionService } from '../email-suppression.service';

export type SesFeedbackOutcome =
  | 'suppressed'
  | 'no-matching-send'
  | 'soft-bounce-ignored'
  | 'ignored';

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string };
  bounce?: { bounceType?: string };
}

const ERROR_BACKOFF_MS = 5_000;

/**
 * SES bounce / complaint consumer (the only bounce/complaint feedback path;
 * there is no public webhook). SES configuration set → SNS → SQS (raw delivery)
 * → this long-poll loop on the WORKER. There is no public endpoint: only the
 * SNS topic may write to the queue (queue policy) and only SES may publish to
 * the topic (topic policy), so authenticity is enforced by IAM instead of a
 * signature header.
 *
 * Acting on an event: the SES
 * `mail.messageId` is our `provider_ref`; tenant and address come from OUR
 * campaign_recipients row (`recordDeliveryTrusted`), never from the payload.
 * Only PERMANENT bounces and complaints suppress — a transient (soft) bounce
 * such as a full mailbox must not unsubscribe a patient. Transactional mail
 * (no campaign row) is covered by SES's account-level suppression list.
 *
 * Delivery semantics: a message is deleted only after it was applied. A
 * failure leaves it in the queue; after 5 receives SQS moves it to the DLQ
 * (alarmed). Both writes are idempotent, so redelivery is harmless.
 *
 * Disabled (no loop) unless SES_FEEDBACK_QUEUE_URL is set.
 */
@Injectable()
export class SesFeedbackConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SesFeedbackConsumer.name);
  private readonly queueUrl: string;
  private readonly region: string;
  private client: SQSClient | null = null;
  private stopping = false;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    config: ConfigService,
    private readonly delivery: RecipientDeliveryService,
    private readonly suppression: EmailSuppressionService,
  ) {
    this.queueUrl = config.get<string>('SES_FEEDBACK_QUEUE_URL') ?? '';
    this.region =
      config.get<string>('SES_REGION') || config.get<string>('AWS_REGION') || '';
  }

  onApplicationBootstrap(): void {
    if (!this.queueUrl) {
      this.logger.log('SES_FEEDBACK_QUEUE_URL not set — SES feedback consumer disabled');
      return;
    }
    this.logger.log('SES feedback consumer started');
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    await this.loop;
  }

  private getClient(): SQSClient {
    if (!this.client) this.client = new SQSClient({ region: this.region });
    return this.client;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (this.stopping) break;
        this.logger.error(
          `SES feedback poll failed: ${(err as Error)?.name ?? 'Error'}`,
        );
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
      }
    }
  }

  /** One long-poll receive + apply + delete cycle. Public for tests. */
  async pollOnce(): Promise<void> {
    this.abort = new AbortController();
    const res = await this.getClient().send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      }),
      { abortSignal: this.abort.signal },
    );

    for (const message of res.Messages ?? []) {
      try {
        const outcome = await this.handle(message);
        await this.getClient().send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        if (outcome === 'suppressed') {
          this.logger.log(`SES feedback applied (message ${message.MessageId})`);
        }
      } catch (err) {
        // Left in the queue: visibility timeout → retry → DLQ after 5.
        this.logger.warn(
          `SES feedback message ${message.MessageId} not applied: ${(err as Error)?.message}`,
        );
      }
    }
  }

  /** Applies one SES event. Throws on unparseable input (→ DLQ). */
  async handle(message: Pick<Message, 'Body'>): Promise<SesFeedbackOutcome> {
    const event = parseSesEvent(message.Body);
    const type = event.eventType ?? event.notificationType;
    const providerRef = event.mail?.messageId;

    if (!providerRef || (type !== 'Bounce' && type !== 'Complaint')) {
      return 'ignored';
    }
    if (type === 'Bounce' && event.bounce?.bounceType !== 'Permanent') {
      return 'soft-bounce-ignored';
    }

    const result = await this.delivery.recordDeliveryTrusted(
      providerRef,
      RecipientDelivery.BOUNCED,
    );
    if (!result.tenantId || !result.email) return 'no-matching-send';

    await this.suppression.suppress(
      result.tenantId,
      result.email,
      type === 'Bounce' ? 'BOUNCE' : 'COMPLAINT',
      'ses',
    );
    return 'suppressed';
  }
}

/**
 * Raw SNS delivery gives the SES event JSON directly; tolerate the SNS
 * envelope too (raw delivery switched off by mistake must not drop events).
 */
function parseSesEvent(body: string | undefined): SesEvent {
  if (!body) throw new Error('empty SQS message body');
  const parsed = JSON.parse(body) as SesEvent & {
    Type?: string;
    Message?: string;
  };
  if (parsed.Type === 'Notification' && typeof parsed.Message === 'string') {
    return JSON.parse(parsed.Message) as SesEvent;
  }
  return parsed;
}
