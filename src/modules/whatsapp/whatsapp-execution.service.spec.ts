import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappExecutionService } from './whatsapp-execution.service';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { QueueService } from '../../queue/queue.service';
import { UsageService } from '../subscription-billing/usage.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WHATSAPP_DELIVERY_STATUS } from './whatsapp.constants';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const ACCOUNT = { id: 'acc-1', mode: 'REAL', phoneNumberId: 'pid-1', source: 'TENANT' as const };
const TEMPLATE = { id: 'tpl-1', name: 'welcome', language: 'en' };

describe('WhatsappExecutionService', () => {
  let service: WhatsappExecutionService;
  let logs: MockRepository;
  let contacts: MockRepository;
  let customers: MockRepository;
  let router: { resolveForSend: jest.Mock };
  let templates: { getSendableTemplate: jest.Mock };
  let messaging: { send: jest.Mock };
  let queue: { enqueueWhatsappSend: jest.Mock };
  let usage: { assertWithinLimit: jest.Mock; increment: jest.Mock };

  beforeEach(async () => {
    logs = createMockRepository();
    contacts = createMockRepository();
    customers = createMockRepository();
    logs.create.mockImplementation((v: object) => ({ ...v }));
    logs.save.mockImplementation(async (v: object) => ({ id: 'log-1', ...v }));

    router = { resolveForSend: jest.fn().mockResolvedValue(ACCOUNT) };
    templates = { getSendableTemplate: jest.fn().mockResolvedValue(TEMPLATE) };
    messaging = { send: jest.fn().mockResolvedValue({ success: true, providerMessageId: 'wamid.1' }) };
    queue = { enqueueWhatsappSend: jest.fn().mockResolvedValue(undefined) };
    usage = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappExecutionService,
        { provide: getRepositoryToken(NotificationLog), useValue: logs },
        { provide: getRepositoryToken(WhatsappContact), useValue: contacts },
        { provide: getRepositoryToken(Customer), useValue: customers },
        { provide: WhatsappMessageRouter, useValue: router },
        { provide: WhatsappTemplateService, useValue: templates },
        { provide: WhatsappMessagingService, useValue: messaging },
        { provide: QueueService, useValue: queue },
        { provide: UsageService, useValue: usage },
        { provide: TenantContextService, useValue: new TenantContextService() },
      ],
    }).compile();
    service = moduleRef.get(WhatsappExecutionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('sendTemplateMessage', () => {
    it('resolves account/template/recipient, checks quota, sends, and records a SENT log', async () => {
      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

      expect(usage.assertWithinLimit).toHaveBeenCalledWith(TENANT, expect.any(String), 1);
      expect(messaging.send).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, accountId: ACCOUNT.id, to: '966500000000', templateId: TEMPLATE.id }),
      );
      expect(usage.increment).toHaveBeenCalledWith(TENANT, expect.any(String), 1);
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT, providerMessageId: 'wamid.1' });
    });

    it('does NOT meter usage when the provider reports failure', async () => {
      messaging.send.mockResolvedValueOnce({ success: false, error: 'template paused' });

      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

      expect(usage.increment).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.FAILED, error: 'template paused' });
    });

    it('catches a provider throw and records it as a failed send rather than propagating', async () => {
      messaging.send.mockRejectedValueOnce(new Error('ECONNRESET'));

      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.FAILED, error: 'ECONNRESET' });
      expect(usage.increment).not.toHaveBeenCalled();
    });

    it('resolves a contact recipient and rejects one with no wa_id', async () => {
      contacts.findOne.mockResolvedValueOnce({ id: 'c1', wa_id: null });

      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', { contactId: 'c1' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    it('requires exactly one recipient selector', async () => {
      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', {} as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('propagates quota exhaustion before ever calling the provider', async () => {
      usage.assertWithinLimit.mockRejectedValueOnce(
        Object.assign(new Error('quota exceeded'), { code: ErrorCode.UNPROCESSABLE_ENTITY }),
      );

      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any),
      ).rejects.toThrow('quota exceeded');
      expect(messaging.send).not.toHaveBeenCalled();
    });

    // ── FND-024 — RED: this is the "ad-hoc path checks consent not at all"
    // half of the finding. resolveRecipient() only ever reads
    // `customer.phone`; nothing here reads an opt-out signal, so a customer
    // who has told the business "STOP" over WhatsApp still receives manual/
    // scheduled sends through this seam. The campaign path is a SEPARATE gap
    // — see campaign-dispatch.service.spec.ts's consent block, corrected to
    // that file since campaign.service.ts (named in tasks.md) is pure CRUD
    // with no dispatch/consent logic.
    describe('opt-out suppression (FND-024 — ad-hoc/direct send path)', () => {
      it('[FND-024] refuses to send to a customer who has opted out via an inbound message, before ever calling the provider', async () => {
        customers.findOne.mockResolvedValueOnce({
          id: 'cust-1',
          phone: '966500000000',
          opted_out_at: new Date('2026-01-01T00:00:00Z'),
        });

        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-1', { customerId: 'cust-1' } as any),
        ).rejects.toThrow();
        expect(messaging.send).not.toHaveBeenCalled();
      });

      it('still sends to a customer who has never opted out (regression guard)', async () => {
        customers.findOne.mockResolvedValueOnce({
          id: 'cust-1',
          phone: '966500000000',
          opted_out_at: null,
        });

        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { customerId: 'cust-1' } as any);

        expect(messaging.send).toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });

      it('a raw toWaId send with no linked customer is unaffected — nothing to check consent against (regression guard)', async () => {
        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

        expect(messaging.send).toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });
    });

    // ── FND-021 — RED: the DTO already declares an optional `variables` field
    // (contrary to contracts/api-contracts.md's framing of it as a NEW field —
    // recorded here since the actual gap is narrower: no pre-flight check that
    // a template's declared placeholders are actually satisfied before the
    // provider call, and the manual Send dialog has no UI to enter them at
    // all). `template.components` uses the REAL stored shape
    // (`{ components: [{ type: 'BODY', text: '...' }] }` — confirmed in
    // whatsapp-template-sync.service.spec.ts's "wraps Meta's array into the
    // jsonb object column").
    describe('template-variable completeness (FND-021 — manual templated send)', () => {
      const TEMPLATE_WITH_VARS = {
        id: 'tpl-2',
        name: 'appointment_reminder',
        language: 'en',
        components: { components: [{ type: 'BODY', text: 'Hi {{1}}, your appointment is on {{2}}.' }] },
      };

      it('[FND-021] refuses a send missing a declared placeholder, before ever calling the provider', async () => {
        templates.getSendableTemplate.mockResolvedValueOnce(TEMPLATE_WITH_VARS);

        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-2', {
            toWaId: '966500000000',
            variables: { '1': 'Sara' }, // missing "2"
          } as any),
        ).rejects.toThrow();
        expect(messaging.send).not.toHaveBeenCalled();
      });

      it('[FND-021] refuses a send with no variables at all when the template declares placeholders', async () => {
        templates.getSendableTemplate.mockResolvedValueOnce(TEMPLATE_WITH_VARS);

        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-2', { toWaId: '966500000000' } as any),
        ).rejects.toThrow();
        expect(messaging.send).not.toHaveBeenCalled();
      });

      it('sends when every declared placeholder is supplied (regression guard)', async () => {
        templates.getSendableTemplate.mockResolvedValueOnce(TEMPLATE_WITH_VARS);

        const res = await service.sendTemplateMessage(TENANT, 'tpl-2', {
          toWaId: '966500000000',
          variables: { '1': 'Sara', '2': '2026-06-15 10:00' },
        } as any);

        expect(messaging.send).toHaveBeenCalledWith(
          expect.objectContaining({ variables: { '1': 'Sara', '2': '2026-06-15 10:00' } }),
        );
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });

      it('a template with no recorded components imposes no variable requirement (regression guard — pre-existing/not-yet-synced templates)', async () => {
        // TEMPLATE (the default fixture) has no `components` at all.
        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);

        expect(messaging.send).toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });
    });

    describe('claim (gap-closure pass — atomic QUEUED -> SENDING, §0.8.11)', () => {
      it('claims the log row (QUEUED -> SENDING) before sending, then updates that SAME row in place', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({ id: 'log-1', status: WHATSAPP_DELIVERY_STATUS.SENT });

        const res = await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

        expect(qb.update).toHaveBeenCalled();
        expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.SENDING }));
        expect(messaging.send).toHaveBeenCalled();
        expect(logs.update).toHaveBeenCalledWith({ id: 'log-1' }, expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.SENT }));
        expect(logs.create).not.toHaveBeenCalled(); // no SECOND row created
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });

      it('skips the send entirely when the claim affects zero rows (already claimed/handled — redelivered job)', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 0 });

        const res = await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

        expect(messaging.send).not.toHaveBeenCalled();
        expect(res).toMatchObject({ duplicate: true, logId: 'log-1' });
      });

      it('does not attempt a claim when no claim is supplied (immediate/campaign send paths unaffected)', async () => {
        await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);
        expect(logs.createQueryBuilder).not.toHaveBeenCalled();
        expect(messaging.send).toHaveBeenCalled();
      });
    });

    describe('claim recovery — stale SENDING is reclaimable (gap-closure pass, §0.8.5)', () => {
      it('the claim WHERE clause allows a SENDING row whose claimed_at is stale/NULL, not just QUEUED — otherwise a crashed mid-send worker blocks retry forever', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({ id: 'log-1', status: WHATSAPP_DELIVERY_STATUS.SENT });

        await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any, { logId: 'log-1' });

        expect(qb.where).toHaveBeenCalledWith(
          expect.stringContaining('status = :sending AND (claimed_at IS NULL OR claimed_at < :staleCutoff)'),
          expect.objectContaining({ logId: 'log-1', tenantId: TENANT }),
        );
        // The claim itself stamps a fresh claimed_at, so a genuinely-fresh
        // in-flight SENDING (not yet stale) is never matched by this same claim.
        expect(qb.set).toHaveBeenCalledWith(expect.objectContaining({ claimed_at: expect.any(Function) }));
      });

      it('a redelivered job successfully reclaims a stale SENDING row and sends for real (does not report it as a duplicate)', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        // affected: 1 simulates the WHERE clause's SENDING+stale branch matching.
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({ id: 'log-1', status: WHATSAPP_DELIVERY_STATUS.SENT });

        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any, { logId: 'log-1' });

        expect(messaging.send).toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
        expect((res as { duplicate?: boolean }).duplicate).toBeUndefined();
      });
    });

    describe('reconciliation — stale reclaim with a prior provider_ref already on file (gap-closure pass, §0.11)', () => {
      it('does NOT call the provider again when the reclaimed row already has a provider_ref — reconciles to SENT instead', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        // Pre-claim read (inside claimQueuedLog) finds a prior attempt already
        // recorded a wamid before crashing — the row we are about to reclaim.
        (logs.findOne as jest.Mock).mockResolvedValueOnce({ id: 'log-1', provider_ref: 'wamid.PRIOR' });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({ id: 'log-1', status: WHATSAPP_DELIVERY_STATUS.SENT });

        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any, { logId: 'log-1' });

        expect(messaging.send).not.toHaveBeenCalled();
        expect(usage.increment).not.toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT, providerMessageId: 'wamid.PRIOR', reconciled: true });
        expect(logs.update).toHaveBeenCalledWith(
          { id: 'log-1' },
          expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.SENT, provider_ref: 'wamid.PRIOR' }),
        );
      });

      it('persists provider_ref on a normal (non-reconciled) successful send, so a FUTURE stale reclaim could detect it', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOne as jest.Mock).mockResolvedValueOnce(null); // fresh QUEUED claim, no prior attempt
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({ id: 'log-1', status: WHATSAPP_DELIVERY_STATUS.SENT });

        await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any, { logId: 'log-1' });

        expect(messaging.send).toHaveBeenCalled();
        expect(logs.update).toHaveBeenCalledWith(
          { id: 'log-1' },
          expect.objectContaining({ provider_ref: 'wamid.1' }),
        );
      });
    });
  });

  describe('claimBySourceRef / finalizeBySourceRef (gap-closure pass, §0.11 — workflow session-send idempotency)', () => {
    it('claims by inserting a SENDING row keyed on sourceRef', async () => {
      const res = await service.claimBySourceRef(TENANT, 'WHATSAPP', 'workflow-action:run-1:0');

      expect(logs.create).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'WHATSAPP', status: WHATSAPP_DELIVERY_STATUS.SENDING, source_ref: 'workflow-action:run-1:0' }),
      );
      expect(res.claimed).toBe(true);
    });

    it('reports NOT claimed and returns the existing row when the unique index rejects a second insert for the same sourceRef', async () => {
      const existing = { id: 'log-existing', source_ref: 'workflow-action:run-1:0', status: WHATSAPP_DELIVERY_STATUS.SENT };
      logs.save.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
      (logs.findOneBy as jest.Mock).mockResolvedValueOnce(existing);

      const res = await service.claimBySourceRef(TENANT, 'WHATSAPP', 'workflow-action:run-1:0');

      expect(res).toEqual({ claimed: false, log: existing });
    });

    it('propagates a non-unique-violation error rather than swallowing it', async () => {
      logs.save.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.claimBySourceRef(TENANT, 'WHATSAPP', 'workflow-action:run-1:0')).rejects.toThrow('connection reset');
    });

    it('finalizeBySourceRef updates the SAME claimed row in place', async () => {
      await service.finalizeBySourceRef('log-1', WHATSAPP_DELIVERY_STATUS.SENT, { providerRef: 'wamid.9', sentAt: new Date() });

      expect(logs.update).toHaveBeenCalledWith(
        { id: 'log-1' },
        expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.SENT, provider_ref: 'wamid.9' }),
      );
    });
  });

  describe('scheduleMessage', () => {
    it('validates routing/template/recipient up front and enqueues a delayed send job', async () => {
      const scheduledAt = new Date(Date.now() + 60_000).toISOString();

      const res = await service.scheduleMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
        scheduledAt,
      } as any);

      expect(router.resolveForSend).toHaveBeenCalled();
      expect(templates.getSendableTemplate).toHaveBeenCalledWith(TENANT, 'tpl-1');
      expect(queue.enqueueWhatsappSend).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, templateId: 'tpl-1' }),
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.QUEUED });
    });

    it('requires scheduledAt', async () => {
      await expect(
        service.scheduleMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(queue.enqueueWhatsappSend).not.toHaveBeenCalled();
    });
  });
});
