import { Logger } from '@nestjs/common';

const sqsSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: sqsSend })),
  ReceiveMessageCommand: jest.fn().mockImplementation((input) => ({ kind: 'receive', input })),
  DeleteMessageCommand: jest.fn().mockImplementation((input) => ({ kind: 'delete', input })),
}));

import { SesFeedbackConsumer } from './ses-feedback.consumer';
import { RecipientDelivery } from '../../../entities/enums';

const QUEUE = 'https://sqs.me-central-1.amazonaws.com/123456789012/zt-production-ses-feedback';

const config = (env: Record<string, unknown>) =>
  ({ get: jest.fn((k: string) => env[k]) }) as never;

const bounce = (bounceType: string, messageId = 'ses-msg-1') =>
  JSON.stringify({ eventType: 'Bounce', mail: { messageId }, bounce: { bounceType } });
const complaint = (messageId = 'ses-msg-1') =>
  JSON.stringify({ eventType: 'Complaint', mail: { messageId }, complaint: {} });

describe('SesFeedbackConsumer', () => {
  let delivery: { recordDeliveryTrusted: jest.Mock };
  let suppression: { suppress: jest.Mock };
  let consumer: SesFeedbackConsumer;

  beforeEach(() => {
    sqsSend.mockReset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    delivery = {
      recordDeliveryTrusted: jest
        .fn()
        .mockResolvedValue({ updated: true, tenantId: 't-1', email: 'p@example.com' }),
    };
    suppression = { suppress: jest.fn().mockResolvedValue(undefined) };
    consumer = new SesFeedbackConsumer(
      config({ SES_FEEDBACK_QUEUE_URL: QUEUE, AWS_REGION: 'me-central-1' }),
      delivery as never,
      suppression as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('handle', () => {
    it('suppresses on a PERMANENT bounce using tenant/address from OUR row, not the payload', async () => {
      await expect(consumer.handle({ Body: bounce('Permanent') })).resolves.toBe('suppressed');
      expect(delivery.recordDeliveryTrusted).toHaveBeenCalledWith('ses-msg-1', RecipientDelivery.BOUNCED);
      expect(suppression.suppress).toHaveBeenCalledWith('t-1', 'p@example.com', 'BOUNCE', 'ses');
    });

    it('suppresses on a complaint', async () => {
      await expect(consumer.handle({ Body: complaint() })).resolves.toBe('suppressed');
      expect(suppression.suppress).toHaveBeenCalledWith('t-1', 'p@example.com', 'COMPLAINT', 'ses');
    });

    it.each(['Transient', 'Undetermined'])(
      'never suppresses a %s (soft) bounce — a full mailbox must not unsubscribe a patient',
      async (type) => {
        await expect(consumer.handle({ Body: bounce(type) })).resolves.toBe('soft-bounce-ignored');
        expect(delivery.recordDeliveryTrusted).not.toHaveBeenCalled();
        expect(suppression.suppress).not.toHaveBeenCalled();
      },
    );

    it('does nothing for a send we have no campaign row for (transactional mail)', async () => {
      delivery.recordDeliveryTrusted.mockResolvedValueOnce({ updated: false, reason: 'recipient-not-found' });
      await expect(consumer.handle({ Body: bounce('Permanent') })).resolves.toBe('no-matching-send');
      expect(suppression.suppress).not.toHaveBeenCalled();
    });

    it('accepts an SNS envelope when raw delivery is off', async () => {
      const envelope = JSON.stringify({ Type: 'Notification', Message: bounce('Permanent') });
      await expect(consumer.handle({ Body: envelope })).resolves.toBe('suppressed');
    });

    it('supports identity-notification shape (notificationType)', async () => {
      const body = JSON.stringify({
        notificationType: 'Bounce',
        mail: { messageId: 'm' },
        bounce: { bounceType: 'Permanent' },
      });
      await expect(consumer.handle({ Body: body })).resolves.toBe('suppressed');
    });

    it('ignores other event types', async () => {
      const body = JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'm' } });
      await expect(consumer.handle({ Body: body })).resolves.toBe('ignored');
    });

    it('throws on an unparseable body (message goes to the DLQ, not silently dropped)', async () => {
      await expect(consumer.handle({ Body: 'not json' })).rejects.toThrow();
      await expect(consumer.handle({ Body: undefined })).rejects.toThrow('empty');
    });
  });

  describe('pollOnce', () => {
    it('deletes only messages that were applied', async () => {
      sqsSend.mockImplementation(async (cmd: { kind: string }) =>
        cmd.kind === 'receive'
          ? {
              Messages: [
                { MessageId: 'a', ReceiptHandle: 'rh-a', Body: bounce('Permanent') },
                { MessageId: 'b', ReceiptHandle: 'rh-b', Body: 'garbage' },
              ],
            }
          : {},
      );
      await consumer.pollOnce();
      const deletes = sqsSend.mock.calls
        .map(([c]) => c)
        .filter((c: { kind: string }) => c.kind === 'delete');
      expect(deletes).toEqual([{ kind: 'delete', input: { QueueUrl: QUEUE, ReceiptHandle: 'rh-a' } }]);
    });

    it('leaves a message in the queue when the DB write fails', async () => {
      suppression.suppress.mockRejectedValueOnce(new Error('db down'));
      sqsSend.mockImplementation(async (cmd: { kind: string }) =>
        cmd.kind === 'receive'
          ? { Messages: [{ MessageId: 'a', ReceiptHandle: 'rh-a', Body: complaint() }] }
          : {},
      );
      await consumer.pollOnce();
      expect(sqsSend.mock.calls.some(([c]) => c.kind === 'delete')).toBe(false);
    });

    it('long-polls the configured queue', async () => {
      sqsSend.mockResolvedValueOnce({});
      await consumer.pollOnce();
      expect(sqsSend.mock.calls[0][0]).toEqual({
        kind: 'receive',
        input: { QueueUrl: QUEUE, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 },
      });
    });
  });

  it('does not start without SES_FEEDBACK_QUEUE_URL', () => {
    const idle = new SesFeedbackConsumer(config({}), delivery as never, suppression as never);
    idle.onApplicationBootstrap();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('stops its loop on shutdown', async () => {
    sqsSend.mockImplementation(
      (_cmd: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          opts?.abortSignal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        ),
    );
    consumer.onApplicationBootstrap();
    await expect(consumer.onModuleDestroy()).resolves.toBeUndefined();
  });
});
