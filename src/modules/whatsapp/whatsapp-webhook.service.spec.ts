import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { WhatsappWebhookService } from './whatsapp-webhook.service';
import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { MetaConfig } from './meta/meta.config';
import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { RecipientDeliveryService } from '../campaigns/recipient-delivery.service';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { ErrorCode } from '../../common/errors';
import { DELIVERY_STATUS } from '../notifications/notification.constants';
import {
  createMockRepository,
  createMockConfigService,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const RAW = Buffer.from('{}');

/** A Meta-native inbound text message payload. */
const inboundBody = (wamid = 'wamid.1') => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pid-1' },
            messages: [{ id: wamid, from: '966500000000', type: 'text', text: { body: 'hi' } }],
          },
        },
      ],
    },
  ],
});

const statusBody = (wamid = 'wamid.9', status = 'delivered') => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: { metadata: { phone_number_id: 'pid-1' }, statuses: [{ id: wamid, status }] },
        },
      ],
    },
  ],
});

describe('WhatsappWebhookService', () => {
  let service: WhatsappWebhookService;
  let webhooks: MockRepository;
  let accounts: MockRepository;
  let verifier: { verify: jest.Mock; resolveChallenge: jest.Mock };
  let inboundAi: { handleInboundValue: jest.Mock };
  let notifDelivery: { recordDelivery: jest.Mock };
  let recipientDelivery: { recordDelivery: jest.Mock };
  let queue: { enqueueWhatsappWebhook: jest.Mock };

  beforeEach(async () => {
    webhooks = createMockRepository();
    accounts = createMockRepository();
    webhooks.create.mockImplementation((v: object) => ({ ...v }));
    webhooks.save.mockImplementation(async (v: object) => ({ id: 'evt-1', ...v }));
    accounts.findOne.mockResolvedValue({ id: 'acc-1', tenant: { id: TENANT } });

    verifier = { verify: jest.fn().mockReturnValue(true), resolveChallenge: jest.fn() };
    inboundAi = { handleInboundValue: jest.fn().mockResolvedValue(undefined) };
    notifDelivery = { recordDelivery: jest.fn().mockResolvedValue(undefined) };
    recipientDelivery = { recordDelivery: jest.fn().mockResolvedValue({ updated: false, reason: 'recipient-not-found' }) };
    queue = { enqueueWhatsappWebhook: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappWebhookService,
        { provide: getRepositoryToken(WhatsappWebhook), useValue: webhooks },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: WebhookSignatureVerifier, useValue: verifier },
        { provide: NotificationDeliveryService, useValue: notifDelivery },
        { provide: RecipientDeliveryService, useValue: recipientDelivery },
        { provide: WhatsappInboundAiService, useValue: inboundAi },
        { provide: QueueService, useValue: queue },
        { provide: TenantContextService, useValue: new TenantContextService() },
        {
          provide: MetaConfig,
          useValue: new MetaConfig(
            createMockConfigService({
              META_WEBHOOK_VERIFY_TOKEN: 'vt',
            }) as unknown as ConfigService,
          ),
        },
      ],
    }).compile();
    service = moduleRef.get(WhatsappWebhookService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('ingest — verify → persist → enqueue → 200', () => {
    it('rejects an invalid signature before touching the database', async () => {
      verifier.verify.mockReturnValueOnce(false);

      await expect(service.ingest(inboundBody(), RAW, 'sha256=bad')).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
      expect(webhooks.save).not.toHaveBeenCalled();
      expect(queue.enqueueWhatsappWebhook).not.toHaveBeenCalled();
    });

    it('verifies against the EXACT raw bytes, not the parsed body', async () => {
      await service.ingest(inboundBody(), RAW, 'sha256=ok');
      expect(verifier.verify).toHaveBeenCalledWith('sha256=ok', RAW);
    });

    it('persists the event unprocessed and enqueues it', async () => {
      const res = await service.ingest(inboundBody(), RAW, 'sha256=ok');

      expect(webhooks.create).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'messages', processed: false }),
      );
      expect(queue.enqueueWhatsappWebhook).toHaveBeenCalledWith({
        webhookEventId: 'evt-1',
        tenantId: TENANT,
      });
      expect(res).toMatchObject({ accepted: true, id: 'evt-1' });
    });

    it('does NOT process inline — Meta must get a fast 200', async () => {
      await service.ingest(inboundBody(), RAW, 'sha256=ok');

      // The old code ran the AI turn inline via a fire-and-forget `void`, which
      // risked the webhook timeout and lost work on a crash.
      expect(inboundAi.handleInboundValue).not.toHaveBeenCalled();
      expect(notifDelivery.recordDelivery).not.toHaveBeenCalled();
    });

    it('de-duplicates a redelivered event on the wamid', async () => {
      webhooks.findOne.mockResolvedValueOnce({ id: 'existing' });

      const res = await service.ingest(inboundBody(), RAW, 'sha256=ok');

      expect(res).toMatchObject({ accepted: true, id: 'existing', deduplicated: true });
      expect(webhooks.save).not.toHaveBeenCalled();
      expect(queue.enqueueWhatsappWebhook).not.toHaveBeenCalled();
    });

    it('treats a concurrent-insert unique violation as a dedup, not a failure', async () => {
      // Two Meta redeliveries race past the findOne check simultaneously; the
      // DB unique index on idempotency_key is what actually serializes them —
      // the loser's save() throws 23505, and it must recover, not 500.
      webhooks.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      webhooks.findOne.mockResolvedValueOnce(undefined); // pre-insert check: not found yet
      webhooks.findOne.mockResolvedValueOnce({ id: 'winner-row' }); // post-conflict re-fetch

      const res = await service.ingest(inboundBody(), RAW, 'sha256=ok');

      expect(res).toMatchObject({ accepted: true, id: 'winner-row', deduplicated: true });
      expect(queue.enqueueWhatsappWebhook).not.toHaveBeenCalled();
    });

    it('rethrows a unique violation that is not actually a dedup race', async () => {
      const err = Object.assign(new Error('duplicate key'), { code: '23505' });
      webhooks.save.mockRejectedValueOnce(err);
      webhooks.findOne.mockResolvedValueOnce(undefined);
      webhooks.findOne.mockResolvedValueOnce(undefined); // re-fetch finds nothing — not our dedup case

      await expect(service.ingest(inboundBody(), RAW, 'sha256=ok')).rejects.toBe(err);
    });

    it('still accepts (200) when enqueueing fails — the event is already stored', async () => {
      queue.enqueueWhatsappWebhook.mockRejectedValueOnce(new Error('redis down'));

      // Throwing would make Meta redeliver something we already hold.
      const res = await service.ingest(inboundBody(), RAW, 'sha256=ok');
      expect(res).toMatchObject({ accepted: true });
    });
  });

  describe('tenant resolution (the trusted mapping)', () => {
    it('resolves the tenant from phone_number_id, excluding disconnected accounts', async () => {
      await service.ingest(inboundBody(), RAW, 'sha256=ok');

      expect(accounts.findOne.mock.calls[0][0].where).toMatchObject({
        phone_number_id: 'pid-1',
        deleted_at: expect.anything(),
      });
    });

    it('stores an unresolvable event WITHOUT a tenant rather than guessing', async () => {
      accounts.findOne.mockResolvedValueOnce(null);

      await service.ingest(inboundBody(), RAW, 'sha256=ok');

      expect(webhooks.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: undefined }),
      );
      expect(queue.enqueueWhatsappWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: null }),
      );
    });
  });

  describe('processEvent — the worker entry point', () => {
    it('drives an inbound message through the AI bridge', async () => {
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-1',
        processed: false,
        event_type: 'messages',
        payload: inboundBody(),
        tenant: { id: TENANT },
      });

      const res = await service.processEvent('evt-1');

      expect(inboundAi.handleInboundValue).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ metadata: { phone_number_id: 'pid-1' } }),
      );
      expect(res).toEqual({ processed: true });
    });

    it('applies delivery statuses for a status event', async () => {
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-2',
        processed: false,
        event_type: 'message_status',
        payload: statusBody('wamid.9', 'delivered'),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-2');

      expect(notifDelivery.recordDelivery).toHaveBeenCalledWith(
        'wamid.9',
        DELIVERY_STATUS.DELIVERED,
      );
    });

    it('also forwards the status to campaign recipient delivery (the previously-missing seam)', async () => {
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-2',
        processed: false,
        event_type: 'message_status',
        payload: statusBody('wamid.9', 'delivered'),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-2');

      expect(recipientDelivery.recordDelivery).toHaveBeenCalledWith({
        providerRef: 'wamid.9',
        event: 'DELIVERED',
      });
    });

    it('maps "read" and "failed" to the recipient delivery axis (READ / BOUNCED)', async () => {
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-4',
        processed: false,
        event_type: 'message_status',
        payload: statusBody('wamid.10', 'read'),
        tenant: { id: TENANT },
      });
      await service.processEvent('evt-4');
      expect(recipientDelivery.recordDelivery).toHaveBeenCalledWith({
        providerRef: 'wamid.10',
        event: 'READ',
      });

      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-5',
        processed: false,
        event_type: 'message_status',
        payload: statusBody('wamid.11', 'failed'),
        tenant: { id: TENANT },
      });
      await service.processEvent('evt-5');
      expect(recipientDelivery.recordDelivery).toHaveBeenCalledWith({
        providerRef: 'wamid.11',
        event: 'BOUNCED',
      });
    });

    it('marks the event processed, guarded against a concurrent duplicate', async () => {
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-1',
        processed: false,
        event_type: 'messages',
        payload: inboundBody(),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-1');

      expect(webhooks.update).toHaveBeenCalledWith(
        { id: 'evt-1', processed: false },
        { processed: true },
      );
    });

    it('skips an already-processed event (idempotent)', async () => {
      webhooks.findOne.mockResolvedValueOnce({ id: 'evt-1', processed: true });

      const res = await service.processEvent('evt-1');

      expect(res).toMatchObject({ processed: false, reason: 'already-processed' });
      expect(inboundAi.handleInboundValue).not.toHaveBeenCalled();
    });

    it('skips a tenant-less event instead of guessing an owner', async () => {
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-3',
        processed: false,
        event_type: 'messages',
        payload: inboundBody(),
        tenant: null,
      });

      const res = await service.processEvent('evt-3');

      expect(res).toMatchObject({ processed: false, reason: 'no-tenant' });
      expect(inboundAi.handleInboundValue).not.toHaveBeenCalled();
    });

    it('no-ops for a missing event', async () => {
      webhooks.findOne.mockResolvedValueOnce(null);
      await expect(service.processEvent('gone')).resolves.toMatchObject({
        processed: false,
        reason: 'event-missing',
      });
    });
  });

  describe('retry', () => {
    it('re-queues a real job (it used to only flip a flag nothing consumed)', async () => {
      webhooks.findOne.mockResolvedValue({ id: 'evt-1', processed: true });

      await service.retry(TENANT, 'evt-1');

      expect(webhooks.save).toHaveBeenCalledWith(
        expect.objectContaining({ processed: false }),
      );
      expect(queue.enqueueWhatsappWebhook).toHaveBeenCalledWith({
        webhookEventId: 'evt-1',
        tenantId: TENANT,
      });
    });
  });
});
