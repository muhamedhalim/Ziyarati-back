import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappExecutionService } from './whatsapp-execution.service';
import { NotificationLog } from '../../entities/Notifications/NotificationLog';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { Subscription } from '../../entities/SaaS-Core/Subscription';
import { SubscriptionUsage } from '../../entities/SaaS-Core/SubscriptionUsage';
import { FeatureDefinition } from '../../entities/SaaS-Core/FeatureDefinition';
import { FeaturePlan } from '../../entities/SaaS-Core/FeaturePlan';
import { FeatureFlagSource } from '../../entities/SaaS-Core/FeatureFlag';
import { FeatureKey } from '../subscription-billing/feature-registry';
import { AccessControlService } from '../subscription-billing/access-control.service';
import { BillingModeService } from '../subscription-billing/billing-mode.service';
import { FreeAccessOverrideService } from '../subscription-billing/free-access-override.service';
import { FeatureFlagService } from '../subscription-billing/feature-flag.service';
import { TenantUsageLimitOverrideService } from '../subscription-billing/tenant-usage-limit-override.service';
import { TenantEntitlementLedgerService } from '../subscription-billing/tenant-entitlement-ledger.service';
import { TenantMetricCreditsService } from '../subscription-billing/tenant-metric-credits.service';
import { SystemSettingService } from '../platform/system-setting.service';
import { WhatsappMessageRouter } from './routing/whatsapp-message.router';
import { WhatsappTemplateService } from './whatsapp-template.service';
import { WhatsappMessagingService } from './whatsapp-messaging.service';
import { QueueService } from '../../queue/queue.service';
import { UsageService } from '../subscription-billing/usage.service';
import { SubscriptionService } from '../subscription-billing/subscription.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WHATSAPP_DELIVERY_STATUS } from './whatsapp.constants';
import { ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  MockRepository,
  createMockQueryBuilder,
  createMockAccessCache,
  createMockAccessPolicyMode,
} from '../../../test/utils/mock-factories';
import { AccessCacheService } from '../subscription-billing/access-cache.service';
import { AccessPolicyModeService } from '../subscription-billing/access-policy-mode.service';

const TENANT = 't1';
const ACCOUNT = {
  id: 'acc-1',
  mode: 'REAL',
  phoneNumberId: 'pid-1',
  source: 'TENANT' as const,
};
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
  let subscriptions: { assertBillableActionAllowed: jest.Mock };
  let usage: {
    assertWithinLimit: jest.Mock;
    increment: jest.Mock;
    incrementIfWithinLimit: jest.Mock;
    release: jest.Mock;
  };

  beforeEach(async () => {
    logs = createMockRepository();
    contacts = createMockRepository();
    customers = createMockRepository();
    logs.create.mockImplementation((v: object) => ({ ...v }));
    logs.save.mockImplementation(async (v: object) => ({ id: 'log-1', ...v }));

    router = { resolveForSend: jest.fn().mockResolvedValue(ACCOUNT) };
    templates = { getSendableTemplate: jest.fn().mockResolvedValue(TEMPLATE) };
    messaging = {
      send: jest
        .fn()
        .mockResolvedValue({ success: true, providerMessageId: 'wamid.1' }),
    };
    queue = { enqueueWhatsappSend: jest.fn().mockResolvedValue(undefined) };
    usage = {
      assertWithinLimit: jest.fn().mockResolvedValue(undefined),
      increment: jest.fn().mockResolvedValue(undefined),
      incrementIfWithinLimit: jest
        .fn()
        .mockResolvedValue({ applied: true, used: 0, limit: 100 }),
      release: jest.fn().mockResolvedValue(undefined),
    };
    subscriptions = {
      assertBillableActionAllowed: jest.fn().mockResolvedValue(undefined),
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
        { provide: SubscriptionService, useValue: subscriptions },
      ],
    }).compile();
    service = moduleRef.get(WhatsappExecutionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('sendTemplateMessage', () => {
    describe('outbound content policy and marketing consent (residency plan P5)', () => {
      const BODY = (text: string) => ({ components: [{ type: 'BODY', text }] });

      it('refuses a variable carrying a national ID, and never reaches the provider or the quota', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          components: BODY('Hello {{1}}, your visit is on {{2}}'),
        });
        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-1', {
            toWaId: '966500000000',
            variables: { 1: 'Sara', 2: '1012345678' },
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
        expect(messaging.send).not.toHaveBeenCalled();
        expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
      });

      it('refuses a clinical term in a variable, and the refusal names the variable but not its value', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          components: BODY('Hello {{1}}, {{2}}'),
        });
        let message = '';
        try {
          await service.sendTemplateMessage(TENANT, 'tpl-1', {
            toWaId: '966500000000',
            variables: { 1: 'Sara', 2: 'your lab results are ready' },
          } as any);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toContain('clinical_term in "2"');
        expect(message).not.toContain('lab results');
        expect(messaging.send).not.toHaveBeenCalled();
      });

      it('refuses an identifier that only appears once the body is rendered', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          components: BODY('Your reference is {{1}}'),
        });
        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-1', {
            toWaId: '966500000000',
            variables: { 1: '4111 1111 1111 1111' },
          } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      });

      it('finalises a CLAIMED log row as FAILED instead of stranding it in SENDING', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          components: BODY('Hi {{1}}'),
        });
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({ id: 'log-9' });

        await expect(
          service.sendTemplateMessage(
            TENANT,
            'tpl-1',
            { toWaId: '966500000000', variables: { 1: '1012345678' } } as any,
            { logId: 'log-9' },
          ),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });

        expect(messaging.send).not.toHaveBeenCalled();
        expect(logs.update).toHaveBeenCalledWith(
          { id: 'log-9' },
          expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.FAILED }),
        );
        const patch = (logs.update as jest.Mock).mock.calls[0][1];
        expect(patch.error_message).toContain('content policy');
        expect(patch.error_message).not.toContain('1012345678');
      });

      it('lets an ordinary appointment notice through', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          components: BODY('Hi {{1}}, your appointment is on {{2}} at {{3}}'),
        });
        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
          variables: { 1: 'Sara', 2: '2026-10-07', 3: '09:30' },
        } as any);
        expect(res.status).toBe(WHATSAPP_DELIVERY_STATUS.SENT);
      });

      it('refuses a MARKETING template to a customer without marketing consent', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          category: 'MARKETING',
        });
        customers.findOne.mockResolvedValue({
          id: 'c1',
          phone: '966500000000',
          marketing_opt_in: false,
          opted_out_at: null,
        });
        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-1', { customerId: 'c1' } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
        expect(messaging.send).not.toHaveBeenCalled();
      });

      it('refuses a MARKETING template to a raw number (no consent record exists)', async () => {
        templates.getSendableTemplate.mockResolvedValue({
          ...TEMPLATE,
          category: 'marketing',
        });
        await expect(
          service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any),
        ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
      });

      it('sends a MARKETING template to a consenting customer, and UTILITY to anyone', async () => {
        customers.findOne.mockResolvedValue({
          id: 'c1',
          phone: '966500000000',
          marketing_opt_in: true,
          opted_out_at: null,
        });
        templates.getSendableTemplate.mockResolvedValue({ ...TEMPLATE, category: 'MARKETING' });
        const marketing = await service.sendTemplateMessage(TENANT, 'tpl-1', { customerId: 'c1' } as any);
        expect(marketing.status).toBe(WHATSAPP_DELIVERY_STATUS.SENT);

        templates.getSendableTemplate.mockResolvedValue({ ...TEMPLATE, category: 'UTILITY' });
        const utility = await service.sendTemplateMessage(TENANT, 'tpl-1', { toWaId: '966500000000' } as any);
        expect(utility.status).toBe(WHATSAPP_DELIVERY_STATUS.SENT);
      });
    });

    it('resolves account/template/recipient, reserves quota atomically, sends, and records a SENT log', async () => {
      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any);

      // FND-034: reserved atomically BEFORE the provider call (no separate
      // later increment() — see UsageService.incrementIfWithinLimit).
      expect(usage.incrementIfWithinLimit).toHaveBeenCalledWith(
        TENANT,
        expect.any(String),
        1,
      );
      expect(messaging.send).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          accountId: ACCOUNT.id,
          to: '966500000000',
          templateId: TEMPLATE.id,
        }),
      );
      expect(usage.release).not.toHaveBeenCalled();
      expect(res).toMatchObject({
        status: WHATSAPP_DELIVERY_STATUS.SENT,
        providerMessageId: 'wamid.1',
      });
    });

    // FND-034: quota is reserved BEFORE the send now, so a provider failure
    // must RELEASE it — net cost is still zero for a failed send, unchanged.
    it('releases the reservation when the provider reports failure', async () => {
      messaging.send.mockResolvedValueOnce({
        success: false,
        error: 'template paused',
      });

      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any);

      expect(usage.incrementIfWithinLimit).toHaveBeenCalled();
      expect(usage.release).toHaveBeenCalledWith(TENANT, expect.any(String), 1);
      expect(res).toMatchObject({
        status: WHATSAPP_DELIVERY_STATUS.FAILED,
        error: 'template paused',
      });
    });

    it('catches a provider throw, releases the reservation, and records it as a failed send rather than propagating', async () => {
      messaging.send.mockRejectedValueOnce(new Error('ECONNRESET'));

      const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any);

      expect(res).toMatchObject({
        status: WHATSAPP_DELIVERY_STATUS.FAILED,
        error: 'ECONNRESET',
      });
      expect(usage.release).toHaveBeenCalledWith(TENANT, expect.any(String), 1);
    });

    it('resolves a contact recipient and rejects one with no wa_id', async () => {
      contacts.findOne.mockResolvedValueOnce({ id: 'c1', wa_id: null });

      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', {
          contactId: 'c1',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    });

    // FND-031/T082 — repeated at this shared seam so a queued/worker call is
    // covered too, not just the HTTP path (SubscriptionAccessGuard).
    it('refuses to send once grace-expired (before ever calling the provider)', async () => {
      subscriptions.assertBillableActionAllowed.mockRejectedValueOnce(
        Object.assign(new Error('grace expired'), {
          code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED,
        }),
      );
      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.SUBSCRIPTION_GRACE_EXPIRED });
      expect(messaging.send).not.toHaveBeenCalled();
    });

    it('requires exactly one recipient selector', async () => {
      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', {} as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('propagates quota exhaustion before ever calling the provider', async () => {
      usage.incrementIfWithinLimit.mockResolvedValueOnce({
        applied: false,
        used: 100,
        limit: 100,
      });

      await expect(
        service.sendTemplateMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
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
          service.sendTemplateMessage(TENANT, 'tpl-1', {
            customerId: 'cust-1',
          } as any),
        ).rejects.toThrow();
        expect(messaging.send).not.toHaveBeenCalled();
      });

      it('still sends to a customer who has never opted out (regression guard)', async () => {
        customers.findOne.mockResolvedValueOnce({
          id: 'cust-1',
          phone: '966500000000',
          opted_out_at: null,
        });

        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
          customerId: 'cust-1',
        } as any);

        expect(messaging.send).toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });

      it('a raw toWaId send with no linked customer is unaffected — nothing to check consent against (regression guard)', async () => {
        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
        } as any);

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
        components: {
          components: [
            { type: 'BODY', text: 'Hi {{1}}, your appointment is on {{2}}.' },
          ],
        },
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
          service.sendTemplateMessage(TENANT, 'tpl-2', {
            toWaId: '966500000000',
          } as any),
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
          expect.objectContaining({
            variables: { '1': 'Sara', '2': '2026-06-15 10:00' },
          }),
        );
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });

      it('a template with no recorded components imposes no variable requirement (regression guard — pre-existing/not-yet-synced templates)', async () => {
        // TEMPLATE (the default fixture) has no `components` at all.
        const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
        } as any);

        expect(messaging.send).toHaveBeenCalled();
        expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.SENT });
      });
    });

    describe('claim (gap-closure pass — atomic QUEUED -> SENDING, §0.8.11)', () => {
      it('claims the log row (QUEUED -> SENDING) before sending, then updates that SAME row in place', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({
          id: 'log-1',
          status: WHATSAPP_DELIVERY_STATUS.SENT,
        });

        const res = await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

        expect(qb.update).toHaveBeenCalled();
        expect(qb.set).toHaveBeenCalledWith(
          expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.SENDING }),
        );
        expect(messaging.send).toHaveBeenCalled();
        expect(logs.update).toHaveBeenCalledWith(
          { id: 'log-1' },
          expect.objectContaining({ status: WHATSAPP_DELIVERY_STATUS.SENT }),
        );
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
        await service.sendTemplateMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
        } as any);
        expect(logs.createQueryBuilder).not.toHaveBeenCalled();
        expect(messaging.send).toHaveBeenCalled();
      });
    });

    describe('claim recovery — stale SENDING is reclaimable (gap-closure pass, §0.8.5)', () => {
      it('the claim WHERE clause allows a SENDING row whose claimed_at is stale/NULL, not just QUEUED — otherwise a crashed mid-send worker blocks retry forever', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({
          id: 'log-1',
          status: WHATSAPP_DELIVERY_STATUS.SENT,
        });

        await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

        expect(qb.where).toHaveBeenCalledWith(
          expect.stringContaining(
            'status = :sending AND (claimed_at IS NULL OR claimed_at < :staleCutoff)',
          ),
          expect.objectContaining({ logId: 'log-1', tenantId: TENANT }),
        );
        // The claim itself stamps a fresh claimed_at, so a genuinely-fresh
        // in-flight SENDING (not yet stale) is never matched by this same claim.
        expect(qb.set).toHaveBeenCalledWith(
          expect.objectContaining({ claimed_at: expect.any(Function) }),
        );
      });

      it('a redelivered job successfully reclaims a stale SENDING row and sends for real (does not report it as a duplicate)', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        // affected: 1 simulates the WHERE clause's SENDING+stale branch matching.
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({
          id: 'log-1',
          status: WHATSAPP_DELIVERY_STATUS.SENT,
        });

        const res = await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

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
        (logs.findOne as jest.Mock).mockResolvedValueOnce({
          id: 'log-1',
          provider_ref: 'wamid.PRIOR',
        });
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({
          id: 'log-1',
          status: WHATSAPP_DELIVERY_STATUS.SENT,
        });

        const res = await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

        expect(messaging.send).not.toHaveBeenCalled();
        expect(usage.incrementIfWithinLimit).not.toHaveBeenCalled();
        expect(res).toMatchObject({
          status: WHATSAPP_DELIVERY_STATUS.SENT,
          providerMessageId: 'wamid.PRIOR',
          reconciled: true,
        });
        expect(logs.update).toHaveBeenCalledWith(
          { id: 'log-1' },
          expect.objectContaining({
            status: WHATSAPP_DELIVERY_STATUS.SENT,
            provider_ref: 'wamid.PRIOR',
          }),
        );
      });

      it('persists provider_ref on a normal (non-reconciled) successful send, so a FUTURE stale reclaim could detect it', async () => {
        const qb = logs.createQueryBuilder();
        (logs.createQueryBuilder as jest.Mock).mockReturnValue(qb);
        (qb.execute as jest.Mock).mockResolvedValueOnce({ affected: 1 });
        (logs.findOne as jest.Mock).mockResolvedValueOnce(null); // fresh QUEUED claim, no prior attempt
        (logs.findOneBy as jest.Mock).mockResolvedValueOnce({
          id: 'log-1',
          status: WHATSAPP_DELIVERY_STATUS.SENT,
        });

        await service.sendTemplateMessage(
          TENANT,
          'tpl-1',
          { toWaId: '966500000000' } as any,
          { logId: 'log-1' },
        );

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
      const res = await service.claimBySourceRef(
        TENANT,
        'WHATSAPP',
        'workflow-action:run-1:0',
      );

      expect(logs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'WHATSAPP',
          status: WHATSAPP_DELIVERY_STATUS.SENDING,
          source_ref: 'workflow-action:run-1:0',
        }),
      );
      expect(res.claimed).toBe(true);
    });

    it('reports NOT claimed and returns the existing row when the unique index rejects a second insert for the same sourceRef', async () => {
      const existing = {
        id: 'log-existing',
        source_ref: 'workflow-action:run-1:0',
        status: WHATSAPP_DELIVERY_STATUS.SENT,
      };
      logs.save.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      (logs.findOneBy as jest.Mock).mockResolvedValueOnce(existing);

      const res = await service.claimBySourceRef(
        TENANT,
        'WHATSAPP',
        'workflow-action:run-1:0',
      );

      expect(res).toEqual({ claimed: false, log: existing });
    });

    it('propagates a non-unique-violation error rather than swallowing it', async () => {
      logs.save.mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        service.claimBySourceRef(TENANT, 'WHATSAPP', 'workflow-action:run-1:0'),
      ).rejects.toThrow('connection reset');
    });

    it('finalizeBySourceRef updates the SAME claimed row in place', async () => {
      await service.finalizeBySourceRef(
        'log-1',
        WHATSAPP_DELIVERY_STATUS.SENT,
        { providerRef: 'wamid.9', sentAt: new Date() },
      );

      expect(logs.update).toHaveBeenCalledWith(
        { id: 'log-1' },
        expect.objectContaining({
          status: WHATSAPP_DELIVERY_STATUS.SENT,
          provider_ref: 'wamid.9',
        }),
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
      expect(templates.getSendableTemplate).toHaveBeenCalledWith(
        TENANT,
        'tpl-1',
      );
      expect(queue.enqueueWhatsappSend).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, templateId: 'tpl-1' }),
        expect.objectContaining({ delay: expect.any(Number) }),
      );
      expect(res).toMatchObject({ status: WHATSAPP_DELIVERY_STATUS.QUEUED });
    });

    it('requires scheduledAt', async () => {
      await expect(
        service.scheduleMessage(TENANT, 'tpl-1', {
          toWaId: '966500000000',
        } as any),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(queue.enqueueWhatsappSend).not.toHaveBeenCalled();
    });
  });
});

/**
 * Admin free access, end-to-end through the REAL usage/access chain.
 *
 * The suite above mocks UsageService wholesale, so it cannot see the defect
 * this covers: `POST /whatsapp/templates/:id/send` returned
 * "No active subscription found for this tenant" for a clinic the super admin
 * had explicitly granted access to. `SubscriptionAccessGuard` admitted the
 * request (feature override), then `UsageService.incrementIfWithinLimit` →
 * `resolveSubscription()` demanded a subscription that, by design, does not
 * exist. Here the real UsageService + real AccessControlService are wired up so
 * the send path is exercised exactly as production runs it; only repositories
 * and the leaf platform services are stubbed.
 */
describe('WhatsappExecutionService — admin free access (real UsageService + AccessControlService)', () => {
  let service: WhatsappExecutionService;
  let messaging: { send: jest.Mock };
  let subscriptionRepo: MockRepository;
  let usageRepo: MockRepository;
  let featureDefsRepo: MockRepository;
  let featurePlansRepo: MockRepository;
  let billingMode: { isPaidMode: jest.Mock };
  let freeOverrides: { hasActive: jest.Mock; getActive: jest.Mock };
  let featureFlags: { getStates: jest.Mock };

  /** An authoritative super-admin grant for `keys`. */
  const grantOf = (...keys: FeatureKey[]) =>
    new Map(
      keys.map((k) => [
        k,
        {
          granted: true,
          suspended: false,
          source: FeatureFlagSource.PLATFORM_ADMIN,
        },
      ]),
    );

  async function build() {
    const logs = createMockRepository();
    const contacts = createMockRepository();
    const customers = createMockRepository();
    logs.create.mockImplementation((v: object) => ({ ...v }));
    logs.save.mockImplementation(async (v: object) => ({ id: 'log-1', ...v }));

    subscriptionRepo = createMockRepository();
    // T045 (015-db-api-efficiency-audit, P7-2/ORM-001): UsageService's
    // findCurrentSubscriptionWithPlan now reads the tenant FK column via
    // entity metadata (R-11) instead of `findOne({ relations })`.
    (subscriptionRepo as unknown as { metadata: unknown }).metadata = {
      name: 'Subscription',
      findRelationWithPropertyPath: (path: string) =>
        path === 'tenant' ? { joinColumns: [{ databaseName: 'tenantId' }] } : undefined,
    };
    usageRepo = createMockRepository();
    usageRepo.createQueryBuilder.mockImplementation(() =>
      createMockQueryBuilder(),
    );
    featureDefsRepo = createMockRepository();
    featurePlansRepo = createMockRepository();
    featureDefsRepo.find.mockResolvedValue([]);
    featurePlansRepo.find.mockResolvedValue([]);

    // Paid platform, and NO tenant-wide free-access override — this tenant's
    // access comes solely from the per-feature super-admin grant.
    billingMode = { isPaidMode: jest.fn().mockResolvedValue(true) };
    freeOverrides = {
      hasActive: jest.fn().mockResolvedValue(false),
      getActive: jest.fn().mockResolvedValue(null),
    };
    featureFlags = { getStates: jest.fn().mockResolvedValue(new Map()) };

    messaging = {
      send: jest
        .fn()
        .mockResolvedValue({ success: true, providerMessageId: 'wamid.free' }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappExecutionService,
        UsageService,
        AccessControlService,
        // Real policy, stubbed cache/mode: the cache always misses so every
        // assertion exercises a genuine resolution, and the mode is ENFORCE
        // (production default), so a denial really denies.
        { provide: AccessCacheService, useValue: createMockAccessCache() },
        {
          provide: AccessPolicyModeService,
          useValue: createMockAccessPolicyMode(),
        },
        { provide: getRepositoryToken(NotificationLog), useValue: logs },
        { provide: getRepositoryToken(WhatsappContact), useValue: contacts },
        { provide: getRepositoryToken(Customer), useValue: customers },
        {
          provide: getRepositoryToken(Subscription),
          useValue: subscriptionRepo,
        },
        { provide: getRepositoryToken(SubscriptionUsage), useValue: usageRepo },
        {
          provide: getRepositoryToken(FeatureDefinition),
          useValue: featureDefsRepo,
        },
        {
          provide: getRepositoryToken(FeaturePlan),
          useValue: featurePlansRepo,
        },
        { provide: BillingModeService, useValue: billingMode },
        { provide: FreeAccessOverrideService, useValue: freeOverrides },
        { provide: FeatureFlagService, useValue: featureFlags },
        {
          provide: TenantUsageLimitOverrideService,
          useValue: {
            getActive: jest.fn().mockResolvedValue(null),
            getActiveMap: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: TenantEntitlementLedgerService,
          useValue: { capacityMap: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: TenantMetricCreditsService,
          useValue: {
            tryDebit: jest.fn().mockResolvedValue(false),
            balanceMap: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: SystemSettingService,
          useValue: { getTyped: jest.fn().mockResolvedValue(5) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(14) },
        },
        {
          provide: WhatsappMessageRouter,
          useValue: { resolveForSend: jest.fn().mockResolvedValue(ACCOUNT) },
        },
        {
          provide: WhatsappTemplateService,
          useValue: {
            getSendableTemplate: jest.fn().mockResolvedValue(TEMPLATE),
          },
        },
        { provide: WhatsappMessagingService, useValue: messaging },
        { provide: QueueService, useValue: { enqueueWhatsappSend: jest.fn() } },
        { provide: TenantContextService, useValue: new TenantContextService() },
        {
          provide: SubscriptionService,
          useValue: { assertBillableActionAllowed: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(WhatsappExecutionService);
  }

  beforeEach(build);
  afterEach(() => jest.clearAllMocks());

  /**
   * T045 (015-db-api-efficiency-audit, P7-2): `UsageService
   * .findCurrentSubscriptionWithPlan` reads via `createQueryBuilder()
   * .getOne()`, not `findOne()` — primes BOTH mechanisms (AccessControlService,
   * built against this same repo, may have its own unaffected lookups) so
   * every pre-existing `subscriptionRepo.findOne.mockResolvedValue(...)` call
   * site keeps working regardless of which one actually gets invoked.
   */
  function mockSubscription(row: unknown) {
    subscriptionRepo.findOne.mockResolvedValue(row as never);
    const qb = createMockQueryBuilder();
    qb.getOne = jest.fn().mockResolvedValue(row);
    subscriptionRepo.createQueryBuilder.mockReturnValue(qb);
  }

  it('[1] sends successfully with NO subscription when the whatsapp feature is granted', async () => {
    mockSubscription(null); // free-access tenant: no subscription
    featureFlags.getStates.mockResolvedValue(grantOf(FeatureKey.WHATSAPP));

    const res = await service.sendTemplateMessage(TENANT, 'tpl-1', {
      toWaId: '966500000000',
    } as any);

    expect(res).toMatchObject({
      status: WHATSAPP_DELIVERY_STATUS.SENT,
      providerMessageId: 'wamid.free',
    });
    expect(messaging.send).toHaveBeenCalled();
  });

  it('[5] never surfaces "No active subscription found" on that path', async () => {
    mockSubscription(null);
    featureFlags.getStates.mockResolvedValue(grantOf(FeatureKey.WHATSAPP));

    await expect(
      service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any),
    ).resolves.toBeDefined();
  });

  /**
   * The refusal is the platform's standard access denial, NOT the
   * `404 No active subscription found for this tenant` this path used to raise
   * from `resolveSubscription()`. That response described the platform's own
   * billing internals to answer what is simply "you may not use WhatsApp", and
   * on public booking and guest chat it reached unauthenticated visitors.
   */
  it('[2] is DENIED with no subscription and no grant of any kind', async () => {
    mockSubscription(null);
    featureFlags.getStates.mockResolvedValue(new Map()); // nothing granted

    await expect(
      service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any),
    ).rejects.toMatchObject({ code: ErrorCode.NO_ACTIVE_SUBSCRIPTION });
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it('[4] a grant for an unrelated feature does not unlock WhatsApp', async () => {
    mockSubscription(null);
    // Only Payments is granted. Deliberately NOT Campaigns: campaigns DECLARE
    // whatsapp as a dependency, so granting campaigns is meant to open
    // whatsapp — a campaign that cannot send is not a granted campaign.
    featureFlags.getStates.mockResolvedValue(grantOf(FeatureKey.PAYMENTS));

    await expect(
      service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any),
    ).rejects.toMatchObject({ code: ErrorCode.NO_ACTIVE_SUBSCRIPTION });
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it('[3] a paid tenant keeps plan quota enforcement even with the feature flag on', async () => {
    mockSubscription({
      id: 'sub-1',
      status: 'ACTIVE',
      ends_at: new Date(Date.now() + 86_400_000),
      plan: { max_whatsapp_messages: 100 },
    });
    featureFlags.getStates.mockResolvedValue(grantOf(FeatureKey.WHATSAPP));
    // The atomic admission UPDATE (2nd query builder — the 1st is the
    // idempotent upsert) matches no row → monthly cap already exhausted.
    const insertQb = createMockQueryBuilder();
    const updateQb = createMockQueryBuilder();
    updateQb.execute.mockResolvedValueOnce({ affected: 0, raw: [] });
    usageRepo.createQueryBuilder
      .mockImplementationOnce(() => insertQb)
      .mockImplementationOnce(() => updateQb);
    usageRepo.findOne.mockResolvedValue({ whatsapp_messages_used: 100 });

    await expect(
      service.sendTemplateMessage(TENANT, 'tpl-1', {
        toWaId: '966500000000',
      } as any),
    ).rejects.toMatchObject({ code: ErrorCode.UNPROCESSABLE_ENTITY });
    expect(messaging.send).not.toHaveBeenCalled();
  });
});
