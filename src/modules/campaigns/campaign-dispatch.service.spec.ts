import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CampaignDispatchService } from './campaign-dispatch.service';
import { Campaign } from '../../entities/Campaigns/Campaign';
import { CampaignRun } from '../../entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../../entities/Campaigns/CampaignRecipient';
import { CampaignExecution, RecipientProcessing } from '../../entities/enums';
import { CampaignDeliveryFactory } from './delivery/campaign-delivery.factory';
import { TenantRateLimiterService } from '../../queue/tenant-rate-limiter.service';
import { QueueService } from '../../queue/queue.service';
import { TransientDispatchError } from './dispatch/dispatch-errors';
import { EmailSuppressionService } from '../email/email-suppression.service';
import { ReputationGuardService } from './reputation-guard.service';
import { AppError, ErrorCode } from '../../common/errors';
import {
  createMockRepository,
  createMockEntityManager,
  createMockDataSource,
  createMockQueryBuilder,
  MockRepository,
  MockDataSource,
  MockEntityManager,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const RUN = 'run-1';
const RECIPIENT = 'rec-1';

describe('CampaignDispatchService.dispatch', () => {
  let service: CampaignDispatchService;
  let recipients: MockRepository;
  let runs: MockRepository;
  let campaigns: MockRepository;
  let dataSource: MockDataSource;
  let manager: MockEntityManager;
  let delivery: { resolve: jest.Mock };
  let send: jest.Mock;
  let rateLimiter: { consume: jest.Mock };
  let queue: { enqueueCampaignDlq: jest.Mock };
  let emailSuppression: { isSuppressed: jest.Mock };
  let reputationGuard: { assertNotSuspended: jest.Mock };

  /** Make the atomic CLAIM update affect `n` rows. */
  const claimAffects = (n: number) => {
    const qb = createMockQueryBuilder();
    qb.execute.mockResolvedValue({ affected: n });
    recipients.createQueryBuilder.mockReturnValue(qb);
  };

  beforeEach(async () => {
    recipients = createMockRepository();
    runs = createMockRepository();
    campaigns = createMockRepository();
    manager = createMockEntityManager();
    dataSource = createMockDataSource(manager);
    send = jest.fn();
    delivery = { resolve: jest.fn().mockReturnValue({ send }) };
    rateLimiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
    queue = { enqueueCampaignDlq: jest.fn().mockResolvedValue(undefined) };
    emailSuppression = { isSuppressed: jest.fn().mockResolvedValue(false) };
    reputationGuard = {
      assertNotSuspended: jest.fn().mockResolvedValue(undefined),
    };

    claimAffects(1); // default: claim succeeds
    runs.findOne.mockResolvedValue({
      id: RUN,
      execution: CampaignExecution.PROCESSING,
    });
    recipients.findOne.mockResolvedValue({
      id: RECIPIENT,
      campaign: { id: 'camp-1', template: { id: 'tmpl-1' } },
      // A consenting, reachable customer — the precondition for any campaign
      // send (see the consent block for the non-consenting paths).
      customer: {
        id: 'cust-1',
        marketing_opt_in: true,
        is_active: true,
        phone: '+966500000000',
      },
    });
    campaigns.findOne.mockResolvedValue({
      id: 'camp-1',
      throttle_per_minute: 30,
      daily_cap: null,
      monthly_cap: null,
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignDispatchService,
        {
          provide: getRepositoryToken(CampaignRecipient),
          useValue: recipients,
        },
        { provide: getRepositoryToken(CampaignRun), useValue: runs },
        { provide: getRepositoryToken(Campaign), useValue: campaigns },
        { provide: CampaignDeliveryFactory, useValue: delivery },
        { provide: TenantRateLimiterService, useValue: rateLimiter },
        { provide: QueueService, useValue: queue },
        { provide: DataSource, useValue: dataSource },
        { provide: EmailSuppressionService, useValue: emailSuppression },
        { provide: ReputationGuardService, useValue: reputationGuard },
      ],
    }).compile();
    service = moduleRef.get(CampaignDispatchService);
  });

  afterEach(() => jest.clearAllMocks());

  it('no-ops when the recipient is already claimed/sent (CLAIM affects 0 rows)', async () => {
    claimAffects(0);
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toEqual({ status: 'noop', reason: 'already-claimed-or-sent' });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the run no longer exists', async () => {
    runs.findOne.mockResolvedValueOnce(null);
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'skipped', reason: 'run-missing' });
  });

  it('defers (never skips) and releases the claim when the run is DRAINING (paused)', async () => {
    runs.findOne.mockResolvedValueOnce({
      id: RUN,
      execution: CampaignExecution.DRAINING,
    });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'deferred' });
    // claim released back to PENDING
    expect(recipients.update).toHaveBeenCalledWith(
      expect.objectContaining({ processing: RecipientProcessing.DISPATCHING }),
      expect.objectContaining({ processing: RecipientProcessing.PENDING }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the run is terminal (COMPLETED)', async () => {
    runs.findOne.mockResolvedValueOnce({
      id: RUN,
      execution: CampaignExecution.COMPLETED,
    });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'skipped', reason: 'run-stopped' });
  });

  it('returns rate_limited (and releases the claim) on a RATE denial', async () => {
    rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      reason: 'RATE',
      retryAfterMs: 500,
    });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toEqual({ status: 'rate_limited', retryAfterMs: 500 });
    expect(recipients.update).toHaveBeenCalled(); // releaseClaim
    expect(send).not.toHaveBeenCalled();
  });

  it('skips on a daily-cap denial (terminal for the period)', async () => {
    rateLimiter.consume.mockResolvedValueOnce({
      allowed: false,
      reason: 'DAILY_CAP',
    });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'skipped', reason: 'daily-cap' });
  });

  it('dispatches and records the provider ref on success', async () => {
    send.mockResolvedValueOnce({ success: true, providerRef: 'wamid-1' });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toEqual({ status: 'dispatched', providerRef: 'wamid-1' });
    expect(manager.update).toHaveBeenCalled(); // markDispatched within a transaction
  });

  // FND-025/VER-017 (REQ-CAMP-006) — under NORMAL configuration this never
  // happens (WhatsappCampaignDeliveryProvider unconditionally supports the
  // hardcoded 'whatsapp' channel, so the noop fallback is unreachable in a
  // correctly-wired deployment — confirmed by reading campaigns.module.ts).
  // The gap is the missing SAFETY NET for when that assumption breaks (a
  // future misregistration, a new channel added with no real provider yet):
  // today, a noop-simulated send is recorded and completes a run
  // IDENTICALLY to a real one, with no distinguishing signal anywhere.
  it('[FND-025] a dispatch that resolves to the NOOP delivery provider is loudly flagged, not silently reported as a normal success', async () => {
    const errorSpy = jest.spyOn((service as any).logger, 'error');
    delivery.resolve.mockReturnValueOnce({ send, name: 'noop' });
    send.mockResolvedValueOnce({ success: true, providerRef: 'noop:rec-1' });

    const res = await service.dispatch(TENANT, RUN, RECIPIENT);

    // The simulated send still completes the recipient (a campaign run must
    // still be able to finish in dev/test, where noop is the expected,
    // legitimate path) — but it is NOT silent.
    expect(res).toEqual({ status: 'dispatched', providerRef: 'noop:rec-1' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('NOOP'));
  });

  it('a real WhatsApp dispatch (provider.name !== "noop") never logs the noop alert', async () => {
    const errorSpy = jest.spyOn((service as any).logger, 'error');
    delivery.resolve.mockReturnValueOnce({ send, name: 'whatsapp' });
    send.mockResolvedValueOnce({ success: true, providerRef: 'wamid-real-1' });

    await service.dispatch(TENANT, RUN, RECIPIENT);

    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('NOOP'));
  });

  describe('customer consent (WhatsApp marketing rules)', () => {
    /** Re-point the recipient at a customer with the given attributes. */
    const withCustomer = (customer: Record<string, unknown> | undefined) =>
      recipients.findOne.mockResolvedValue({
        id: RECIPIENT,
        campaign: { id: 'camp-1', template: { id: 'tmpl-1' } },
        customer,
      });

    it('does NOT send to a customer who has not opted in', async () => {
      withCustomer({
        id: 'cust-1',
        marketing_opt_in: false,
        is_active: true,
        phone: '+9665',
      });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({
        status: 'skipped',
        reason: 'no-marketing-consent',
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('treats a missing opt-in flag as NO consent (fails closed)', async () => {
      withCustomer({ id: 'cust-1', is_active: true, phone: '+9665' });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({
        status: 'skipped',
        reason: 'no-marketing-consent',
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('checks consent at SEND time, so an opt-out after launch is honoured', async () => {
      // The recipient was queued while consenting and revoked before its turn.
      withCustomer({
        id: 'cust-1',
        marketing_opt_in: false,
        is_active: true,
        phone: '+9665',
      });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(send).not.toHaveBeenCalled();
    });

    it('skips an inactive customer', async () => {
      withCustomer({
        id: 'cust-1',
        marketing_opt_in: true,
        is_active: false,
        phone: '+9665',
      });

      await expect(
        service.dispatch(TENANT, RUN, RECIPIENT),
      ).resolves.toMatchObject({
        status: 'skipped',
        reason: 'customer-inactive',
      });
    });

    it('skips a customer with no phone number', async () => {
      withCustomer({
        id: 'cust-1',
        marketing_opt_in: true,
        is_active: true,
        phone: '',
      });

      await expect(
        service.dispatch(TENANT, RUN, RECIPIENT),
      ).resolves.toMatchObject({
        status: 'skipped',
        reason: 'customer-has-no-phone',
      });
    });

    it('counts a non-consenting recipient as SKIPPED (terminal), so the run can complete', async () => {
      withCustomer({
        id: 'cust-1',
        marketing_opt_in: false,
        is_active: true,
        phone: '+9665',
      });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      // Not a failure and not a retry: declining to send is a correct outcome
      // that must settle the recipient, or the run's counters never sum.
      expect(manager.update).toHaveBeenCalled();
    });

    // ── FND-024 — RED: checkConsent() only ever reads marketing_opt_in. A
    // customer who opted IN at signup (marketing_opt_in stays true — nothing
    // flips it) and later replies "STOP" over WhatsApp has no way today to
    // stop campaign sends, because nothing records or checks that inbound
    // signal. (Placed here, not in campaign.service.spec.ts as tasks.md
    // names it — that file is pure Campaign CRUD with no dispatch/consent
    // logic; checkConsent() genuinely lives in campaign-dispatch.service.ts.)
    it('[FND-024] does NOT send to a customer who opted in but later opted out via an inbound message', async () => {
      withCustomer({
        id: 'cust-1',
        marketing_opt_in: true,
        is_active: true,
        phone: '+9665',
        opted_out_at: new Date('2026-01-01T00:00:00Z'),
      });
      // Stubbed so that, absent the fix, the call reaches a clean "sent"
      // outcome instead of crashing on an unrelated unstubbed mock — the
      // assertion below is what must fail, not an incidental TypeError.
      send.mockResolvedValueOnce({
        success: true,
        providerRef: 'wamid-should-never-be-sent',
      });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({ status: 'skipped' });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("sends from the campaign's own WhatsApp account when one is bound", async () => {
    campaigns.findOne.mockResolvedValueOnce({
      id: 'camp-1',
      throttle_per_minute: 30,
      daily_cap: null,
      monthly_cap: null,
      whatsapp_account: { id: 'acc-9' },
    });
    send.mockResolvedValueOnce({ success: true, providerRef: 'wamid-1' });

    await service.dispatch(TENANT, RUN, RECIPIENT);

    // A re-run must not silently switch identity because the tenant default moved.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-9' }),
    );
  });

  it('records a PERMANENT failure without retrying (no throw)', async () => {
    send.mockResolvedValueOnce({
      success: false,
      transient: false,
      error: 'invalid number',
    });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({
      status: 'failed_permanent',
      reason: 'invalid number',
    });
  });

  it('resets to PENDING and throws TransientDispatchError on a transient failure (→ BullMQ retry)', async () => {
    send.mockResolvedValueOnce({
      success: false,
      transient: true,
      error: 'timeout',
    });
    await expect(
      service.dispatch(TENANT, RUN, RECIPIENT),
    ).rejects.toBeInstanceOf(TransientDispatchError);
    expect(recipients.update).toHaveBeenCalledWith(
      { id: RECIPIENT },
      expect.objectContaining({ processing: RecipientProcessing.PENDING }),
    );
  });

  it('markDeadLettered reconciles a poison recipient to terminal FAILED + completion', async () => {
    await expect(
      service.markDeadLettered(RUN, RECIPIENT, 'exhausted'),
    ).resolves.toBeUndefined();
    expect(manager.update).toHaveBeenCalled(); // terminal FAILED transition
  });

  // ─────────────────────── FND-020: DLQ write reliability ─────────────────── //
  describe('FND-020 — dead-letter write reliability', () => {
    it('markDeadLettered, given a dlqContext, also records the DLQ entry and stamps dlq_recorded_at', async () => {
      await service.markDeadLettered(RUN, RECIPIENT, 'exhausted', {
        tenantId: TENANT,
        correlationId: 'cid-1',
        attemptsMade: 5,
      });

      expect(queue.enqueueCampaignDlq).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          correlationId: 'cid-1',
          originalJobId: RECIPIENT,
          failedReason: 'exhausted',
          attemptsMade: 5,
        }),
      );
      expect(recipients.update).toHaveBeenCalledWith(
        RECIPIENT,
        expect.objectContaining({ dlq_recorded_at: expect.any(Date) }),
      );
    });

    it('markDeadLettered with no dlqContext skips the DLQ write entirely (internal/system callers unaffected)', async () => {
      await service.markDeadLettered(RUN, RECIPIENT, 'exhausted');
      expect(queue.enqueueCampaignDlq).not.toHaveBeenCalled();
    });

    it('a DLQ enqueue failure is swallowed (logged), never thrown back to the caller', async () => {
      queue.enqueueCampaignDlq.mockRejectedValueOnce(new Error('redis down'));
      await expect(
        service.markDeadLettered(RUN, RECIPIENT, 'exhausted', {
          tenantId: TENANT,
        }),
      ).resolves.toBeUndefined();
      expect(recipients.update).not.toHaveBeenCalledWith(
        RECIPIENT,
        expect.objectContaining({ dlq_recorded_at: expect.anything() }),
      );
    });

    describe('recoverDeadLetters — the recovery sweep', () => {
      it('re-attempts the DLQ write for every stranded recipient (dead-lettered, never confirmed in the DLQ)', async () => {
        recipients.find.mockResolvedValueOnce([
          {
            id: 'rec-a',
            failure_reason: 'boom-a',
            attempts: 3,
            run: { id: 'run-a', tenant: { id: 'tenant-a' } },
          },
          {
            id: 'rec-b',
            failure_reason: 'boom-b',
            attempts: 1,
            run: { id: 'run-b', tenant: { id: 'tenant-b' } },
          },
        ]);

        const result = await service.recoverDeadLetters();

        expect(queue.enqueueCampaignDlq).toHaveBeenCalledTimes(2);
        expect(queue.enqueueCampaignDlq).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'tenant-a',
            originalJobId: 'rec-a',
            failedReason: 'boom-a',
          }),
        );
        expect(queue.enqueueCampaignDlq).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'tenant-b',
            originalJobId: 'rec-b',
            failedReason: 'boom-b',
          }),
        );
        expect(recipients.update).toHaveBeenCalledWith(
          'rec-a',
          expect.objectContaining({ dlq_recorded_at: expect.any(Date) }),
        );
        expect(recipients.update).toHaveBeenCalledWith(
          'rec-b',
          expect.objectContaining({ dlq_recorded_at: expect.any(Date) }),
        );
        expect(result).toEqual({ recovered: 2, attempted: 2 });
      });

      it('only queries recipients with failure_class=TRANSIENT and dlq_recorded_at IS NULL', async () => {
        recipients.find.mockResolvedValueOnce([]);
        await service.recoverDeadLetters();
        expect(recipients.find).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              failure_class: 'TRANSIENT',
              dlq_recorded_at: expect.anything(), // IsNull() FindOperator
            }),
          }),
        );
      });

      it('reports a partial recovery count when some re-attempts still fail', async () => {
        recipients.find.mockResolvedValueOnce([
          {
            id: 'rec-a',
            failure_reason: 'x',
            attempts: 1,
            run: { id: 'run-a', tenant: { id: 't-a' } },
          },
          {
            id: 'rec-b',
            failure_reason: 'x',
            attempts: 1,
            run: { id: 'run-b', tenant: { id: 't-b' } },
          },
        ]);
        queue.enqueueCampaignDlq
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('still down'));

        const result = await service.recoverDeadLetters();
        expect(result).toEqual({ recovered: 1, attempted: 2 });
      });

      it('is a harmless no-op when nothing is stranded', async () => {
        recipients.find.mockResolvedValueOnce([]);
        await expect(service.recoverDeadLetters()).resolves.toEqual({
          recovered: 0,
          attempted: 0,
        });
      });
    });
  });

  // ─────────────────────── Phase 11 (US7) — EMAIL channel ─────────────────── //
  describe('Phase 11 (US7) — EMAIL channel dispatch', () => {
    const withEmailQueryBuilder = (getCount = 0) => {
      const qb = createMockQueryBuilder();
      qb.execute.mockResolvedValue({ affected: 1 }); // CLAIM succeeds
      qb.getCount.mockResolvedValue(getCount); // dedupe check
      recipients.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };
    const withEmailCustomer = (overrides: Record<string, unknown> = {}) =>
      recipients.findOne.mockResolvedValue({
        id: RECIPIENT,
        campaign: { id: 'camp-1', template: null },
        customer: {
          id: 'cust-1',
          marketing_opt_in: true,
          is_active: true,
          email: 'patient@example.com',
          ...overrides,
        },
      });

    beforeEach(() => {
      campaigns.findOne.mockResolvedValue({
        id: 'camp-1',
        channel: 'EMAIL',
        email_subject: 'Sale',
        email_body: 'Big news',
        throttle_per_minute: 30,
        daily_cap: null,
        monthly_cap: null,
      });
    });

    it('T131: resolves the EMAIL provider (never falls through to a hardcoded WHATSAPP channel)', async () => {
      withEmailQueryBuilder();
      withEmailCustomer();
      send.mockResolvedValueOnce({ success: true, providerRef: 'resend-1' });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(delivery.resolve).toHaveBeenCalledWith('EMAIL');
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'EMAIL',
          email: 'patient@example.com',
        }),
      );
    });

    it('T131 [CRITICAL]: an EMAIL campaign whose resolved provider is the noop fallback FAILS LOUDLY — never a silent success', async () => {
      withEmailQueryBuilder();
      withEmailCustomer();
      const errorSpy = jest.spyOn((service as any).logger, 'error');
      // Simulates the email provider being unregistered from CAMPAIGN_DELIVERY_PROVIDERS.
      delivery.resolve.mockReturnValueOnce({ send, name: 'noop' });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({ status: 'failed_permanent' });
      expect(send).not.toHaveBeenCalled(); // never even attempts the simulated send
      expect(manager.update).toHaveBeenCalled(); // recipient marked terminally FAILED
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('no delivery provider'),
      );
      // The RUN itself is failed, not just the recipient — reports zero delivered.
      expect(runs.createQueryBuilder).toHaveBeenCalled();
    });

    it('T133/FR-E009: an EMAIL recipient on the suppression list is skipped, never sent', async () => {
      withEmailQueryBuilder();
      withEmailCustomer();
      emailSuppression.isSuppressed.mockResolvedValueOnce(true);

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({
        status: 'skipped',
        reason: 'email-suppressed',
      });
      expect(send).not.toHaveBeenCalled();
      expect(emailSuppression.isSuppressed).toHaveBeenCalledWith(
        TENANT,
        'patient@example.com',
      );
    });

    it('FR-E013: a duplicate address already dispatched earlier in the SAME run is skipped', async () => {
      withEmailQueryBuilder(1); // getCount() finds one already-DISPATCHED duplicate
      withEmailCustomer();

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({
        status: 'skipped',
        reason: 'duplicate-email-in-run',
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('T135/FR-E019: a reputation-suspended tenant is skipped, not sent (and not a hard failure)', async () => {
      withEmailQueryBuilder();
      withEmailCustomer();
      reputationGuard.assertNotSuspended.mockRejectedValueOnce(
        new AppError(ErrorCode.UNPROCESSABLE_ENTITY, { message: 'suspended' }),
      );

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({
        status: 'skipped',
        reason: 'marketing-sending-suspended',
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('skips a customer with no email address (channel-appropriate consent gate)', async () => {
      withEmailQueryBuilder();
      withEmailCustomer({ email: undefined });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({
        status: 'skipped',
        reason: 'customer-has-no-email',
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('a WHATSAPP recipient is never subjected to the email suppression/dedupe/reputation gates', async () => {
      // Default campaigns.findOne (WHATSAPP, from the outer beforeEach chain via
      // recipients.findOne default) — override back to a WhatsApp campaign here.
      campaigns.findOne.mockResolvedValue({
        id: 'camp-1',
        channel: 'WHATSAPP',
        throttle_per_minute: 30,
        daily_cap: null,
        monthly_cap: null,
      });
      claimAffects(1);
      recipients.findOne.mockResolvedValue({
        id: RECIPIENT,
        campaign: { id: 'camp-1', template: { id: 'tmpl-1' } },
        customer: {
          id: 'cust-1',
          marketing_opt_in: true,
          is_active: true,
          phone: '+9665',
        },
      });
      send.mockResolvedValueOnce({ success: true, providerRef: 'wamid-1' });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(emailSuppression.isSuppressed).not.toHaveBeenCalled();
      expect(reputationGuard.assertNotSuspended).not.toHaveBeenCalled();
    });

    it('populates campaign_recipients.email with the resolved address on successful dispatch (T138)', async () => {
      withEmailQueryBuilder();
      withEmailCustomer();
      send.mockResolvedValueOnce({ success: true, providerRef: 'resend-1' });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: RECIPIENT }),
        expect.objectContaining({ email: 'patient@example.com' }),
      );
    });

    it('T137: never calls a plan-limit-style enforcement function for email — only the existing throttle/cap rate limiter', async () => {
      withEmailQueryBuilder();
      withEmailCustomer();
      send.mockResolvedValueOnce({ success: true, providerRef: 'resend-1' });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      // The ONLY volume control exercised is the existing per-tenant rate
      // limiter (already wired for every channel) — no separate usage-quota
      // assertion is ever invoked from this path.
      expect(rateLimiter.consume).toHaveBeenCalledWith(
        TENANT,
        'camp-1',
        expect.objectContaining({ ratePerMinute: 30 }),
      );
    });
  });
});
