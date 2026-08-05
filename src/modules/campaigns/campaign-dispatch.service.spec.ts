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

    claimAffects(1); // default: claim succeeds
    runs.findOne.mockResolvedValue({ id: RUN, execution: CampaignExecution.PROCESSING });
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
        { provide: getRepositoryToken(CampaignRecipient), useValue: recipients },
        { provide: getRepositoryToken(CampaignRun), useValue: runs },
        { provide: getRepositoryToken(Campaign), useValue: campaigns },
        { provide: CampaignDeliveryFactory, useValue: delivery },
        { provide: TenantRateLimiterService, useValue: rateLimiter },
        { provide: QueueService, useValue: queue },
        { provide: DataSource, useValue: dataSource },
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
    runs.findOne.mockResolvedValueOnce({ id: RUN, execution: CampaignExecution.DRAINING });
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
    runs.findOne.mockResolvedValueOnce({ id: RUN, execution: CampaignExecution.COMPLETED });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'skipped', reason: 'run-stopped' });
  });

  it('returns rate_limited (and releases the claim) on a RATE denial', async () => {
    rateLimiter.consume.mockResolvedValueOnce({ allowed: false, reason: 'RATE', retryAfterMs: 500 });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toEqual({ status: 'rate_limited', retryAfterMs: 500 });
    expect(recipients.update).toHaveBeenCalled(); // releaseClaim
    expect(send).not.toHaveBeenCalled();
  });

  it('skips on a daily-cap denial (terminal for the period)', async () => {
    rateLimiter.consume.mockResolvedValueOnce({ allowed: false, reason: 'DAILY_CAP' });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'skipped', reason: 'daily-cap' });
  });

  it('dispatches and records the provider ref on success', async () => {
    send.mockResolvedValueOnce({ success: true, providerRef: 'wamid-1' });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toEqual({ status: 'dispatched', providerRef: 'wamid-1' });
    expect(manager.update).toHaveBeenCalled(); // markDispatched within a transaction
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
      withCustomer({ id: 'cust-1', marketing_opt_in: false, is_active: true, phone: '+9665' });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({ status: 'skipped', reason: 'no-marketing-consent' });
      expect(send).not.toHaveBeenCalled();
    });

    it('treats a missing opt-in flag as NO consent (fails closed)', async () => {
      withCustomer({ id: 'cust-1', is_active: true, phone: '+9665' });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({ status: 'skipped', reason: 'no-marketing-consent' });
      expect(send).not.toHaveBeenCalled();
    });

    it('checks consent at SEND time, so an opt-out after launch is honoured', async () => {
      // The recipient was queued while consenting and revoked before its turn.
      withCustomer({ id: 'cust-1', marketing_opt_in: false, is_active: true, phone: '+9665' });

      await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(send).not.toHaveBeenCalled();
    });

    it('skips an inactive customer', async () => {
      withCustomer({ id: 'cust-1', marketing_opt_in: true, is_active: false, phone: '+9665' });

      await expect(service.dispatch(TENANT, RUN, RECIPIENT)).resolves.toMatchObject({
        status: 'skipped',
        reason: 'customer-inactive',
      });
    });

    it('skips a customer with no phone number', async () => {
      withCustomer({ id: 'cust-1', marketing_opt_in: true, is_active: true, phone: '' });

      await expect(service.dispatch(TENANT, RUN, RECIPIENT)).resolves.toMatchObject({
        status: 'skipped',
        reason: 'customer-has-no-phone',
      });
    });

    it('counts a non-consenting recipient as SKIPPED (terminal), so the run can complete', async () => {
      withCustomer({ id: 'cust-1', marketing_opt_in: false, is_active: true, phone: '+9665' });

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
      send.mockResolvedValueOnce({ success: true, providerRef: 'wamid-should-never-be-sent' });

      const res = await service.dispatch(TENANT, RUN, RECIPIENT);

      expect(res).toMatchObject({ status: 'skipped' });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('sends from the campaign\'s own WhatsApp account when one is bound', async () => {
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
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-9' }));
  });

  it('records a PERMANENT failure without retrying (no throw)', async () => {
    send.mockResolvedValueOnce({ success: false, transient: false, error: 'invalid number' });
    const res = await service.dispatch(TENANT, RUN, RECIPIENT);
    expect(res).toMatchObject({ status: 'failed_permanent', reason: 'invalid number' });
  });

  it('resets to PENDING and throws TransientDispatchError on a transient failure (→ BullMQ retry)', async () => {
    send.mockResolvedValueOnce({ success: false, transient: true, error: 'timeout' });
    await expect(service.dispatch(TENANT, RUN, RECIPIENT)).rejects.toBeInstanceOf(
      TransientDispatchError,
    );
    expect(recipients.update).toHaveBeenCalledWith(
      { id: RECIPIENT },
      expect.objectContaining({ processing: RecipientProcessing.PENDING }),
    );
  });

  it('markDeadLettered reconciles a poison recipient to terminal FAILED + completion', async () => {
    await expect(service.markDeadLettered(RUN, RECIPIENT, 'exhausted')).resolves.toBeUndefined();
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
        service.markDeadLettered(RUN, RECIPIENT, 'exhausted', { tenantId: TENANT }),
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
          expect.objectContaining({ tenantId: 'tenant-a', originalJobId: 'rec-a', failedReason: 'boom-a' }),
        );
        expect(queue.enqueueCampaignDlq).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenant-b', originalJobId: 'rec-b', failedReason: 'boom-b' }),
        );
        expect(recipients.update).toHaveBeenCalledWith('rec-a', expect.objectContaining({ dlq_recorded_at: expect.any(Date) }));
        expect(recipients.update).toHaveBeenCalledWith('rec-b', expect.objectContaining({ dlq_recorded_at: expect.any(Date) }));
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
          { id: 'rec-a', failure_reason: 'x', attempts: 1, run: { id: 'run-a', tenant: { id: 't-a' } } },
          { id: 'rec-b', failure_reason: 'x', attempts: 1, run: { id: 'run-b', tenant: { id: 't-b' } } },
        ]);
        queue.enqueueCampaignDlq
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('still down'));

        const result = await service.recoverDeadLetters();
        expect(result).toEqual({ recovered: 1, attempted: 2 });
      });

      it('is a harmless no-op when nothing is stranded', async () => {
        recipients.find.mockResolvedValueOnce([]);
        await expect(service.recoverDeadLetters()).resolves.toEqual({ recovered: 0, attempted: 0 });
      });
    });
  });
});
