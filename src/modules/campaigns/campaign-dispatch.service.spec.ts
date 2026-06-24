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

    claimAffects(1); // default: claim succeeds
    runs.findOne.mockResolvedValue({ id: RUN, execution: CampaignExecution.PROCESSING });
    recipients.findOne.mockResolvedValue({
      id: RECIPIENT,
      campaign: { id: 'camp-1', template: { id: 'tmpl-1' } },
      customer: { id: 'cust-1' },
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
});
