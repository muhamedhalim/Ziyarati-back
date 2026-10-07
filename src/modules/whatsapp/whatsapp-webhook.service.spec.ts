import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

import { WhatsappWebhookService } from './whatsapp-webhook.service';
import { WebhookSignatureVerifier } from './webhooks/webhook-signature.verifier';
import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';
import { WhatsappCoexistenceEchoService } from './meta/whatsapp-coexistence-echo.service';
import { MetaConfig } from './meta/meta.config';
import { WhatsappWebhook } from '../../entities/WhatsApp/WhatsappWebhook';
import { WhatsappAccount } from '../../entities/WhatsApp/WhatsappAccount';
import { Message } from '../../entities/Conversations/Message';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { RecipientDeliveryService } from '../campaigns/recipient-delivery.service';
import { MessageStatusService } from '../conversations/message-status.service';
import { QueueService } from '../../queue/queue.service';
import { MetricsService } from '../../metrics/metrics.service';
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

/** ZT-H02 — a fresh Unix-seconds timestamp, well inside the freshness window. */
const freshTimestamp = () => String(Math.floor(Date.now() / 1000));

/** A Meta-native inbound text message payload. */
const inboundBody = (wamid = 'wamid.1', timestamp = freshTimestamp()) => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pid-1' },
            messages: [
              {
                id: wamid,
                from: '966500000000',
                type: 'text',
                text: { body: 'hi' },
                timestamp,
              },
            ],
          },
        },
      ],
    },
  ],
});

const statusBody = (
  wamid = 'wamid.9',
  status = 'delivered',
  timestamp = freshTimestamp(),
) => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pid-1' },
            statuses: [{ id: wamid, status, timestamp }],
          },
        },
      ],
    },
  ],
});

/** Coexistence — a business-app-sent message echoed back via the webhook. */
const echoBody = (wamid = 'echo.1', timestamp = freshTimestamp()) => ({
  entry: [
    {
      changes: [
        {
          field: 'smb_message_echoes',
          value: {
            metadata: { phone_number_id: 'pid-1' },
            contacts: [{ wa_id: '966500000000' }],
            message_echoes: [
              {
                id: wamid,
                to: '966500000000',
                type: 'text',
                text: { body: 'from the business app' },
                timestamp,
              },
            ],
          },
        },
      ],
    },
  ],
});

/** Coexistence — Meta's confirmation that a triggered sync ran. Shape is deliberately unasserted (see coexistence-webhook.adapter.ts). */
const syncConfirmationBody = (
  field: 'smb_app_state_sync' | 'history',
  timestamp = freshTimestamp(),
) => ({
  entry: [
    {
      changes: [
        {
          field,
          value: { metadata: { phone_number_id: 'pid-1' }, timestamp },
        },
      ],
    },
  ],
});

describe('WhatsappWebhookService', () => {
  let service: WhatsappWebhookService;
  let webhooks: MockRepository;
  let accounts: MockRepository;
  let metrics: { recordWhatsappInboundEvent: jest.Mock };
  let verifier: { verify: jest.Mock; resolveChallenge: jest.Mock };
  let inboundAi: { handleInboundValue: jest.Mock };
  let coexistenceEcho: { handleEchoes: jest.Mock };
  let notifDelivery: { recordDelivery: jest.Mock };
  let recipientDelivery: { recordDelivery: jest.Mock };
  let queue: { enqueueWhatsappWebhook: jest.Mock };
  let messages: MockRepository;
  let messageStatus: {
    markDelivered: jest.Mock;
    markRead: jest.Mock;
    markFailed: jest.Mock;
  };

  beforeEach(async () => {
    webhooks = createMockRepository();
    accounts = createMockRepository();
    webhooks.create.mockImplementation((v: object) => ({ ...v }));
    webhooks.save.mockImplementation(async (v: object) => ({
      id: 'evt-1',
      ...v,
    }));
    accounts.findOne.mockResolvedValue({ id: 'acc-1', tenant: { id: TENANT } });

    verifier = {
      verify: jest.fn().mockReturnValue(true),
      resolveChallenge: jest.fn(),
    };
    metrics = { recordWhatsappInboundEvent: jest.fn() };
    inboundAi = { handleInboundValue: jest.fn().mockResolvedValue(undefined) };
    coexistenceEcho = { handleEchoes: jest.fn().mockResolvedValue(undefined) };
    notifDelivery = { recordDelivery: jest.fn().mockResolvedValue(undefined) };
    recipientDelivery = {
      recordDelivery: jest
        .fn()
        .mockResolvedValue({ updated: false, reason: 'recipient-not-found' }),
    };
    queue = { enqueueWhatsappWebhook: jest.fn().mockResolvedValue(undefined) };
    messages = createMockRepository();
    messages.findOne.mockResolvedValue(null); // default: no matching conversation message
    messageStatus = {
      markDelivered: jest.fn().mockResolvedValue(undefined),
      markRead: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappWebhookService,
        { provide: getRepositoryToken(WhatsappWebhook), useValue: webhooks },
        { provide: getRepositoryToken(WhatsappAccount), useValue: accounts },
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: WebhookSignatureVerifier, useValue: verifier },
        { provide: NotificationDeliveryService, useValue: notifDelivery },
        { provide: RecipientDeliveryService, useValue: recipientDelivery },
        { provide: MessageStatusService, useValue: messageStatus },
        { provide: WhatsappInboundAiService, useValue: inboundAi },
        { provide: WhatsappCoexistenceEchoService, useValue: coexistenceEcho },
        { provide: QueueService, useValue: queue },
        { provide: TenantContextService, useValue: new TenantContextService() },
        { provide: MetricsService, useValue: metrics },
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

      await expect(
        service.ingest(inboundBody(), RAW, 'sha256=bad'),
      ).rejects.toMatchObject({
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

      expect(res).toMatchObject({
        accepted: true,
        id: 'existing',
        deduplicated: true,
      });
      expect(webhooks.save).not.toHaveBeenCalled();
      expect(queue.enqueueWhatsappWebhook).not.toHaveBeenCalled();
    });

    // Patient Journey plan (2026-09-16) — the idempotency key for a status
    // event now includes the status VALUE, not just the wamid, so Meta's
    // three separate `sent`/`delivered`/`read` webhooks for one message are
    // each ingested (not collapsed onto whichever arrived first), while a
    // genuine redelivery of the SAME status still dedupes.
    it('does NOT deduplicate sent/delivered/read status events for the same wamid', async () => {
      const sent = await service.ingest(
        statusBody('wamid.30', 'sent'),
        RAW,
        'sha256=ok',
      );
      const delivered = await service.ingest(
        statusBody('wamid.30', 'delivered'),
        RAW,
        'sha256=ok',
      );
      const read = await service.ingest(
        statusBody('wamid.30', 'read'),
        RAW,
        'sha256=ok',
      );

      expect(sent.deduplicated).toBeFalsy();
      expect(delivered.deduplicated).toBeFalsy();
      expect(read.deduplicated).toBeFalsy();
      expect(webhooks.save).toHaveBeenCalledTimes(3);
      expect(webhooks.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ idempotency_key: 'status:wamid.30:sent' }),
      );
      expect(webhooks.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          idempotency_key: 'status:wamid.30:delivered',
        }),
      );
      expect(webhooks.create).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ idempotency_key: 'status:wamid.30:read' }),
      );
    });

    it('still deduplicates a genuine redelivery of the SAME status', async () => {
      webhooks.findOne.mockResolvedValueOnce(undefined); // first delivery: not seen yet
      const first = await service.ingest(
        statusBody('wamid.31', 'delivered'),
        RAW,
        'sha256=ok',
      );
      expect(first.deduplicated).toBeFalsy();

      webhooks.findOne.mockResolvedValueOnce({ id: 'existing-delivered' }); // Meta redelivers
      const second = await service.ingest(
        statusBody('wamid.31', 'delivered'),
        RAW,
        'sha256=ok',
      );
      expect(second).toMatchObject({
        accepted: true,
        id: 'existing-delivered',
        deduplicated: true,
      });
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

      expect(res).toMatchObject({
        accepted: true,
        id: 'winner-row',
        deduplicated: true,
      });
      expect(queue.enqueueWhatsappWebhook).not.toHaveBeenCalled();
    });

    it('rethrows a unique violation that is not actually a dedup race', async () => {
      const err = Object.assign(new Error('duplicate key'), { code: '23505' });
      webhooks.save.mockRejectedValueOnce(err);
      webhooks.findOne.mockResolvedValueOnce(undefined);
      webhooks.findOne.mockResolvedValueOnce(undefined); // re-fetch finds nothing — not our dedup case

      await expect(
        service.ingest(inboundBody(), RAW, 'sha256=ok'),
      ).rejects.toBe(err);
    });

    it('still accepts (200) when enqueueing fails — the event is already stored', async () => {
      queue.enqueueWhatsappWebhook.mockRejectedValueOnce(
        new Error('redis down'),
      );

      // Throwing would make Meta redeliver something we already hold.
      const res = await service.ingest(inboundBody(), RAW, 'sha256=ok');
      expect(res).toMatchObject({ accepted: true });
    });
  });

  describe('inbound event counter (Step 12)', () => {
    const msgBody = (pid: string, wamid: string) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: pid },
                messages: [
                  {
                    id: wamid,
                    from: '966500000000',
                    type: 'text',
                    text: { body: 'hi' },
                    timestamp: freshTimestamp(),
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    it('counts a new event for a known number as accepted', async () => {
      webhooks.save.mockImplementation(async (v: object) => ({
        id: 'e1',
        ...v,
      }));
      await service.ingest(msgBody('pid-1', 'w.m1') as never, RAW, 'sha256=ok');
      expect(metrics.recordWhatsappInboundEvent).toHaveBeenCalledWith(
        'accepted',
      );
    });

    it('counts a number that matches no live account as no_tenant', async () => {
      accounts.findOne.mockResolvedValue(null);
      webhooks.save.mockImplementation(async (v: object) => ({
        id: 'e1',
        ...v,
      }));
      await service.ingest(msgBody('pid-x', 'w.m2') as never, RAW, 'sha256=ok');
      expect(metrics.recordWhatsappInboundEvent).toHaveBeenCalledWith(
        'no_tenant',
      );
    });

    it('counts a redelivery as deduplicated', async () => {
      webhooks.findOne.mockResolvedValue({ id: 'old' });
      await service.ingest(msgBody('pid-1', 'w.m3') as never, RAW, 'sha256=ok');
      expect(metrics.recordWhatsappInboundEvent).toHaveBeenCalledWith(
        'deduplicated',
      );
      expect(metrics.recordWhatsappInboundEvent).not.toHaveBeenCalledWith(
        'accepted',
      );
    });
  });

  describe('a batched POST is split into one event per (entry, change)', () => {
    const msgChange = (pid: string, wamid: string) => ({
      field: 'messages',
      value: {
        metadata: { phone_number_id: pid },
        messages: [
          {
            id: wamid,
            from: '966500000000',
            type: 'text',
            text: { body: 'hi' },
            timestamp: freshTimestamp(),
          },
        ],
      },
    });
    const batch = (...entries: { id: string; changes: unknown[] }[]) => ({
      object: 'whatsapp_business_account',
      entry: entries,
    });
    let n = 0;
    beforeEach(() => {
      n = 0;
      webhooks.save.mockImplementation(async (v: object) => ({
        id: `evt-${++n}`,
        ...v,
      }));
    });

    it('stores and enqueues one event per change — the second change is no longer dropped', async () => {
      const res = await service.ingest(
        batch({
          id: 'waba-1',
          changes: [msgChange('pid-1', 'w.1'), msgChange('pid-1', 'w.2')],
        }) as never,
        RAW,
        'sha256=ok',
      );

      expect(webhooks.save).toHaveBeenCalledTimes(2);
      expect(queue.enqueueWhatsappWebhook).toHaveBeenCalledTimes(2);
      expect(
        webhooks.create.mock.calls.map((c) => c[0].idempotency_key),
      ).toEqual(['message:w.1', 'message:w.2']);
      expect(res).toEqual({ accepted: true, id: 'evt-1' });
    });

    it('each stored payload is a single-change body, so the worker only ever sees one', async () => {
      await service.ingest(
        batch({
          id: 'waba-1',
          changes: [msgChange('pid-1', 'w.1'), msgChange('pid-1', 'w.2')],
        }) as never,
        RAW,
        'sha256=ok',
      );

      for (const [row] of webhooks.create.mock.calls) {
        expect(row.payload.object).toBe('whatsapp_business_account');
        expect(row.payload.entry).toHaveLength(1);
        expect(row.payload.entry[0].id).toBe('waba-1');
        expect(row.payload.entry[0].changes).toHaveLength(1);
      }
    });

    it('resolves each unit’s tenant from ITS OWN phone_number_id — two clinics in one POST never cross', async () => {
      accounts.findOne.mockImplementation(
        async ({ where }: { where: { phone_number_id: string } }) =>
          where.phone_number_id === 'pid-A'
            ? { id: 'a', tenant: { id: 'tenant-A' } }
            : where.phone_number_id === 'pid-B'
              ? { id: 'b', tenant: { id: 'tenant-B' } }
              : null,
      );

      await service.ingest(
        batch(
          { id: 'waba-A', changes: [msgChange('pid-A', 'w.A')] },
          { id: 'waba-B', changes: [msgChange('pid-B', 'w.B')] },
        ) as never,
        RAW,
        'sha256=ok',
      );

      const tenants = webhooks.create.mock.calls.map((c) => c[0].tenant?.id);
      expect(tenants).toEqual(['tenant-A', 'tenant-B']);
      expect(
        queue.enqueueWhatsappWebhook.mock.calls.map((c) => c[0].tenantId),
      ).toEqual(['tenant-A', 'tenant-B']);
    });

    it('a unit for an unknown number is stored tenant-less, never attributed to a neighbour in the same POST', async () => {
      accounts.findOne.mockImplementation(
        async ({ where }: { where: { phone_number_id: string } }) =>
          where.phone_number_id === 'pid-A'
            ? { id: 'a', tenant: { id: 'tenant-A' } }
            : null,
      );

      await service.ingest(
        batch(
          { id: 'waba-A', changes: [msgChange('pid-A', 'w.A')] },
          { id: 'waba-X', changes: [msgChange('pid-unknown', 'w.X')] },
        ) as never,
        RAW,
        'sha256=ok',
      );

      expect(webhooks.create.mock.calls.map((c) => c[0].tenant?.id)).toEqual([
        'tenant-A',
        undefined,
      ]);
    });

    it('a replayed batch is deduplicated unit by unit and enqueues nothing', async () => {
      webhooks.findOne.mockImplementation(
        async ({ where }: { where: { idempotency_key: string } }) => ({
          id: `old-${where.idempotency_key}`,
        }),
      );

      const res = await service.ingest(
        batch({
          id: 'waba-1',
          changes: [msgChange('pid-1', 'w.1'), msgChange('pid-1', 'w.2')],
        }) as never,
        RAW,
        'sha256=ok',
      );

      expect(res).toEqual({
        accepted: true,
        id: 'old-message:w.1',
        deduplicated: true,
      });
      expect(webhooks.save).not.toHaveBeenCalled();
      expect(queue.enqueueWhatsappWebhook).not.toHaveBeenCalled();
    });

    it('a half-replayed batch stores only the unit it has not seen, and is not reported as a duplicate', async () => {
      webhooks.findOne.mockImplementation(
        async ({ where }: { where: { idempotency_key: string } }) =>
          where.idempotency_key === 'message:w.1' ? { id: 'old-1' } : null,
      );

      const res = await service.ingest(
        batch({
          id: 'waba-1',
          changes: [msgChange('pid-1', 'w.1'), msgChange('pid-1', 'w.2')],
        }) as never,
        RAW,
        'sha256=ok',
      );

      expect(webhooks.save).toHaveBeenCalledTimes(1);
      expect(res.deduplicated).toBeUndefined();
    });

    it('a body with one change keeps its ORIGINAL payload object (no behaviour change for ordinary traffic)', async () => {
      const body = inboundBody();
      await service.ingest(body as never, RAW, 'sha256=ok');

      expect(webhooks.create.mock.calls[0][0].payload).toBe(body);
    });

    it('the legacy { payload } wrapper stays a single event', async () => {
      await service.ingest(
        {
          eventType: 'messages',
          idempotencyKey: 'legacy-1',
          payload: batch({
            id: 'w',
            changes: [msgChange('pid-1', 'w.1'), msgChange('pid-1', 'w.2')],
          }),
        } as never,
        RAW,
        'sha256=ok',
      );

      expect(webhooks.save).toHaveBeenCalledTimes(1);
      expect(webhooks.create.mock.calls[0][0].idempotency_key).toBe('legacy-1');
    });

    it('still verifies the signature and freshness ONCE for the whole POST, before any unit is stored', async () => {
      verifier.verify.mockReturnValueOnce(false);
      await expect(
        service.ingest(
          batch({
            id: 'w',
            changes: [msgChange('pid-1', 'w.1'), msgChange('pid-1', 'w.2')],
          }) as never,
          RAW,
          'sha256=bad',
        ),
      ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
      expect(webhooks.save).not.toHaveBeenCalled();
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
        tenantId: TENANT,
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
        tenantId: TENANT,
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
        tenantId: TENANT,
      });
    });

    // ── FND-023: routes status to the unified conversation timeline ────────
    describe('FND-023 — also routes status to the unified conversation timeline', () => {
      it('a delivered status for a matching conversation message calls markDelivered', async () => {
        messages.findOne.mockResolvedValueOnce({ id: 'msg-1' });
        webhooks.findOne.mockResolvedValueOnce({
          id: 'evt-6',
          processed: false,
          event_type: 'message_status',
          payload: statusBody('wamid.20', 'delivered'),
          tenant: { id: TENANT },
        });

        await service.processEvent('evt-6');

        expect(messages.findOne).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { tenant: { id: TENANT }, wa_message_id: 'wamid.20' },
          }),
        );
        expect(messageStatus.markDelivered).toHaveBeenCalledWith(
          TENANT,
          'msg-1',
        );
        expect(messageStatus.markRead).not.toHaveBeenCalled();
      });

      it('a read status for a matching conversation message calls markRead', async () => {
        messages.findOne.mockResolvedValueOnce({ id: 'msg-2' });
        webhooks.findOne.mockResolvedValueOnce({
          id: 'evt-7',
          processed: false,
          event_type: 'message_status',
          payload: statusBody('wamid.21', 'read'),
          tenant: { id: TENANT },
        });

        await service.processEvent('evt-7');

        expect(messageStatus.markRead).toHaveBeenCalledWith(TENANT, 'msg-2');
        expect(messageStatus.markDelivered).not.toHaveBeenCalled();
      });

      it('a failed status for a matching conversation message calls markFailed', async () => {
        messages.findOne.mockResolvedValueOnce({ id: 'msg-3' });
        webhooks.findOne.mockResolvedValueOnce({
          id: 'evt-8',
          processed: false,
          event_type: 'message_status',
          payload: statusBody('wamid.22', 'failed'),
          tenant: { id: TENANT },
        });

        await service.processEvent('evt-8');

        expect(messageStatus.markFailed).toHaveBeenCalledWith(TENANT, 'msg-3');
      });

      it('a wamid matching no conversation message is a harmless no-op (notification/campaign send, not a conversation reply)', async () => {
        messages.findOne.mockResolvedValueOnce(null);
        webhooks.findOne.mockResolvedValueOnce({
          id: 'evt-9',
          processed: false,
          event_type: 'message_status',
          payload: statusBody('wamid.23', 'delivered'),
          tenant: { id: TENANT },
        });

        await service.processEvent('evt-9');

        expect(messageStatus.markDelivered).not.toHaveBeenCalled();
        // The OTHER two axes still ran — a wamid only ever matches one table.
        expect(recipientDelivery.recordDelivery).toHaveBeenCalled();
      });

      it("a 'sent' status is not forwarded to the timeline (SENT is already recorded at message creation)", async () => {
        webhooks.findOne.mockResolvedValueOnce({
          id: 'evt-10',
          processed: false,
          event_type: 'message_status',
          payload: statusBody('wamid.24', 'sent'),
          tenant: { id: TENANT },
        });

        await service.processEvent('evt-10');

        expect(messages.findOne).not.toHaveBeenCalled();
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

      expect(res).toMatchObject({
        processed: false,
        reason: 'already-processed',
      });
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

  describe('Coexistence — smb_message_echoes / smb_app_state_sync / history', () => {
    it('ingests an echo, deriving a stable "echo:{wamid}" idempotency key', async () => {
      const res = await service.ingest(echoBody('echo.1'), RAW, 'sha256=ok');

      expect(res).toMatchObject({ accepted: true });
      expect(webhooks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'smb_message_echoes',
          idempotency_key: 'echo:echo.1',
        }),
      );
    });

    it('deduplicates a redelivered echo on the same wamid', async () => {
      webhooks.findOne.mockResolvedValueOnce({ id: 'existing-echo' });

      const res = await service.ingest(echoBody('echo.1'), RAW, 'sha256=ok');

      expect(res).toMatchObject({
        accepted: true,
        id: 'existing-echo',
        deduplicated: true,
      });
      expect(webhooks.save).not.toHaveBeenCalled();
    });

    it('ingests a history/state-sync webhook with a content-hash idempotency key (unasserted schema)', async () => {
      const res = await service.ingest(
        syncConfirmationBody('smb_app_state_sync', '1700000000'),
        RAW,
        'sha256=ok',
      );

      expect(res).toMatchObject({ accepted: true });
      const key = webhooks.create.mock.calls[0][0].idempotency_key as string;
      expect(key).toMatch(/^smb_app_state_sync:[0-9a-f]{64}$/);
    });

    it('deduplicates two IDENTICAL history payloads via the content hash, without a `findOne` hit (hash collision only, not a stored row)', async () => {
      // Same payload twice -> same hash -> same idempotency_key -> the second
      // insert collides on the DB's partial unique index, exactly like any
      // other duplicate — proven here via the same 23505-recovery path other
      // event types already rely on.
      const err = Object.assign(new Error('duplicate key'), { code: '23505' });
      webhooks.save.mockRejectedValueOnce(err);
      webhooks.findOne.mockResolvedValueOnce(undefined);
      webhooks.findOne.mockResolvedValueOnce({ id: 'winner-history-row' });

      const res = await service.ingest(
        syncConfirmationBody('history', '1700000000'),
        RAW,
        'sha256=ok',
      );

      expect(res).toMatchObject({
        accepted: true,
        id: 'winner-history-row',
        deduplicated: true,
      });
    });

    it('does not reject a history/state-sync webhook for lacking a timestamp (freshness check is scoped away from these two fields)', async () => {
      await expect(
        service.ingest(
          syncConfirmationBody('smb_app_state_sync'),
          RAW,
          'sha256=ok',
        ),
      ).resolves.toMatchObject({ accepted: true });
    });

    it('processEvent routes smb_message_echoes to WhatsappCoexistenceEchoService, never to the AI bridge', async () => {
      const value = echoBody('echo.2').entry[0].changes[0].value;
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-echo',
        processed: false,
        event_type: 'smb_message_echoes',
        payload: echoBody('echo.2'),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-echo');

      expect(coexistenceEcho.handleEchoes).toHaveBeenCalledWith(TENANT, value);
      expect(inboundAi.handleInboundValue).not.toHaveBeenCalled();
    });

    it('confirms a state-sync webhook by flipping IN_PROGRESS -> COMPLETED for the matching account', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        coexistence_state_sync_status: 'IN_PROGRESS',
      });
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-sync',
        processed: false,
        event_type: 'smb_app_state_sync',
        payload: syncConfirmationBody('smb_app_state_sync'),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-sync');

      expect(accounts.update).toHaveBeenCalledWith('acc-1', {
        coexistence_state_sync_status: 'COMPLETED',
        coexistence_state_sync_at: expect.any(Date),
      });
    });

    it('confirms a history webhook the same way, on its own status field', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        coexistence_history_sync_status: 'IN_PROGRESS',
      });
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-history',
        processed: false,
        event_type: 'history',
        payload: syncConfirmationBody('history'),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-history');

      expect(accounts.update).toHaveBeenCalledWith('acc-1', {
        coexistence_history_sync_status: 'COMPLETED',
        coexistence_history_sync_at: expect.any(Date),
      });
    });

    it('ignores a confirmation when the account is not IN_PROGRESS (never overwrites COMPLETED or FAILED)', async () => {
      accounts.findOne.mockResolvedValueOnce({
        id: 'acc-1',
        coexistence_state_sync_status: 'COMPLETED',
      });
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-sync-2',
        processed: false,
        event_type: 'smb_app_state_sync',
        payload: syncConfirmationBody('smb_app_state_sync'),
        tenant: { id: TENANT },
      });

      await service.processEvent('evt-sync-2');

      expect(accounts.update).not.toHaveBeenCalled();
    });

    it('ignores a confirmation for a phone_number_id matching no live account (never throws the worker job)', async () => {
      accounts.findOne.mockResolvedValueOnce(null);
      webhooks.findOne.mockResolvedValueOnce({
        id: 'evt-sync-3',
        processed: false,
        event_type: 'smb_app_state_sync',
        payload: syncConfirmationBody('smb_app_state_sync'),
        tenant: { id: TENANT },
      });

      await expect(service.processEvent('evt-sync-3')).resolves.toMatchObject({
        processed: true,
      });
      expect(accounts.update).not.toHaveBeenCalled();
    });
  });
});
